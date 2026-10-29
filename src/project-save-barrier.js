/** Wait for immutable media, then sample nodes only after their refs changed. */
export async function flushProjectAfterMedia({ mediaWrites, observeAndFlush }) {
  const pending = [...mediaWrites.values()];
  if (pending.length) await Promise.all(pending);
  return observeAndFlush();
}
