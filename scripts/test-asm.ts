// Editor assembly highlighting (src/editor/asm.ts) against the cases shared
// with the PDF test (core/src/render/asm_cases.json, run by `cargo test
// assembly_highlighting`). Run: npm run test:asm
import { readFileSync } from "node:fs";
import { StringStream } from "@codemirror/language";
import { asmParser, MIPS_NAMES } from "../src/editor/asm.ts";

const TOKEN: Record<string, string> = {
  mnemonic: "keyword", modifier: "modifier", register: "typeName", number: "number",
  comment: "comment", label: "labelName", directive: "variableName.function", string: "string", plain: "null",
};
const cases: [string, string, [string, string][]][] = JSON.parse(
  readFileSync(new URL("../core/src/render/asm_cases.json", import.meta.url), "utf8"),
);
let failed = 0;
for (const [lang, code, expect] of cases) {
  const p = asmParser(MIPS_NAMES.includes(lang));
  const state = p.startState();
  const toks: [string, string | null][] = [];
  for (const line of code.split("\n")) {
    const s = new StringStream(line, 4, 2);
    while (!s.eol()) {
      const style = p.token(s, state);
      if (s.pos === s.start) throw new Error(`${lang}: tokenizer stuck at ${line.slice(s.pos)}`);
      toks.push([s.current(), style]);
      s.start = s.pos;
    }
  }
  const clean = (t: string) => t.trim().replace(/^"|"$|:$/g, "");
  let pos = 0; // in order: each word is looked for after the previous one
  for (const [word, kind] of expect) {
    const at = toks.findIndex(([t], i) => i >= pos && (t === word || clean(t) === word || t.split(/\s+/).includes(word)));
    const got = at < 0 ? "(not found)" : String(toks[at][1]);
    if (at >= 0) pos = at + 1;
    if (got !== TOKEN[kind]) {
      failed++;
      console.error(`✗ ${lang}: ${word} should be ${kind} (${TOKEN[kind]}), got ${got}`);
    }
  }
}
if (failed) process.exit(1);
console.log(`asm highlighting: ${cases.length} dialects, all tokens as expected`);
