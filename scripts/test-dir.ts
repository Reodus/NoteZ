// Editor table direction (src/editor/dirrules.ts `tableDir` + `explicitDirAt`)
// against the cases shared with the PDF test (core/src/render/dir_cases.json,
// run by `cargo test table_direction`), so a table's columns are in the same
// order in the editor and in the PDF. Run: npm run test:dir
import { readFileSync } from "node:fs";
import { explicitDirAt, tableDir } from "../src/editor/dirrules.ts";

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
process.exit(failed ? 1 : 0);
