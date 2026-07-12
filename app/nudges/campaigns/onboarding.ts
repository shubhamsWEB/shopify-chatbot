// Time-based welcome series. Every shop enrolls on install; steps fire at a
// delay from the enrollment anchor. Content lives in Resend templates (see
// ../templates.ts) — steps only pick a template key.
import type { Campaign, NudgeContext } from "../types";

const DAY = 24 * 60 * 60 * 1000;
const after = (ms: number) => (ctx: NudgeContext) => ctx.now.getTime() - ctx.enrolledAt.getTime() >= ms;

export const onboarding: Campaign = {
  key: "onboarding",
  shouldEnroll: () => true,
  steps: [
    { id: "welcome", due: after(0), render: () => ({ templateKey: "onboarding-welcome" }) },
    { id: "customize-day1", due: after(1 * DAY), render: () => ({ templateKey: "onboarding-brand" }) },
    { id: "knowledge-day3", due: after(3 * DAY), render: () => ({ templateKey: "onboarding-knowledge" }) },
    { id: "results-day7", due: after(7 * DAY), render: () => ({ templateKey: "onboarding-results" }) },
  ],
};
