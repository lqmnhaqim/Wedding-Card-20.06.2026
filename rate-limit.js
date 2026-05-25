const rateLimitMap = new Map();

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export function consumeRateLimit(key, maxRequests, windowMs = RATE_LIMIT_WINDOW_MS) {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  entry.count += 1;
  if (entry.count > maxRequests) {
    return { ok: false, retryAfterMs: entry.resetAt - now };
  }

  rateLimitMap.set(key, entry);
  return { ok: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);
