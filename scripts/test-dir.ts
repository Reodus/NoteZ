// Editor table direction (src/editor/dirrules.ts `tableDir` + `explicitDirAt`)
// against the cases shared with the PDF test (core/src/render/dir_cases.json,
// run by `cargo test table_direction`), so a table's columns are in the same
// order in the editor and in the PDF. Run: npm run test:dir
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { explicitDirAt, markdownDivs, tableDir } from "../src/editor/dirrules.ts";

const cases: [string, "rtl" | "ltr"][] = JSON.parse(
  readFileSync(new URL("../core/src/render/dir_cases.json", import.meta.url), "utf8"),
);
let failed = 0;
for (const [md, want] of cases) {
  const lines = md.split("\n");
  const doc = { line: (n: number) => ({ text: lines[n - 1] ?? "" }) };
  const first = lines.findIndex((l) => l.trimStart().startsWith("|"));
  let last = first;
  while (last + 1 < lines.length && lines[last + 1].trimStart().startsWith("|")) last++;
  const src = lines.slice(first, last + 1).join("\n");
  const got = tableDir(src, explicitDirAt(doc, first + 1));
  if (got !== want) {
    failed++;
    console.error(`FAIL (${got}, want ${want}):\n${md}\n`);
  }
}
console.log(failed ? `${failed} of ${cases.length} failed` : `table direction: ${cases.length} cases ok`);
const nested = [
  "::: {align=center dir=rtl}", "~~~", ":::", "~~~", "::: {font=Inter}", "text", ":::", "more", ":::", "::: {align=right}", "end",
];
const parsed = markdownDivs({ lines: nested.length, line: (n) => ({ text: nested[n - 1] }) });
assert.equal(parsed.markers.has(3), false);
assert.equal(parsed.markers.get(1)?.close, 9);
assert.equal(parsed.markers.get(5)?.close, 7);
assert.deepEqual(parsed.at[6]?.effective, { align: "center", dir: "rtl", font: "Inter" });
assert.equal(parsed.at[11]?.close, null);
process.exit(failed ? 1 : 0);
