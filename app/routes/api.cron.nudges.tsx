// Cron entry point. Vercel Cron hits this GET daily (see vercel.json). Guarded
// by CRON_SECRET so it can't be triggered by randoms. Also runnable manually:
//   curl -H "authorization: Bearer $CRON_SECRET" https://APP/api/cron/nudges
import type { LoaderFunctionArgs } from "react-router";
import { dispatchNudges } from "../nudges/dispatch.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const result = await dispatchNudges();
  return Response.json(result);
};
