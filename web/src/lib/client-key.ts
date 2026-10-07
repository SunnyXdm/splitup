/**
 * Idempotency keys for create requests (8..64 chars of [A-Za-z0-9_-]). The
 * server dedupes a retried POST carrying the same key, so a request that
 * committed but whose response was lost can't be recorded twice.
 */
export function newClientKey(): string {
  const c = globalThis.crypto;
  // randomUUID needs a secure context; fall back to getRandomValues.
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One key per distinct submission: retrying the SAME payload (e.g. after a
 * network error) reuses the key so the server can dedupe; any edit to the
 * payload gets a fresh key so it is never mistaken for the earlier attempt.
 */
export function createClientKeyTracker(): (payload: unknown) => string {
  let last: { json: string; key: string } | null = null;
  return (payload) => {
    const json = JSON.stringify(payload);
    if (last === null || last.json !== json) last = { json, key: newClientKey() };
    return last.key;
  };
}
