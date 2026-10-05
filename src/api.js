import { config, partnerKey } from './config.js';

// Raised for 401/403 only. An invalid key is not a per-user problem: it means
// every remaining call for that partner will fail too, so the cycle stops that
// partner immediately instead of burning the whole queue against a bad key.
export class AuthError extends Error {
  constructor(partnerName, status) {
    super(`Affiliate key rejected for ${partnerName} (HTTP ${status})`);
    this.name = 'AuthError';
    this.partnerName = partnerName;
  }
}

export async function fetchStatus(pan, partnerName) {
  const key = partnerKey(partnerName);
  const keyLast6 = key.slice(-6);
  const url = `${config.statusUrl}?pan=${encodeURIComponent(pan)}`;
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      headers: { 'X-Affiliate-Key': key },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const latencyMs = Date.now() - startedAt;

    if (res.status === 401 || res.status === 403) throw new AuthError(partnerName, res.status);

    // A non-JSON body (an HTML error page from a proxy, say) must not throw -
    // it is still worth recording as a failed attempt.
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 200) }; }

    return { httpStatus: res.status, body, latencyMs, keyLast6 };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return {
      httpStatus: 0,
      body: { message: err.name === 'TimeoutError' ? 'request timed out' : err.message },
      latencyMs: Date.now() - startedAt,
      keyLast6,
    };
  }
}
