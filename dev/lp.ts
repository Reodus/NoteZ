// Dev harness for the live-preview extension (open /dev/lp.html on the Vite server).
import "@fontsource-variable/inter";
import "../src/styles/app.css";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { styling } from "../src/editor/styling";
import { bidi } from "../src/editor/bidi";
import { livePreview } from "../src/editor/livepreview";
import { autocompletion, startCompletion } from "@codemirror/autocomplete";
import { slashCompletion, slashIconRender } from "../src/editor/slash";

const doc = `---
title: یادداشت آزمایشی
theme: academic
tags: [notes, test]
---

# عنوان اصلی Heading
## Second **level**

متن **پررنگ** و *کج* و ~~خط‌خورده~~ با \`code\` و [لینک](https://typst.app) و [[Welcome]] و [[Welcome|خوش‌آمد]].

[رنگی]{color=#c00 bold} and inline math $E = mc^2$ here.

$$\\int_0^1 x^2 dx = \\frac{1}{3}$$

$$
\\texttt{ALUResult} = \\texttt{x9} + \\texttt{ImmExt} = \\texttt{0x00002004} +
\\texttt{0xFFFFFFFC} = \\texttt{0x00002000}
$$

$$ \\mathrm{FF}_{16} = 00001111_2 \\xrightarrow{\\text{Sign-Extend}} 0000000011111111_2
$$

> نقل قول **مهم**

- آیتم اول
- second item
  - nested

1. numbered
2. two

- [ ] task open
- [x] task done

---

::: {align=center box=#eef}
centered block
:::

> [!TIP] نکتهٔ مهم
> این یک **callout** است.

> [!WARNING]
> Careful with this.

| نام | Score | Notes |
|---|:---:|---|
| علی | 18 | **excellent** |
| Sara | 15 | \`ok\` |

\`\`\`python
def hello():
    return "hi"
\`\`\`

<!-- pagebreak -->

This line is active: # **raw** stays visible`;

const state = EditorState.create({
  doc,
  selection: EditorSelection.cursor(doc.length),
  extensions: [
    markdown({ base: markdownLanguage }),
    styling(false),
    bidi,
    EditorView.lineWrapping,
    livePreview(true, false, { openLink: (t) => console.log("open", t), notePath: () => "a.md", vaultRoot: () => null }),
  ],
});
new EditorView({ state, parent: document.getElementById("host")! });

// Second editor: the slash menu opened on an empty line.
const host2 = document.createElement("div");
host2.style.cssText = "height:520px;display:none;position:fixed;top:0;left:0;width:900px;z-index:10;background:var(--surface);box-shadow:var(--shadow-lg)";
document.querySelector(".editor")!.after(host2);
host2.className = "editor";
const v2 = new EditorView({
  state: EditorState.create({
    doc: "Slash menu demo\n/",
    selection: EditorSelection.cursor(17),
    extensions: [markdown({ base: markdownLanguage }), autocompletion({ override: [slashCompletion], icons: false, addToOptions: [slashIconRender] })],
  }),
  parent: host2,
});
v2.focus();
setTimeout(() => startCompletion(v2), 300);
setTimeout(() => document.body.setAttribute("data-ready", "1"), 1500);
