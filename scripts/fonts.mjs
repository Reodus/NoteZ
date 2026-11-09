// Download the bundled Noto fonts (SIL Open Font License) into core/fonts/noto/.
// They give the PDF engine and the editor a font for every major script, so
// notes in Arabic, Hindi, Chinese, Thai, Amharic … typeset without the user
// installing anything. Files are fetched from pinned commits and skipped when
// already present; run with --force to download again.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const NOTO = "https://raw.githubusercontent.com/notofonts/notofonts.github.io/86ce02c0fe7890f5936c5dffb26fca0797d1be64/fonts";
const CJK = "https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const LICENSE_URL = `${CJK}/Sans/LICENSE`; // the SIL Open Font License 1.1, shared by all Noto fonts

/** Noto families with Regular + Bold static TTFs (hinted). */
const FAMILIES = [
  // Latin, Greek, Cyrillic, Vietnamese
  "NotoSans", "NotoSerif",
  // Right-to-left
  "NotoNaskhArabic", "NotoSansThaana",
  // South Asia
  "NotoSansDevanagari", "NotoSerifDevanagari", "NotoSansBengali", "NotoSansGurmukhi", "NotoSansGujarati",
  "NotoSansOriya", "NotoSansTamil", "NotoSansTelugu", "NotoSansKannada", "NotoSansMalayalam", "NotoSansSinhala",
  "NotoSerifTibetan",
  // South-East Asia
  "NotoSansThai", "NotoSerifThai", "NotoSansLao", "NotoSansKhmer", "NotoSansMyanmar",
  // Others
  "NotoSansArmenian", "NotoSansGeorgian", "NotoSansEthiopic", "NotoSansCherokee",
];

/** Families that only come in Regular. */
const REGULAR_ONLY = ["NotoSansSyriac", "NotoSansNKo", "NotoSansMongolian"];

/** Noto Sans CJK, one regional subset per language (Regular + Bold). */
const CJK_REGIONS = [
  ["SC", "NotoSansSC"],
  ["TC", "NotoSansTC"],
  ["JP", "NotoSansJP"],
  ["KR", "NotoSansKR"],
];

const out = path.resolve("core/fonts/noto");
const force = process.argv.includes("--force");
mkdirSync(out, { recursive: true });

const jobs = [];
for (const fam of FAMILIES) {
  for (const w of ["Regular", "Bold"]) jobs.push([`${NOTO}/${fam}/hinted/ttf/${fam}-${w}.ttf`, `${fam}-${w}.ttf`]);
}
for (const fam of REGULAR_ONLY) jobs.push([`${NOTO}/${fam}/hinted/ttf/${fam}-Regular.ttf`, `${fam}-Regular.ttf`]);
for (const [region, fam] of CJK_REGIONS) {
  for (const w of ["Regular", "Bold"]) jobs.push([`${CJK}/Sans/SubsetOTF/${region}/${fam}-${w}.otf`, `${fam}-${w}.otf`]);
}
jobs.push([LICENSE_URL, "OFL.txt"]);

async function fetchOne([url, name]) {
  const dst = path.join(out, name);
  if (!force && existsSync(dst) && statSync(dst).size > 0) return false;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // TrueType (00 01 00 00), OpenType CFF ("OTTO") or the license text.
      const magic = buf.subarray(0, 4).toString("latin1");
      if (!name.endsWith(".txt") && magic !== "\0\x01\0\0" && magic !== "OTTO") throw new Error("not a font file");
      writeFileSync(dst, buf);
      return true;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${name}: ${e.message} (${url})`);
    }
  }
}

let fetched = 0;
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) if (await fetchOne(job)) fetched++;
  }),
);
console.log(`fonts → ${out} (${fetched} downloaded, ${jobs.length - fetched} cached)`);
