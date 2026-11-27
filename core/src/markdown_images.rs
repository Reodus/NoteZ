//! NoteZ accepts literal spaces in bare local image destinations.
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use regex::Regex;
use std::{ops::Range, sync::LazyLock};

static SPACED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"!(?:\[(?:\\[^\r\n]|[^\[\]\\\r\n])*\])\( *(?<path>[^<\s"'():]+(?: +[^<\s"'():]+)+)(?: +(?:"[^"\r\n]*"|'[^'\r\n]*'))? *\)"#).unwrap()
});

pub(crate) struct Image {
    pub source: Range<usize>,
    pub destination: Range<usize>,
    pub angle: bool,
    spaced: bool,
}

fn inline_destination(raw: &str) -> Option<(Range<usize>, bool)> {
    let mut depth = 0;
    let mut escaped = false;
    let mut destination = None;
    for (i, ch) in raw.char_indices().skip(1) {
        if std::mem::take(&mut escaped) { continue; }
        match ch {
            '\\' => escaped = true,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    destination = raw.get(i + 1..)?.strip_prefix('(');
                    break;
                }
            }
            _ => {}
        }
    }
    let tail = destination?.trim_start();
    let start = raw.len() - tail.len();
    if let Some(tail) = tail.strip_prefix('<') {
        return Some((start + 1..start + 1 + tail.find('>')?, true));
    }
    let mut depth = 0;
    let mut escaped = false;
    let end = tail.char_indices().find_map(|(i, ch)| {
        if std::mem::take(&mut escaped) { return None; }
        match ch {
            '\\' => escaped = true,
            '(' => depth += 1,
            ')' if depth == 0 => return Some(i),
            ')' => depth -= 1,
            ch if ch.is_whitespace() => return Some(i),
            _ => {}
        }
        None
    })?;
    Some((start..start + end, false))
}

pub(crate) fn scan(text: &str) -> Vec<Image> {
    if !text.contains("![") { return Vec::new(); }
    let mut protected = Vec::new();
    let mut images = Vec::new();
    let options = Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_MATH;
    for (event, range) in Parser::new_ext(text, options).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_) | Tag::HtmlBlock)
            | Event::Code(_) | Event::InlineMath(_) | Event::DisplayMath(_) | Event::InlineHtml(_) => protected.push(range),
            Event::Start(Tag::Image { link_type: LinkType::Inline, .. }) => {
                if let Some((dest, angle)) = inline_destination(&text[range.clone()]) {
                    images.push(Image { destination: range.start + dest.start..range.start + dest.end, source: range.clone(), angle, spaced: false });
                }
                protected.push(range);
            }
            _ => {}
        }
    }
    let mut protection = 0;
    protected.sort_unstable_by_key(|r| r.start);
    for m in SPACED.captures_iter(text) {
        let source = m.get(0).unwrap().range();
        while protected.get(protection).is_some_and(|r| r.end <= source.start) {
            protection += 1;
        }
        if protected.get(protection).is_some_and(|r| r.start < source.end) { continue; }
        if text[..source.start].bytes().rev().take_while(|&b| b == b'\\').count() % 2 != 0 { continue; }
        images.push(Image { source, destination: m.name("path").unwrap().range(), angle: false, spaced: true });
    }
    images.sort_unstable_by_key(|image| image.source.start);
    images
}

pub(crate) fn normalize(text: String) -> String {
    if !SPACED.is_match(&text) { return text; }
    let images = scan(&text);
    if !images.iter().any(|image| image.spaced) { return text; }
    let mut normalized = String::with_capacity(text.len());
    let mut start = 0;
    for image in images.into_iter().filter(|image| image.spaced) {
        let path = image.destination;
        normalized.push_str(&text[start..path.start]);
        normalized.push_str(&text[path.clone()].replace(' ', "%20"));
        start = path.end;
    }
    normalized.push_str(&text[start..]);
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_only_bare_spaced_images_outside_code() {
        let text = "![](assets/عکس تیم.png) ![x](two spaces.svg \"title\") ![](<bracket space.png>) ![](old%20style.png)\n\n[x](ordinary link.md) `![](code image.png)` \\![](escaped image.png)\n\n```md\n![](fenced image.png)\n```\n\n    ![](indented image.png)\n";
        let expected = text.replace("عکس تیم", "عکس%20تیم").replace("two spaces", "two%20spaces");
        assert_eq!(normalize(text.to_string()), expected);
    }
}
