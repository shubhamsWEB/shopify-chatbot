// Operator escape hatch: patch a shop's bot config when the embedded admin UI
// isn't reachable (e.g. automated ops). Same Bearer gate as the cron routes.
//   curl -X POST -H "authorization: Bearer $CRON_SECRET" \
//     -d '{"shop":"x.myshopify.com","config":{"welcomeDelaySec":0}}' https://APP/api/admin/settings
// ponytail: config-only patch; brand/welcome text edits stay in the admin UI.
import type { ActionFunctionArgs } from "react-router";
import { getSettings, saveSettings, normalizeConfig } from "../intent/settings.server";
import type { BotConfig } from "../intent/settings.server";

export async function action({ request }: ActionFunctionArgs) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body: { shop?: string; config?: Partial<BotConfig> };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (!body.shop || !body.config) return Response.json({ error: "shop and config required" }, { status: 400 });
  const current = await getSettings(body.shop);
  const config = normalizeConfig({ ...current.config, ...body.config });
  await saveSettings(body.shop, { ...current, config });
  return Response.json({ ok: true, shop: body.shop, config });
}
