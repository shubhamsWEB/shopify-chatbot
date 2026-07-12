// One-click unsubscribe landing. Reached from email footer links + the RFC 8058
// List-Unsubscribe header (which POSTs). Authorized by the HMAC token, not a
// session. GET shows a confirmation page; POST is the mail-client one-click.
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { verifyShop, suppress } from "../nudges/unsub.server";

async function optOut(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  const token = url.searchParams.get("t") ?? "";
  if (!shop || !verifyShop(shop, token)) {
    return new Response("Invalid unsubscribe link.", { status: 400 });
  }
  await suppress(shop);
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center;color:#222">
      <h1 style="font-size:20px">You’re unsubscribed</h1>
      <p>${shop} won’t receive any more SalesHQ nudge emails.</p>
    </body>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export const loader = ({ request }: LoaderFunctionArgs) => optOut(request);
export const action = ({ request }: ActionFunctionArgs) => optOut(request); // one-click POST
