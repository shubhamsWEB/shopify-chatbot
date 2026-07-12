// Condition-based usage nudges. Fire when monthly AI-reply usage crosses a
// threshold of the plan quota. Month is baked into each step id so the nudge
// re-arms per billing month, no reset job. Content lives in the usage-warn /
// usage-exhausted Resend templates; we pass the live numbers as variables.
import type { Campaign, NudgeContext } from "../types";
import { getBackofficeMeta } from "../../intent/settings.server";
import { monthlyReplies } from "../../intent/transcript.server";

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Current usage snapshot, or null if on an unlimited plan. */
async function usage(shop: string): Promise<{ used: number; limit: number; frac: number } | null> {
  const bo = await getBackofficeMeta(shop);
  if (bo.convoLimit == null || bo.convoLimit <= 0) return null;
  const used = await monthlyReplies(shop);
  return { used, limit: bo.convoLimit, frac: used / bo.convoLimit };
}

const crosses = (threshold: number) => async (ctx: NudgeContext) => {
  const u = await usage(ctx.shop);
  return u != null && u.frac >= threshold;
};

const vars = async (shop: string) => {
  const u = (await usage(shop)) ?? { used: 0, limit: 0, frac: 0 };
  return { USED: u.used, LIMIT: u.limit, PCT: Math.min(100, Math.round(u.frac * 100)) };
};

export const limitReached: Campaign = {
  key: "usage-limit",
  shouldEnroll: () => true,
  steps: [
    {
      id: `warn-80-${monthKey(new Date())}`,
      due: crosses(0.8),
      render: async (ctx) => ({ templateKey: "usage-warn", variables: await vars(ctx.shop) }),
    },
    {
      id: `reached-100-${monthKey(new Date())}`,
      due: crosses(1),
      render: async (ctx) => ({ templateKey: "usage-exhausted", variables: await vars(ctx.shop) }),
    },
  ],
};

// ponytail: step ids capture the month at MODULE LOAD. Vercel restarts the
// function per cron invocation so each run recomputes — fine. If ever run as a
// persistent worker crossing a month boundary, compute monthKey inside due().
