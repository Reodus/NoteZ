//! Latin runs inside right-to-left text. The Unicode bidi algorithm gives
//! neutral characters at the end of a Latin run the paragraph's direction,
//! so in Persian text `read()` shows as `()read` and `C++` as `++C`. When a
//! run ends in such characters that belong to it (closing brackets that
//! close something in the run, or `+ # %` stuck to it), a left-to-right
//! mark after the run keeps them with it. Sentence punctuation (. ! ? :)
//! after the run still follows the Persian sentence.
//! The editor applies the same rule (src/editor/bidi.ts).

const LRM: char = '\u{200E}';

/// Arabic-script letters (Persian, Arabic, Urdu …).
pub fn is_rtl_char(c: char) -> bool {
    matches!(c, '\u{0590}'..='\u{08FF}' | '\u{FB1D}'..='\u{FDFF}' | '\u{FE70}'..='\u{FEFF}')
}

fn latin(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn run_char(c: char) -> bool {
    latin(c) || c == ' ' || "_.,:;'\"!?+-*/=<>@#$%&|~^\\(){}[]".contains(c)
}

/// Byte ranges of Latin runs whose trailing neutral characters belong to them.
pub fn runs_needing_mark(s: &str) -> Vec<(usize, usize)> {
    let cs: Vec<(usize, char)> = s.char_indices().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        if !cs[i].1.is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        while j < cs.len() && run_char(cs[j].1) {
            j += 1;
        }
        // Trim what does not belong to the run.
        let mut end = j;
        while end > start {
            let c = cs[end - 1].1;
            if latin(c) {
                break;
            }
            let closes = |o: char, cl: char| {
                let run = &cs[start..end];
                let opens = run.iter().filter(|x| x.1 == o).count();
                let closes = run.iter().filter(|x| x.1 == cl).count();
                opens >= closes
            };
            let keep = match c {
                ')' => closes('(', ')'),
                ']' => closes('[', ']'),
                '}' => closes('{', '}'),
                '+' | '#' | '%' => cs[end - 2].1 != ' ',
                _ => false,
            };
            if keep {
                break;
            }
            end -= 1;
        }
        if end > start && !latin(cs[end - 1].1) {
            let to = if end < cs.len() { cs[end].0 } else { s.len() };
            out.push((cs[start].0, to));
        }
        i = j.max(i + 1);
    }
    out
}

/// `s` with a left-to-right mark after each run that needs one.
pub fn mark_runs(s: &str) -> String {
    let runs = runs_needing_mark(s);
    if runs.is_empty() {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + runs.len() * 3);
    let mut last = 0;
    for (_, e) in runs {
        out.push_str(&s[last..e]);
        out.push(LRM);
        last = e;
    }
    out.push_str(&s[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marked(s: &str) -> Vec<&str> {
        runs_needing_mark(s).into_iter().map(|(a, b)| &s[a..b]).collect()
    }

    #[test]
    fn trailing_brackets_and_symbols() {
        assert_eq!(marked("سلام امیر چطوری read()"), ["read()"]);
        assert_eq!(marked("با C++ و Node.js کار می‌کنم؟"), ["C++"]);
        assert_eq!(marked("زبان C# و 50% پیشرفت"), ["C#", "50%"]);
        assert_eq!(marked("تابع foo(x) را صدا بزن."), ["foo(x)"]);
        assert_eq!(marked("آرایه arr[0] را ببین"), ["arr[0]"]);
    }

    #[test]
    fn sentence_punctuation_stays_outside() {
        assert!(marked("فایل config.json را باز کن.").is_empty());
        assert!(marked("این read است!").is_empty());
        assert!(marked("نسخه v1.2 (بتا) آمده").is_empty());
        assert!(marked("(read) را ببین").is_empty(), "unbalanced closer is not the run's");
    }

    #[test]
    fn mark_is_inserted() {
        assert_eq!(mark_runs("چطوری read()?"), "چطوری read()\u{200E}?");
        assert_eq!(mark_runs("بدون لاتین"), "بدون لاتین");
    }
}
