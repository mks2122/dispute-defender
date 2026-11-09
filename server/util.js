// Small pure helpers shared across layers (no I/O).

/**
 * Run fn over items with bounded concurrency. Never throws: returns one result per item,
 * either { ok: true, value } or { ok: false, error }, so callers must handle failures explicitly.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await fn(items[i]) }; }
      catch (error) { results[i] = { ok: false, error, item: items[i] }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
