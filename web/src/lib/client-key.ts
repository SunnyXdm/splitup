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

/**
 * Keeps the exact request of a submission whose outcome is unknown, so a
 * retry resends it byte for byte — same idempotency key AND same body, even
 * if a refetch has since changed derived parts (a settle's watermark or row
 * breakdown). `inputs` are the user-visible fields only: while they are
 * unchanged, `request` returns the kept request; once the user edits any of
 * them, a fresh request is built with a fresh key. After a definite answer
 * (success, or a 4xx rejection) call `reset` so the next tap starts over.
 */
export function createRetryMemo<R>(): {
  request: (inputs: unknown, build: (clientKey: string) => R) => R;
  reset: () => void;
} {
  let kept: { inputs: string; request: R } | null = null;
  return {
    request(inputs, build) {
      const json = JSON.stringify(inputs);
      if (kept === null || kept.inputs !== json) {
        kept = { inputs: json, request: build(newClientKey()) };
      }
      return kept.request;
    },
    reset() {
      kept = null;
    },
  };
}
