// Line diff (Myers' O(ND) algorithm) for comparing versions of a note.

export type DiffOp = { kind: "same" | "del" | "ins"; text: string; a?: number; b?: number };

/** Lines of `a` and `b` as same / deleted (only in a) / inserted (only in b). */
export function diffLines(a: string, b: string): DiffOp[] {
  const A = a.split("\n");
  const B = b.split("\n");
  // Common head and tail first: most edits are small.
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }
  const mid = myers(A.slice(start, endA), B.slice(start, endB));
  const out: DiffOp[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "same", text: A[i], a: i + 1, b: i + 1 });
  let ia = start;
  let ib = start;
  for (const op of mid) {
    if (op === "same") out.push({ kind: "same", text: A[ia], a: ++ia, b: ++ib });
    else if (op === "del") out.push({ kind: "del", text: A[ia], a: ++ia });
    else out.push({ kind: "ins", text: B[ib], b: ++ib });
  }
  for (let i = endA; i < A.length; i++) out.push({ kind: "same", text: A[i], a: ++ia, b: ++ib });
  return out;
}

function myers(a: string[], b: string[]): ("same" | "del" | "ins")[] {
  const n = a.length;
  const m = b.length;
  if (!n) return Array(m).fill("ins");
  if (!m) return Array(n).fill("del");
  const max = n + m;
  // Too different to be worth an exact diff: everything changed.
  if (n * m > 25_000_000) return [...Array(n).fill("del"), ...Array(m).fill("ins")];
  const off = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk back through the trace.
  const ops: ("same" | "del" | "ins")[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("same");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("ins");
      y--;
    } else {
      ops.push("del");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("same");
    x--;
    y--;
  }
  return ops.reverse();
}

/** Lines added and removed. */
export function diffStats(ops: DiffOp[]) {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.kind === "ins") added++;
    else if (o.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * Changed lines with `context` unchanged lines around them; longer runs of
 * unchanged lines become `{ kind: "skip", count }`.
 */
export function withContext(ops: DiffOp[], context = 3): (DiffOp | { kind: "skip"; count: number })[] {
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, i) => {
    if (o.kind !== "same") for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = 1;
  });
  const out: (DiffOp | { kind: "skip"; count: number })[] = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(o);
    } else skipped++;
  });
  if (skipped) out.push({ kind: "skip", count: skipped });
  return out;
}
