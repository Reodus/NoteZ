//! Writing systems: which script a character belongs to, the language a text
//! is most likely written in, which languages run right-to-left, the digit
//! systems used for numbering, and the bundled fallback fonts per script.
//! Everything language-specific in the renderer goes through here, so NoteZ
//! treats Arabic, Hindi or Japanese notes as well as Persian or English ones.

/// A writing system, as far as typesetting cares.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum Script {
    Latin,
    Greek,
    Cyrillic,
    Armenian,
    Georgian,
    Arabic,
    Syriac,
    Thaana,
    Nko,
    Devanagari,
    Bengali,
    Gurmukhi,
    Gujarati,
    Oriya,
    Tamil,
    Telugu,
    Kannada,
    Malayalam,
    Sinhala,
    Thai,
    Lao,
    Tibetan,
    Myanmar,
    Khmer,
    Ethiopic,
    Cherokee,
    Mongolian,
    Hangul,
    Kana,
    Han,
}

/// Script of a letter (or mark); `None` for digits, punctuation, symbols, spaces.
pub fn script_of(c: char) -> Option<Script> {
    use Script::*;
    let u = c as u32;
    Some(match u {
        0x41..=0x5A | 0x61..=0x7A | 0xAA | 0xBA | 0xC0..=0xD6 | 0xD8..=0xF6 | 0xF8..=0x24F | 0x1E00..=0x1EFF
        | 0x2C60..=0x2C7F | 0xA720..=0xA7FF | 0xAB30..=0xAB6F | 0xFF21..=0xFF3A | 0xFF41..=0xFF5A => Latin,
        0x370..=0x3FF | 0x1F00..=0x1FFF => Greek,
        0x400..=0x52F | 0x1C80..=0x1C8F | 0x2DE0..=0x2DFF | 0xA640..=0xA69F => Cyrillic,
        0x530..=0x58F | 0xFB13..=0xFB17 => Armenian,
        0x10A0..=0x10FF | 0x1C90..=0x1CBF | 0x2D00..=0x2D2F => Georgian,
        0x600..=0x6FF | 0x750..=0x77F | 0x870..=0x8FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF => Arabic,
        0x700..=0x74F | 0x860..=0x86F => Syriac,
        0x780..=0x7BF => Thaana,
        0x7C0..=0x7FF => Nko,
        0x900..=0x97F | 0xA8E0..=0xA8FF => Devanagari,
        0x980..=0x9FF => Bengali,
        0xA00..=0xA7F => Gurmukhi,
        0xA80..=0xAFF => Gujarati,
        0xB00..=0xB7F => Oriya,
        0xB80..=0xBFF => Tamil,
        0xC00..=0xC7F => Telugu,
        0xC80..=0xCFF => Kannada,
        0xD00..=0xD7F => Malayalam,
        0xD80..=0xDFF => Sinhala,
        0xE00..=0xE7F => Thai,
        0xE80..=0xEFF => Lao,
        0xF00..=0xFFF => Tibetan,
        0x1000..=0x109F | 0xAA60..=0xAA7F => Myanmar,
        0x1780..=0x17FF | 0x19E0..=0x19FF => Khmer,
        0x1200..=0x139F | 0x2D80..=0x2DDF | 0xAB00..=0xAB2F => Ethiopic,
        0x13A0..=0x13FF | 0xAB70..=0xABBF => Cherokee,
        0x1800..=0x18AF => Mongolian,
        0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7AF | 0xD7B0..=0xD7FF => Hangul,
        0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F => Kana,
        0x2E80..=0x2FDF | 0x3005 | 0x3007 | 0x3021..=0x3029 | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
        | 0x20000..=0x3FFFF => Han,
        _ if c.is_alphabetic() => Latin,
        _ => return None,
    })
}

/// Strong right-to-left characters: Arabic, Syriac, Thaana, NKo,
/// Samaritan, Mandaic and the historic RTL scripts of the SMP.
pub fn is_rtl_char(c: char) -> bool {
    matches!(c as u32,
        0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF)
}

/// Right-to-left languages (ISO 639 codes).
pub fn is_rtl_lang(lang: &str) -> bool {
    let base = lang.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
    matches!(
        base.as_str(),
        "ar" | "fa" | "ur" | "ps" | "sd" | "ug" | "ku" | "ckb" | "syr" | "dv" | "nqo" | "ks"
            | "bal" | "prs" | "pnb" | "arc" | "sam" | "mzn" | "glk" | "lrc" | "azb"
    )
}

/// A normalised language code: `fa`, `pt-BR` and `zh_TW` are kept (as `zh-TW`),
/// anything that is not a language tag gives `None`.
pub fn normalize_lang(lang: &str) -> Option<String> {
    let lang = lang.trim().replace('_', "-");
    let mut parts = lang.split('-');
    let base = parts.next()?.to_ascii_lowercase();
    if !(2..=3).contains(&base.len()) || !base.chars().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    match parts.next() {
        Some(r) if (2..=3).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphanumeric()) => {
            Some(format!("{base}-{}", r.to_ascii_uppercase()))
        }
        _ => Some(base),
    }
}

/// `(lang, region)` for Typst's `text(lang:, region:)`.
pub fn split_lang(lang: &str) -> (String, Option<String>) {
    match lang.split_once('-') {
        Some((l, r)) => (l.to_string(), Some(r.to_string())),
        None => (lang.to_string(), None),
    }
}

/// Letter counts per script in `text` (ignores code spans and URLs only as far
/// as they are Latin anyway).
fn script_counts(text: &str) -> Vec<(Script, usize)> {
    let mut counts: Vec<(Script, usize)> = Vec::new();
    for c in text.chars() {
        let Some(s) = script_of(c) else { continue };
        match counts.iter_mut().find(|(k, _)| *k == s) {
            Some((_, n)) => *n += 1,
            None => counts.push((s, 1)),
        }
    }
    counts
}

/// The main script of a text. Han + Kana counts as Japanese, Han + Hangul as
/// Korean. Latin letters count a little less, because notes in every language
/// carry Latin code, links and names.
pub fn dominant_script(text: &str) -> Option<Script> {
    let counts = script_counts(text);
    let get = |s: Script| counts.iter().find(|(k, _)| *k == s).map_or(0, |(_, n)| *n);
    let (kana, hangul, han) = (get(Script::Kana), get(Script::Hangul), get(Script::Han));
    let weight = |s: Script, n: usize| match s {
        Script::Latin => n / 2,
        // One Han character carries about as much text as two or three letters.
        Script::Han | Script::Kana | Script::Hangul => n * 2,
        _ => n,
    };
    let mut best = counts.iter().map(|&(s, n)| (s, weight(s, n))).max_by_key(|&(_, w)| w)?;
    if best.0 == Script::Han && kana > 0 && kana * 10 >= han {
        best.0 = Script::Kana;
    }
    if best.0 == Script::Han && hangul > han {
        best.0 = Script::Hangul;
    }
    if best.1 == 0 {
        return counts.first().map(|(s, _)| *s);
    }
    Some(best.0)
}

/// The language a text is most likely written in, from its letters alone.
pub fn guess_lang(text: &str) -> Option<&'static str> {
    let script = dominant_script(text)?;
    let has = |set: &str| text.chars().any(|c| set.contains(c));
    Some(match script {
        Script::Latin => "en",
        Script::Greek => "el",
        Script::Cyrillic => {
            if has("ґєії") {
                "uk"
            } else if has("ўі") {
                "be"
            } else if has("ђћџ") || has("љњ") && has("ј") {
                "sr"
            } else if has("ѓќѕ") {
                "mk"
            } else if has("ңүөһқғұә") {
                "kk"
            } else {
                "ru"
            }
        }
        Script::Armenian => "hy",
        Script::Georgian => "ka",
        Script::Arabic => {
            // Urdu: ٹ ڈ ڑ ں ے ھ; Persian: پ چ ژ گ and Persian kaf/yeh; Arabic otherwise.
            if has("ٹڈڑںےۓ") {
                "ur"
            } else if has("ۆێڵڕ") {
                "ckb"
            } else if has("ډړږښګڼ") {
                "ps"
            } else if has("پچژگکی") {
                "fa"
            } else {
                "ar"
            }
        }
        Script::Syriac => "syr",
        Script::Thaana => "dv",
        Script::Nko => "nqo",
        Script::Devanagari => {
            if has("ॲऑ") {
                "mr"
            } else {
                "hi"
            }
        }
        Script::Bengali => "bn",
        Script::Gurmukhi => "pa",
        Script::Gujarati => "gu",
        Script::Oriya => "or",
        Script::Tamil => "ta",
        Script::Telugu => "te",
        Script::Kannada => "kn",
        Script::Malayalam => "ml",
        Script::Sinhala => "si",
        Script::Thai => "th",
        Script::Lao => "lo",
        Script::Tibetan => "bo",
        Script::Myanmar => "my",
        Script::Khmer => "km",
        Script::Ethiopic => "am",
        Script::Cherokee => "chr",
        Script::Mongolian => "mn",
        Script::Hangul => "ko",
        Script::Kana => "ja",
        Script::Han => {
            // A few common simplified-only characters tell zh-CN from zh-TW.
            if has("们这个说时为来国对会还过发学经") {
                "zh"
            } else if has("們這個說時為來國對會還過發學經") {
                "zh-TW"
            } else {
                "zh"
            }
        }
    })
}

/// Language of a right-to-left (`rtl`) or left-to-right run whose own letters
/// don't decide it: the document language when it has that direction, else
/// the most common language of that direction.
pub fn lang_for_dir(rtl: bool, doc_lang: &str) -> String {
    if is_rtl_lang(doc_lang) == rtl {
        doc_lang.to_string()
    } else if rtl {
        "ar".into()
    } else {
        "en".into()
    }
}

// ------------------------------------------------------------ digits

/// A decimal digit system: its name and the code point of its zero.
pub struct Digits {
    pub name: &'static str,
    pub zero: char,
    /// Typst's own numbering-pattern character for this system, if it has one.
    pub typst_one: Option<char>,
}

pub const DIGIT_SYSTEMS: &[Digits] = &[
    Digits { name: "latin", zero: '0', typst_one: Some('1') },
    Digits { name: "arabic-indic", zero: '٠', typst_one: Some('١') },
    Digits { name: "persian", zero: '۰', typst_one: Some('۱') },
    Digits { name: "nko", zero: '߀', typst_one: None },
    Digits { name: "devanagari", zero: '०', typst_one: Some('१') },
    Digits { name: "bengali", zero: '০', typst_one: Some('১') },
    Digits { name: "gurmukhi", zero: '੦', typst_one: None },
    Digits { name: "gujarati", zero: '૦', typst_one: None },
    Digits { name: "oriya", zero: '୦', typst_one: None },
    Digits { name: "tamil", zero: '௦', typst_one: None },
    Digits { name: "telugu", zero: '౦', typst_one: None },
    Digits { name: "kannada", zero: '೦', typst_one: None },
    Digits { name: "malayalam", zero: '൦', typst_one: None },
    Digits { name: "thai", zero: '๐', typst_one: None },
    Digits { name: "lao", zero: '໐', typst_one: None },
    Digits { name: "tibetan", zero: '༠', typst_one: Some('༡') },
    Digits { name: "myanmar", zero: '၀', typst_one: None },
    Digits { name: "khmer", zero: '០', typst_one: None },
    Digits { name: "mongolian", zero: '᠐', typst_one: None },
    Digits { name: "fullwidth", zero: '０', typst_one: None },
];

/// Look up a digit system by name (with a few aliases).
pub fn digits(name: &str) -> Option<&'static Digits> {
    let name = match name.trim().to_ascii_lowercase().as_str() {
        "western" | "en" | "ascii" | "european" => "latin".to_string(),
        "arabic" | "eastern-arabic" | "ar" => "arabic-indic".to_string(),
        "fa" | "farsi" | "urdu" | "extended-arabic-indic" => "persian".to_string(),
        "hindi" | "marathi" | "nepali" => "devanagari".to_string(),
        "bangla" => "bengali".to_string(),
        "odia" => "oriya".to_string(),
        "burmese" => "myanmar".to_string(),
        other => other.to_string(),
    };
    DIGIT_SYSTEMS.iter().find(|d| d.name == name)
}

/// The digit system a language traditionally numbers headings and pages with
/// (`digits: auto`). Most languages use Latin digits in print today.
pub fn native_digits(lang: &str) -> &'static Digits {
    let base = lang.split('-').next().unwrap_or("");
    let name = match base {
        "fa" | "ur" | "ps" | "sd" | "ks" | "prs" | "azb" | "mzn" | "glk" | "lrc" | "bal" => "persian",
        "ar" | "ckb" => "arabic-indic",
        "nqo" => "nko",
        "ne" => "devanagari",
        "bn" | "as" => "bengali",
        "my" => "myanmar",
        "km" => "khmer",
        "lo" => "lao",
        "bo" | "dz" => "tibetan",
        _ => "latin",
    };
    digits(name).expect("known digit system")
}

/// Which digit system a pattern's counting digit uses (`1`, `۱`, `١`, `१`…).
fn counting_digit(c: char) -> bool {
    DIGIT_SYSTEMS.iter().any(|d| char::from_u32(d.zero as u32 + 1) == Some(c))
}

/// A Typst `numbering` value for `pattern` (e.g. `"1.1."`, `"۱"`, `"i"`) with
/// its counting digit in `system` (`None` = as written). Systems Typst has no
/// pattern character for become a function that maps Latin digits.
pub fn numbering_value(pattern: &str, system: Option<&Digits>) -> String {
    let q = super::typst_str;
    let Some(sys) = system else { return q(pattern) };
    match sys.typst_one {
        Some(one) => q(&pattern.chars().map(|c| if counting_digit(c) { one } else { c }).collect::<String>()),
        None => {
            let latin: String = pattern.chars().map(|c| if counting_digit(c) { '1' } else { c }).collect();
            format!("(..n) => notez-digits(numbering({}, ..n), {})", q(&latin), sys.zero as u32)
        }
    }
}

// ------------------------------------------------------------ fonts

/// Bundled fallback fonts, in the order Typst should try them after a style's
/// own fonts (Typst picks, per character, the first font that has it).
/// `serif` chooses the serif cut where one is bundled.
pub fn fallback_fonts(serif: bool) -> Vec<&'static str> {
    let mut v = vec![if serif { "Noto Serif" } else { "Noto Sans" }, "Vazirmatn", "Noto Naskh Arabic"];
    v.extend(if serif { ["Noto Serif Devanagari", "Noto Serif Thai"] } else { ["Noto Sans Devanagari", "Noto Sans Thai"] });
    v.extend([
        "Noto Sans Devanagari",
        "Noto Sans Thai",
        "Noto Sans Syriac",
        "Noto Sans Thaana",
        "Noto Sans NKo",
        "Noto Sans Bengali",
        "Noto Sans Gurmukhi",
        "Noto Sans Gujarati",
        "Noto Sans Oriya",
        "Noto Sans Tamil",
        "Noto Sans Telugu",
        "Noto Sans Kannada",
        "Noto Sans Malayalam",
        "Noto Sans Sinhala",
        "Noto Sans Lao",
        "Noto Serif Tibetan",
        "Noto Sans Myanmar",
        "Noto Sans Khmer",
        "Noto Sans Armenian",
        "Noto Sans Georgian",
        "Noto Sans Ethiopic",
        "Noto Sans Cherokee",
        "Noto Sans Mongolian",
        "Noto Sans SC",
        "Noto Sans JP",
        "Noto Sans KR",
        "Noto Sans TC",
    ]);
    let mut seen = std::collections::HashSet::new();
    v.retain(|f| seen.insert(*f));
    v
}

/// For CJK languages the matching regional font goes first among the
/// fallbacks, so shared Han characters get the right regional shapes.
pub fn cjk_font_for(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "ja" => "Noto Sans JP",
        "ko" => "Noto Sans KR",
        "zh-TW" | "zh-HK" | "zh-MO" => "Noto Sans TC",
        l if l.starts_with("zh") => "Noto Sans SC",
        _ => return None,
    })
}

/// Theme keys for per-script fonts (`fonts: { arabic: …, cjk: … }`) and the
/// scripts each one covers. `cjk` is shared by Han, Kana and Hangul.
pub const FONT_KEYS: &[&str] = &[
    "latin", "greek", "cyrillic", "arabic", "syriac", "thaana", "devanagari", "bengali", "gurmukhi",
    "gujarati", "oriya", "tamil", "telugu", "kannada", "malayalam", "sinhala", "thai", "lao", "tibetan", "myanmar",
    "khmer", "armenian", "georgian", "ethiopic", "cjk", "japanese", "korean", "chinese",
];

/// One sample letter of every script in `text` (to check that some font
/// covers it).
pub fn script_samples(text: &str) -> Vec<(Script, char)> {
    let mut v: Vec<(Script, char)> = Vec::new();
    for c in text.chars() {
        if let Some(s) = script_of(c) {
            if !v.iter().any(|(k, _)| *k == s) {
                v.push((s, c));
            }
        }
    }
    v.sort();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts() {
        assert_eq!(script_of('a'), Some(Script::Latin));
        assert_eq!(script_of('é'), Some(Script::Latin));
        assert_eq!(script_of('ж'), Some(Script::Cyrillic));
        assert_eq!(script_of('س'), Some(Script::Arabic));
        assert_eq!(script_of('क'), Some(Script::Devanagari));
        assert_eq!(script_of('ก'), Some(Script::Thai));
        assert_eq!(script_of('字'), Some(Script::Han));
        assert_eq!(script_of('か'), Some(Script::Kana));
        assert_eq!(script_of('한'), Some(Script::Hangul));
        assert_eq!(script_of('7'), None);
        assert_eq!(script_of('.'), None);
    }

    #[test]
    fn rtl() {
        for c in ['س', 'ܐ', 'ހ', 'ߊ'] {
            assert!(is_rtl_char(c), "{c}");
        }
        for c in ['a', 'ж', 'क', '字', '1'] {
            assert!(!is_rtl_char(c), "{c}");
        }
        for l in ["fa", "ar", "ur", "dv", "ckb", "ar-EG", "fa_IR"] {
            assert!(is_rtl_lang(l), "{l}");
        }
        for l in ["en", "ru", "ja", "hi", "zh-TW"] {
            assert!(!is_rtl_lang(l), "{l}");
        }
    }

    #[test]
    fn languages() {
        let cases = [
            ("This is an English note about compilers.", "en"),
            ("این یک یادداشت فارسی است که درباره‌ی گراف‌ها صحبت می‌کند.", "fa"),
            ("هذه ملاحظة باللغة العربية عن الرياضيات.", "ar"),
            ("یہ اردو میں ایک نوٹ ہے۔", "ur"),
            ("Это заметка на русском языке.", "ru"),
            ("Це нотатка українською мовою, її цікаво читати.", "uk"),
            ("Αυτή είναι μια σημείωση στα ελληνικά.", "el"),
            ("यह हिंदी में एक नोट है।", "hi"),
            ("এটি বাংলায় একটি নোট।", "bn"),
            ("นี่คือบันทึกภาษาไทย", "th"),
            ("这是一个关于数学的中文笔记。我们学习了很多。", "zh"),
            ("這是一個關於數學的中文筆記。我們學習了很多。", "zh-TW"),
            ("これは数学についての日本語のノートです。", "ja"),
            ("이것은 수학에 관한 한국어 노트입니다.", "ko"),
            ("Ეს ქართული ჩანაწერია.", "ka"),
            ("Սա հայերեն գրառում է։", "hy"),
            ("ይህ በአማርኛ የተጻፈ ማስታወሻ ነው።", "am"),
            // Persian with plenty of Latin terms is still Persian.
            ("در این درس با Python و API و JSON کار می‌کنیم و نتیجه را می‌بینیم.", "fa"),
        ];
        for (text, lang) in cases {
            assert_eq!(guess_lang(text), Some(lang), "{text}");
        }
        assert_eq!(guess_lang("1234 + 5 = ?"), None);
    }

    #[test]
    fn lang_codes() {
        assert_eq!(normalize_lang("fa").as_deref(), Some("fa"));
        assert_eq!(normalize_lang("pt_br").as_deref(), Some("pt-BR"));
        assert_eq!(normalize_lang("zh-TW").as_deref(), Some("zh-TW"));
        assert_eq!(normalize_lang("English"), None);
        assert_eq!(normalize_lang(""), None);
        assert_eq!(split_lang("pt-BR"), ("pt".into(), Some("BR".into())));
    }

    #[test]
    fn digit_systems() {
        // Each system's zero is followed by one..nine in Unicode.
        for d in DIGIT_SYSTEMS {
            for i in 0..10u32 {
                let c = char::from_u32(d.zero as u32 + i).unwrap();
                assert!(c.is_numeric() || d.name == "tibetan", "{} {i}", d.name);
            }
            if let Some(one) = d.typst_one {
                assert_eq!(one as u32, d.zero as u32 + 1, "{}", d.name);
            }
        }
        assert_eq!(native_digits("fa").name, "persian");
        assert_eq!(native_digits("ar").name, "arabic-indic");
        assert_eq!(native_digits("en").name, "latin");
        assert_eq!(native_digits("hi").name, "latin");
        assert_eq!(digits("arabic").unwrap().name, "arabic-indic");
        assert!(digits("klingon").is_none());
    }

    #[test]
    fn numbering_values() {
        assert_eq!(numbering_value("1.1.", None), "\"1.1.\"");
        assert_eq!(numbering_value("1.1.", digits("persian")), "\"۱.۱.\"");
        assert_eq!(numbering_value("۱.", digits("latin")), "\"1.\"");
        assert_eq!(numbering_value("I.", digits("persian")), "\"I.\"");
        assert_eq!(numbering_value("1", digits("devanagari")), "\"१\"");
        assert_eq!(
            numbering_value("1.1", digits("thai")),
            format!("(..n) => notez-digits(numbering(\"1.1\", ..n), {})", '๐' as u32)
        );
    }

    #[test]
    fn fallbacks() {
        let f = fallback_fonts(true);
        assert_eq!(f[0], "Noto Serif");
        assert!(f.contains(&"Vazirmatn") && f.contains(&"Noto Sans SC"));
        let mut d = f.clone();
        d.dedup();
        assert_eq!(d.len(), f.len());
        assert_eq!(cjk_font_for("ja"), Some("Noto Sans JP"));
        assert_eq!(cjk_font_for("zh-TW"), Some("Noto Sans TC"));
        assert_eq!(cjk_font_for("en"), None);
    }
}
