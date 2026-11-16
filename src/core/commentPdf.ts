import type { NoteComment } from './commentAnchors';
/** Add render-only metadata without changing source line numbers. */
export function injectComments(path: string, text: string, comments: NoteComment[]): string {
  if (!/\.md$/i.test(path)) return text;
  const lines = text.split('\n');
  const safe: boolean[] = [];
  let frontmatter = /^---\r?$/.test(lines[0]), fence = '', math = false, html = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], m = /^\s*(`{3,}|~{3,})/.exec(l);
    if (frontmatter) { safe.push(false); if (i > 0 && /^(---|\.\.\.)\r?$/.test(l)) frontmatter = false; continue; }
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length && l.trim() === m[1]) fence = '';
      safe.push(false); continue;
    }
    if (fence) { safe.push(false); continue; }
    if (/^\s*\$\$/.test(l)) {
      if (l.trim().match(/\$\$/g)?.length === 1) math = !math;
      safe.push(false); continue;
    }
    if (/^\s*(<!--|<(script|style|pre|div|table)\b)/i.test(l)) html = true;
    safe.push(!fence && !math && !html && !l.includes('|') && !/^( {4}|\t)/.test(l) && !/^\s*(\[.+\]:|:::|[#`~])/.test(l));
    if (html && (/-->/.test(l) || /<\/(script|style|pre|div|table)>/i.test(l) || !l.trim())) html = false;
  }
  comments.filter(c => !c.resolved && !c.orphaned).slice().sort((a,b) => a.from.line-b.from.line).forEach((c, i) => {
    let n = Math.max(0, c.to.line - 1);
    while (n < lines.length && !safe[n]) n++;
    if (n >= lines.length) return; // no safe source line; retain the panel comment
    const json = JSON.stringify({ n: i + 1, body: c.body, replies: c.replies.map(r => r.body) });
    const data = btoa(Array.from(new TextEncoder().encode(json), b => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    lines[n] += ` <!--nz:comment ${data}-->`;
  });
  return lines.join('\n');
}
