//! Compile a prepared world to SVG pages (live preview) or PDF (export), and
//! turn Typst diagnostics into editor-friendly line/column positions.

use serde::Serialize;
use std::time::Instant;
use typst::WorldExt;
use typst::diag::{Severity, SourceDiagnostic};
use typst::layout::Abs;
use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;
use typst_svg::SvgOptions;

use super::world::NoteWorld;

/// Maps generated Typst lines back to lines of the user's note.
#[derive(Default, Clone)]
pub struct SourceMap {
    /// Lines of generated prelude before the user's content starts.
    pub prelude_lines: usize,
    /// For Markdown: (generated line, note line) checkpoints, ascending.
    /// Empty means 1:1 after the prelude (Typst notes).
    pub checkpoints: Vec<(usize, usize)>,
}

impl SourceMap {
    /// 0-based generated line → 0-based note line (None = inside the prelude).
    pub fn map(&self, line: usize) -> Option<usize> {
        if self.checkpoints.is_empty() {
            return line.checked_sub(self.prelude_lines);
        }
        let idx = self.checkpoints.partition_point(|&(g, _)| g <= line);
        if idx == 0 { None } else { Some(self.checkpoints[idx - 1].1) }
    }
}

#[derive(Serialize, Clone)]
pub struct Diagnostic {
    pub severity: &'static str,
    pub message: String,
    pub hints: Vec<String>,
    /// 1-based line in the note, if the problem is located there.
    pub line: Option<usize>,
    pub column: Option<usize>,
    /// Set when the problem is in another file (package, include, prelude).
    pub file: Option<String>,
}

#[cfg(test)]
pub struct Preview {
    pub pages: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
}

fn convert(world: &NoteWorld, map: &SourceMap, diags: &[SourceDiagnostic]) -> Vec<Diagnostic> {
    diags
        .iter()
        .map(|d| {
            let mut line = None;
            let mut column = None;
            let mut file = None;
            if let Some(id) = d.span.id() {
                if id == typst::World::main(world) {
                    if let (Some(range), Ok(src)) = (world.range(d.span), world.main_source()) {
                        if let Some((l, c)) = src.lines().byte_to_line_column(range.start) {
                            match map.map(l) {
                                Some(ml) => {
                                    line = Some(ml + 1);
                                    column = map.checkpoints.is_empty().then_some(c + 1);
                                }
                                None => file = Some("(style prelude)".into()),
                            }
                        }
                    }
                } else {
                    file = Some(format!("{:?}", id.vpath()));
                }
            }
            Diagnostic {
                severity: match d.severity {
                    Severity::Error => "error",
                    Severity::Warning => "warning",
                },
                message: d.message.to_string(),
                hints: d.hints.iter().map(|h| h.v.to_string()).collect(),
                line,
                column,
                file,
            }
        })
        .collect()
}

fn compile_doc(world: &NoteWorld, map: &SourceMap) -> (Option<PagedDocument>, Vec<Diagnostic>) {
    let warned = typst::compile::<PagedDocument>(world);
    let mut diags = convert(world, map, &warned.warnings);
    match warned.output {
        Ok(doc) => (Some(doc), diags),
        Err(errors) => {
            let mut errs = convert(world, map, &errors);
            errs.append(&mut diags);
            (None, errs)
        }
    }
}

/// Every page as SVG (tests).
#[cfg(test)]
pub fn preview(world: &NoteWorld, map: &SourceMap) -> Preview {
    let d = preview_diff(world, map, &[]);
    Preview { pages: d.pages.into_iter().flatten().collect(), diagnostics: d.diagnostics }
}

/// A preview that only carries pages the UI doesn't have yet.
#[derive(Serialize)]
pub struct PreviewDiff {
    /// SVG of each page, or `None` when its hash is in `known`.
    pub pages: Vec<Option<String>>,
    /// Content hash of every page, to send back as `known` next time.
    pub hashes: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub millis: u128,
}

/// Like [`preview`], but pages whose content hash the caller already has are
/// not sent: a long note's SVG runs to megabytes, and
/// typing usually changes one or two pages.
pub fn preview_diff(world: &NoteWorld, map: &SourceMap, known: &[String]) -> PreviewDiff {
    let start = Instant::now();
    let (doc, diagnostics) = compile_doc(world, map);
    let opts = SvgOptions::default();
    let mut pages = vec![];
    let mut hashes = vec![];
    if let Some(d) = doc {
        for p in d.pages() {
            // Hash the SVG, not the page: a page's frames carry source spans,
            // which change with any edit before them.
            let svg = typst_svg::svg(p, &opts);
            let h = format!("{:032x}", typst::utils::hash128(&svg));
            pages.push(if known.contains(&h) { None } else { Some(svg) });
            hashes.push(h);
        }
    }
    PreviewDiff { pages, hashes, diagnostics, millis: start.elapsed().as_millis() }
}

/// The first page as SVG (theme thumbnails).
pub fn first_page_svg(world: &NoteWorld) -> Result<String, String> {
    let (doc, diags) = compile_doc(world, &SourceMap::default());
    match doc.as_ref().and_then(|d| d.pages().first()) {
        Some(p) => Ok(typst_svg::svg(p, &SvgOptions::default())),
        None => Err(diags.iter().map(|d| d.message.clone()).collect::<Vec<_>>().join("\n")),
    }
}

/// Render the whole document as one SVG (used for small snippets, e.g. the
/// inline diagram widgets in the editor).
pub fn snippet_svg(world: &NoteWorld) -> Result<String, String> {
    let (doc, diags) = compile_doc(world, &SourceMap::default());
    match doc {
        Some(d) => Ok(typst_svg::svg_merged(&d, &SvgOptions::default(), Abs::pt(0.0))),
        None => Err(diags
            .iter()
            .filter(|d| d.severity == "error")
            .map(|d| d.message.clone())
            .collect::<Vec<_>>()
            .join("\n")),
    }
}

pub fn pdf(world: &NoteWorld, map: &SourceMap) -> Result<Vec<u8>, Vec<Diagnostic>> {
    let (doc, diags) = compile_doc(world, map);
    let doc = doc.ok_or(diags)?;
    typst_pdf::pdf(&doc, &PdfOptions::default()).map_err(|errs| convert(world, map, &errs))
}
