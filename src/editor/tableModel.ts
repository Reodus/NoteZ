// Markdown table source and cell offsets, independent of the rendered widget.
export type TableAlignment = "" | "left" | "center" | "right";

export interface TableModel {
  header: string[];
  aligns: TableAlignment[];
  rows: string[][];
}

// ------------------------------------------------------------- parsing

/** Cell content ranges (offsets in `text`) between unescaped pipes. */
export function cellSegments(text: string): { from: number; to: number }[] {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|") pipes.push(i);
  }
  const lead = text.trimStart().startsWith("|");
  const trimmed = text.trimEnd();
  const trail = pipes.length > (lead ? 1 : 0) && pipes[pipes.length - 1] === trimmed.length - 1;
  const bounds = [lead ? pipes[0] : -1, ...pipes.slice(lead ? 1 : 0, trail ? -1 : undefined), trail ? pipes[pipes.length - 1] : text.length];
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) out.push({ from: bounds[i] + 1, to: bounds[i + 1] });
  return out;
}

const cellsOf = (line: string) => cellSegments(line).map((s) => line.slice(s.from, s.to).trim());

export function parseTable(src: string): TableModel {
  const lines = src.split("\n").filter((l) => l.trim());
  const header = cellsOf(lines[0] ?? "");
  const aligns = cellsOf(lines[1] ?? "").map((c): TableAlignment => (/^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : /^:-+$/.test(c) ? "left" : ""));
  const rows = lines.slice(2).map(cellsOf);
  const n = Math.max(1, header.length, ...rows.map((r) => r.length));
  const pad = <T extends string>(cells: T[], empty: T) => Array.from({ length: n }, (_, i) => cells[i] ?? empty);
  return { header: pad(header, ""), aligns: pad<TableAlignment>(aligns, ""), rows: rows.map((row) => pad(row, "")) };
}

/** Display width: combining marks and joiners take no space. */
const width = (s: string) => [...s].filter((c) => !/[\p{M}‌‍‎‏]/u.test(c)).length;
const padTo = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

/** Advanced-Tables-style source: aligned pipes, `---` rows with colons. */
export function formatTable(m: TableModel): string {
  const n = m.header.length;
  const w = Array.from({ length: n }, (_, c) => Math.max(3, width(m.header[c]), ...m.rows.map((r) => width(r[c] ?? ""))));
  const line = (cells: string[]) => "| " + cells.map((c, i) => padTo(c ?? "", w[i])).join(" | ") + " |";
  const delim = "| " + m.aligns.map((a, i) => {
    const d = w[i];
    return a === "center" ? ":" + "-".repeat(d - 2) + ":" : a === "right" ? "-".repeat(d - 1) + ":" : a === "left" ? ":" + "-".repeat(d - 1) : "-".repeat(d);
  }).join(" | ") + " |";
  return [line(m.header), delim, ...m.rows.map(line)].join("\n");
}

export const unescapeCell = (s: string) => s.replace(/\\\|/g, "|");
export const escapeCell = (s: string) => s.replace(/(?<!\\)\|/g, "\\|");

/** Rows of a pasted block: tab-separated (spreadsheets) or a Markdown table. */
export function pastedRows(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.every((l) => l.trim().startsWith("|"))) {
    return lines.filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l) || !l.includes("-")).map(cellsOf);
  }
  if (lines.length > 1 || text.includes("\t")) return lines.map((l) => l.split("\t").map((c) => escapeCell(c.trim())));
  return null;
}

/** Map cell content by its row and column, including identical text in different cells. */
export function columnRanges(before: string, after: string, start: number, order: number[]) {
  const ranges: { from: number; to: number; dest: number }[] = [];
  const lines = after.split("\n");
  let oldStart = start, newStart = start, row = 0;
  for (const line of before.split("\n")) {
    if (line.trim()) {
      const next = lines[row];
      if (row !== 1) {
        const oldCells = cellSegments(line), newCells = cellSegments(next);
        order.forEach((oldColumn, newColumn) => {
          const old = oldCells[oldColumn];
          if (!old) return;
          const raw = line.slice(old.from, old.to);
          const content = raw.trim();
          if (!content) return;
          const from = oldStart + old.from + raw.length - raw.trimStart().length;
          // The formatter always writes one space between a pipe and the content.
          ranges.push({ from, to: from + content.length, dest: newStart + newCells[newColumn].from + 1 });
        });
      }
      newStart += next.length + 1;
      row++;
    }
    oldStart += line.length + 1;
  }
  return ranges;
}
