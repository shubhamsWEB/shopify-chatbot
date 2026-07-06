// Cost guard for the LLM proxy endpoints. The App Proxy already binds every
// request to an installed shop, but a single storefront (or a bot) could still
// hammer chat/proactive and run up the shop's LLM bill. Redis-backed atomic
// fixed-window counters — global across every serverless instance, unlike an
// in-process Map. Fails OPEN on any error (a metering outage must never block
// a shopper turn; the monthly reply/cost cap in botGate.server.ts is the real
// hard stop and is DB-backed, not affected by this).
import { kv } from "@vercel/kv";

async function hit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, windowSec); // only the first hit starts the window
  return count <= limit;
}

// Returns true if allowed. Both windows must pass.
export async function allowLlm(shop: string, sessionId: string): Promise<boolean> {
  try {
    const [sessOk, shopOk] = await Promise.all([
      hit(`rl:sess:${shop}:${sessionId}`, 20, 60),
      hit(`rl:shop:${shop}`, 1000, 3600),
    ]);
    return sessOk && shopOk;
  } catch (err) {
    console.error("[ratelimit] error, failing open:", (err as Error).message);
    return true;
  }
}
