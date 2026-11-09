# Languages and scripts

NoteZ is made for notes in any language: English, Arabic, Persian, Urdu,
Chinese, Japanese, Korean, Hindi, Bengali, Tamil, Thai, Russian, Greek,
Amharic and many more, including several languages in one note. This page
explains what NoteZ does for you automatically and what you can change.

- [The interface language](#the-interface-language)
- [The note's language](#the-notes-language)
- [Direction (right-to-left and left-to-right)](#direction-right-to-left-and-left-to-right)
- [A different language for one block or phrase](#a-different-language-for-one-block-or-phrase)
- [Fonts](#fonts)
- [Digits in page and heading numbers](#digits-in-page-and-heading-numbers)
- [Spell checking](#spell-checking)
- [Search](#search)
- [Word count](#word-count)
- [Supported languages](#supported-languages)

## The interface language

Menus, dialogs, settings and messages can be shown in **English** or
**Persian (فارسی)**. Choose it in **Settings → Languages → Interface
language**:

| Choice | What you get |
|---|---|
| Automatic (system language) | Persian when your system language is Persian, otherwise English. This is the default. |
| English | English, left to right. |
| فارسی (Persian) | Persian, with the whole window mirrored right to left and Persian digits in counts and dates. |

NoteZ saves your open notes and reloads the window to apply the change.

The interface language only changes the app around your notes. It never
changes a note: each note keeps its own language and direction (see below),
and the editor and PDF look exactly the same in either interface language.

Translations live in `src/locales/` (one file per language, English text →
translation). Anything not translated yet is shown in English.

## The note's language

Each note has a language. If you don't set one, NoteZ **detects it from the
text** of the note: a note written mostly in Japanese is Japanese, a note
written mostly in Arabic script is Arabic, Persian or Urdu (told apart by the
letters they use), and so on. Latin words in a non-Latin note (code, names,
links) don't change the result.

To set the language yourself, use **⋯ → Page setup → Document language**, or
write it in the note's properties:

```yaml
---
title: Mes notes
lang: fr
---
```

Use an [ISO 639](https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes)
code, optionally with a region: `en`, `en-GB`, `fr`, `ar`, `ar-EG`, `fa`, `ur`,
`zh` (Simplified Chinese), `zh-TW` (Traditional), `ja`, `ko`, `hi`, `pt-BR`…
`lang: auto` (or no `lang`) means "detect".

The language decides, in the PDF:

- the **base direction** of the document (right-to-left for Arabic, Persian,
  Urdu, Pashto, Kurdish (Sorani), Dhivehi, Syriac…),
- **hyphenation** and **quotation marks**,
- the **regional shapes** of Chinese characters (Simplified, Traditional,
  Japanese and Korean forms of the same character differ),
- the **digits** of numbers when the theme uses `digits: auto`.

New notes get no `lang` by default, so their language is detected. In
**Settings → Languages → Language of new notes** you can choose a language
that every new note starts with instead.

A theme can also set a language (top-level `lang:` in the theme file, see
[PDF themes](PDF-THEMES.md)); a note's own `lang` always wins.

## Direction (right-to-left and left-to-right)

You never have to set direction by hand in normal writing. In the editor and
in the PDF, every paragraph, heading, list item and table cell takes the
direction of its first letter:

- `مرحبا بالعالم` and `سلام دنیا` run right-to-left,
- `Hello world`, `Привет`, `नमस्ते`, `你好` run left-to-right,
- a line that starts with a left-to-right word but is mostly right-to-left
  stays right-to-left: `Windows یک سیستم عامل است`.

Latin words inside right-to-left text keep their punctuation:
`read()` and `C++` are shown correctly, not as `()read` or `++C`.

To force a direction, use the toolbar's direction buttons, or type:

```markdown
::: {dir=rtl}
This block runs right-to-left.
:::

::: {dir=ltr}
This block runs left-to-right.
:::

Some text with [a phrase]{dir=ltr} inside.
```

## A different language for one block or phrase

`lang=` sets the language of a block or phrase. It also sets the direction
(unless `dir=` is given too) and picks the right font:

```markdown
::: {lang=ar}
فقرة كاملة باللغة العربية.
:::

The Japanese word [東京]{lang=ja} and the Chinese word [东京]{lang=zh}.
```

## Fonts

NoteZ bundles fonts for all major scripts, so notes in any of them typeset
without installing anything:

| Script | Bundled font |
|---|---|
| Latin, Greek, Cyrillic, Vietnamese | New Computer Modern, Libertinus, Noto Serif, Noto Sans |
| Arabic, Persian, Urdu | Vazirmatn, Noto Naskh Arabic |
| Syriac, Thaana, NKo | Noto Sans Syriac / Thaana / NKo |
| Devanagari (Hindi, Marathi, Nepali, Sanskrit) | Noto Serif / Sans Devanagari |
| Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, Sinhala | Noto Sans … |
| Thai, Lao, Khmer, Myanmar, Tibetan | Noto Sans / Serif … |
| Chinese, Japanese, Korean | Noto Sans SC / TC / JP / KR |
| Armenian, Georgian, Ethiopic, Cherokee, Mongolian | Noto Sans … |

How a font is chosen for each letter, in the PDF:

1. the style's `font`, if it has the letter;
2. the style's per-script `fonts` (see below);
3. the bundled fonts above — for Chinese, Japanese and Korean, the regional
   font of the note's language first;
4. any other font installed on your computer.

The editor uses the same bundled fonts, so what you type looks right before
you export.

### Choosing your own font for a script

In **Styles → Modify style → Fonts for other scripts**, add a row for a script
and pick a font. In a theme file or the note's properties this is the `fonts`
map of a style:

```yaml
styles:
  body:
    font: Libertinus Serif
    fonts:
      arabic: Vazirmatn
      cjk: Noto Serif CJK JP
      devanagari: Noto Serif Devanagari
```

Keys: `latin`, `greek`, `cyrillic`, `arabic`, `syriac`, `thaana`,
`devanagari`, `bengali`, `gurmukhi`, `gujarati`, `oriya`, `tamil`, `telugu`,
`kannada`, `malayalam`, `sinhala`, `thai`, `lao`, `tibetan`, `myanmar`,
`khmer`, `armenian`, `georgian`, `ethiopic`, `cjk` (also `chinese`,
`japanese`, `korean`). The older `font-fa:` key still works and means
`fonts.arabic`.

Any font installed on your system can be used. If a note contains letters no
font has, the preview shows a warning naming the script.

## Digits in page and heading numbers

Page numbers and numbered headings can use the digits of your language. In
**⋯ → Page setup → Digits** or in the theme:

```yaml
page:
  numbering: "1"
  digits: auto          # the language's own digits
  heading-digits: latin # optional: different digits for headings
```

| `digits` | Example |
|---|---|
| `auto` | Persian/Urdu digits for `fa`/`ur`, Arabic-Indic for `ar`, Bengali for `bn`, Myanmar for `my`, Khmer for `km`… Latin for most other languages |
| `latin` | 1 2 3 |
| `arabic-indic` | ١ ٢ ٣ |
| `persian` | ۱ ۲ ۳ |
| `devanagari` | १ २ ३ |
| `bengali` | ১ ২ ৩ |
| `gurmukhi`, `gujarati`, `oriya`, `tamil`, `telugu`, `kannada`, `malayalam` | ੧, ૧, ୧, ௧, ౧, ೧, ൧ |
| `thai`, `lao`, `khmer`, `myanmar`, `tibetan`, `mongolian` | ๑, ໑, ១, ၁, ༡, ᠑ |
| `nko`, `fullwidth` | ߁, １ |
| *(not set)* | as written in the numbering pattern |

All built-in themes use `digits: auto`. Numbering patterns themselves can use
other counting systems too: `"i"` / `"I"` (Roman), `"a"` / `"A"` (letters),
`"α"` (Greek), `"一"` (Chinese), `"あ"` (Japanese kana), `"가"` (Korean).

## Spell checking

Turn it on in **Settings → Editor → Check spelling**, then choose the
dictionaries in **Settings → Languages → Spell-checking languages**. With none
chosen, your system language and English are used. On macOS the system spell
checker is used and follows the system's language settings.

Right-click a marked word for suggestions or to add it to the dictionary.

## Search

Search ignores differences that don't matter for finding text, in every
language:

- capital and small letters (`Paris` = `paris`),
- accents on Latin, Greek and Cyrillic letters (`café` = `cafe`),
- compatibility forms (full-width `ＡＢＣ` = `ABC`, Arabic presentation forms),
- Arabic and Persian letter variants (`ي`/`ی`, `ك`/`ک`, hamza forms), Arabic
  short vowels and tatweel, and zero-width joiners.

Marks that change a letter, like Indic vowel signs, are kept. Chinese,
Japanese and Thai, which are written without spaces, are matched anywhere in
the text.

## Word count

The word count in the status bar uses your system's word rules for each
language, so Chinese, Japanese and Thai text (written without spaces) is
counted in words, not in characters or lines.

## Supported languages

Anything Unicode can write works in the editor. For the PDF, NoteZ knows the
direction, hyphenation and digits of these languages, among others:
Afrikaans, Albanian, Amharic, Arabic, Armenian, Azerbaijani, Basque,
Belarusian, Bengali, Bosnian, Bulgarian, Burmese, Catalan, Chinese
(Simplified and Traditional), Croatian, Czech, Danish, Dhivehi, Dutch,
English, Esperanto, Estonian, Finnish, French, Galician, Georgian, German,
Greek, Gujarati, Hausa, Hindi, Hungarian, Icelandic, Igbo, Indonesian, Irish,
Italian, Japanese, Kannada, Kazakh, Khmer, Korean, Kurdish, Kyrgyz, Lao,
Latin, Latvian, Lithuanian, Macedonian, Malay, Malayalam, Maltese, Marathi,
Mongolian, Nepali, Norwegian, Odia, Pashto, Persian, Polish, Portuguese,
Punjabi, Romanian, Russian, Serbian, Sinhala, Slovak, Slovenian, Spanish,
Swahili, Swedish, Syriac, Tagalog, Tamil, Tatar, Telugu, Thai, Tibetan,
Tigrinya, Turkish, Turkmen, Ukrainian, Urdu, Uzbek, Vietnamese, Welsh, Xhosa,
Yoruba and Zulu.

The sample vault `examples/multilingual-vault/` has one note per script.
