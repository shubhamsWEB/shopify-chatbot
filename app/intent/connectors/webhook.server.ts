// Generic outgoing webhook — the escape hatch for any CRM/automation the
// merchant wires up (Zapier, Make, n8n, or LimeChat via one of those, since
// LimeChat has no public self-serve API). We POST a signed JSON body; the
// receiver verifies X-SalesHQ-Signature against the shared secret to trust it.
// No retry queue in v1: a failed dispatch leaves the ticket visibly `open` in
// the merchant's admin list rather than silently vanishing.
import crypto from "node:crypto";

const TIMEOUT_MS = 8000;

export interface WebhookResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

/** HMAC-SHA256 of the exact bytes we send, hex, prefixed `sha256=` (GitHub-style
 * so receivers recognize the scheme). Empty secret → unsigned (still delivered;
 * the merchant just can't verify origin). */
export function signPayload(body: string, secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export async function dispatchWebhook(
  url: string,
  secret: string | undefined,
  event: string,
  payload: unknown,
): Promise<WebhookResult> {
  const body = JSON.stringify(payload);
  const sig = signPayload(body, secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-SalesHQ-Event": event,
        ...(sig ? { "X-SalesHQ-Signature": sig } : {}),
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, statusCode: res.status, error: res.ok ? undefined : `webhook ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "AbortError" ? "webhook timeout" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
