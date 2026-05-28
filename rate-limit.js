const memoryStore = new Map();

function cleanupExpiredEntries(now) {
  for (const [key, entry] of memoryStore) {
    if (entry.resetAt <= now) memoryStore.delete(key);
  }
}

function memoryConsume(key, limit, windowMs) {
  const now = Date.now();
  cleanupExpiredEntries(now);

  const existing = memoryStore.get(key);
  if (!existing || existing.resetAt <= now) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }

  if (existing.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: existing.resetAt - now };
  }

  existing.count += 1;
  return { ok: true, remaining: Math.max(limit - existing.count, 0) };
}

let dbClient = null;

export function setRateLimitDbClient(client) {
  dbClient = client;
}

async function supabaseConsume(key, limit, windowMs) {
  if (!dbClient) return null;

  const now = Date.now();
  const resetAt = now + windowMs;

  const { data: row, error } = await dbClient
    .from("rate_limits")
    .select("count, reset_at")
    .eq("key", key)
    .single();

  if (error && error.code !== "PGRST116") return null;

  const existing = row;

  if (!existing || existing.reset_at <= now) {
    const { error: upsertError } = await dbClient
      .from("rate_limits")
      .upsert({ key, count: 1, reset_at: resetAt }, { onConflict: "key" });
    if (upsertError) return null;
    return { ok: true, remaining: limit - 1 };
  }

  if (existing.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: existing.reset_at - now };
  }

  const newCount = existing.count + 1;
  const { error: updateError } = await dbClient
    .from("rate_limits")
    .update({ count: newCount })
    .eq("key", key);
  if (updateError) return null;

  return { ok: true, remaining: Math.max(limit - newCount, 0) };
}

export function consumeRateLimit(key, maxRequests, windowMs = 10 * 60 * 1000) {
  const memoryResult = memoryConsume(key, maxRequests, windowMs);
  if (!memoryResult.ok) return memoryResult;

  return supabaseConsume(key, maxRequests, windowMs).then((dbResult) => {
    if (dbResult) {
      if (!dbResult.ok && memoryResult.ok) memoryStore.delete(key);
      return dbResult;
    }
    return memoryResult;
  });
}

export async function consumeRateLimitSync(key, maxRequests, windowMs = 10 * 60 * 1000) {
  const memoryResult = memoryConsume(key, maxRequests, windowMs);
  if (!memoryResult.ok) return memoryResult;

  const dbResult = await supabaseConsume(key, maxRequests, windowMs);
  if (dbResult) {
    if (!dbResult.ok && memoryResult.ok) memoryStore.delete(key);
    return dbResult;
  }

  return memoryResult;
}

export async function cleanupStaleRateLimits() {
  if (!dbClient) return;
  const now = Date.now();
  await dbClient.from("rate_limits").delete().lt("reset_at", now);
}

setInterval(async () => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.resetAt <= now) memoryStore.delete(key);
  }
  await cleanupStaleRateLimits().catch(() => null);
}, 60_000);
