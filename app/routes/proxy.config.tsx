// Widget config behind the App Proxy: currently just the welcome message.
// Same-origin from the storefront (https://{shop}/apps/saleshq/config), so no CORS.
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getSettings, getBackofficeMeta, DEFAULT_WELCOME } from "../intent/settings.server";
import { trialExpired } from "../intent/billing.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) return new Response("Unauthorized", { status: 401 });
  const backoffice = await getBackofficeMeta(session.shop);
  const botEnabled = backoffice.botEnabled !== false && !trialExpired(backoffice);
  const settings = await getSettings(session.shop);
  const c = settings.config;
  return Response.json({
    botEnabled,
    welcome: settings.welcomeMessage || DEFAULT_WELCOME,
    proactiveEnabled: botEnabled && c.proactiveEnabled,
    welcomeEnabled: botEnabled && c.welcomeEnabled,
    welcomeDelayMs: c.welcomeDelaySec * 1000,
    idleResumeEnabled: botEnabled && c.idleResumeEnabled,
    idleResumeMs: c.idleResumeSec * 1000,
    soundEnabled: c.soundEnabled,
    badgeEnabled: c.badgeEnabled,
  });
}
