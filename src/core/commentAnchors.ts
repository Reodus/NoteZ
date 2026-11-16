/** UTF-16 columns, matching CodeMirror; lines are 1-based. */
export interface Point { line: number; ch: number }
export interface NoteComment {
  id: string; from: Point; to: Point; quote: string; body: string;
  created: string; updated: string; resolved: boolean; orphaned?: boolean;
  replies: { id: string; body: string; created: string }[];
}
export function offset(text: string, p: Point): number {
  const lines = text.split('\n');
  const line = Math.max(1, Math.min(lines.length, p.line));
  return lines.slice(0, line - 1).reduce((n, s) => n + s.length + 1, 0) + Math.max(0, Math.min(lines[line - 1].length, p.ch));
}
export function point(text: string, pos: number): Point {
  const before = text.slice(0, Math.max(0, Math.min(text.length, pos))).split('\n');
  return { line: before.length, ch: before.at(-1)!.length };
}
export function reanchor(c: NoteComment, text: string): NoteComment {
  const start = offset(text, c.from), end = offset(text, c.to);
  if (!c.orphaned && text.slice(start, end) === c.quote) return { ...c, orphaned: false };
  let best = -1, distance = Infinity;
  if (c.quote) for (let at = text.indexOf(c.quote); at >= 0; at = text.indexOf(c.quote, at + 1)) {
    const d = Math.abs(point(text, at).line - c.from.line) * (text.length + 1) + Math.abs(at - start);
    if (d < distance) { best = at; distance = d; }
  }
  return best < 0 ? { ...c, orphaned: true } : { ...c, from: point(text, best), to: point(text, best + c.quote.length), orphaned: false };
}
