// Outbound requests, with a deadline on every one of them.
//
// `fetch` has no timeout. A server that refuses a connection, or drops it,
// rejects quickly and the app moves on; a server that *accepts* the connection
// and then never answers leaves the promise pending for as long as the page is
// open. That is not a hypothetical — it is the normal failure mode of a busy
// public Overpass mirror, which queues a query rather than turning it away, and
// it is indistinguishable on screen from the app having hung: a progress card
// that never advances and never fails.
//
// So nothing here waits indefinitely. Every request carries a deadline, and a
// request that misses it is abandoned so the next mirror, or the next attempt,
// gets its turn.

/**
 * A signal that aborts on `ms`, on the caller's own signal, or on either.
 *
 * The two are kept apart deliberately: a deadline is worth retrying elsewhere,
 * and a walker tapping Cancel is not.
 */
export function deadline(ms, outer) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError')), ms);
  const relay = () => controller.abort(outer.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: controller.signal,
    /** Always call this, so a finished request stops holding a timer. */
    release() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', relay);
    },
  };
}

/** True when this error is the caller's own cancellation rather than a timeout. */
export function cancelled(err, outer) {
  return !!outer?.aborted && err?.name === 'AbortError';
}

/**
 * fetch, with a deadline.
 *
 * Throws a TimeoutError when the deadline passes — which callers treat as "this
 * server is not going to answer", not as "the data is not there".
 */
export async function fetchWithTimeout(url, { timeoutMs = 20000, signal, ...init } = {}) {
  const limit = deadline(timeoutMs, signal);
  try {
    return await fetch(url, { ...init, signal: limit.signal });
  } finally {
    limit.release();
  }
}

/** fetch + JSON, with a deadline and an HTTP status check. */
export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
