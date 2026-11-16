/** Editors with debounced side files participate in close/switch barriers. */
const participants = new Set<() => Promise<void>>();
export function registerSaveParticipant(flush: () => Promise<void>) {
  participants.add(flush);
  return () => { participants.delete(flush); };
}
export async function flushSaveParticipants() {
  const results = await Promise.allSettled([...participants].map(flush => flush()));
  const error = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (error) throw error.reason;
}
