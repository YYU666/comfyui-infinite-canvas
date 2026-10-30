/** Wait for immutable media, then sample nodes only after their refs changed. */
export async function flushProjectAfterMedia({ mediaWrites, observeAndFlush }) {
  const observed = new Set();
  for (;;) {
    const pending = [...mediaWrites.values()].filter((write) => !observed.has(write));
    if (!pending.length) break;
    pending.forEach((write) => observed.add(write));
    await Promise.all(pending);
    // Completion callbacks may enqueue another import or remove the old record.
    await Promise.resolve();
  }
  return observeAndFlush();
}
