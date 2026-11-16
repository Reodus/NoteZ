/** Serialise writes per vault-relative path and retain failed data for retry. */
export function createWriteQueue(write: (path: string, content: string) => Promise<void>) {
  const pending = new Map<string, Promise<void>>();
  const failed = new Map<string, string>();
  function enqueue(path: string, content: string): Promise<void> {
    const job = (pending.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
      try { await write(path, content); failed.delete(path); }
      catch (e) { failed.set(path, content); throw e; }
    });
    pending.set(path, job);
    void job.finally(() => { if (pending.get(path) === job) pending.delete(path); }).catch(() => {});
    return job;
  }
  async function flush() {
    // First drain accepted work. Retry only failures from earlier operations.
    const retry = [...failed];
    const results = await Promise.allSettled([...pending.values(), ...retry.map(([p, text]) => pending.has(p) ? pending.get(p)! : enqueue(p, text))]);
    const error = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (error) throw error.reason;
    if (pending.size) await flush();
  }
  return { write: enqueue, flush };
}
