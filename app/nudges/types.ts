// A "series" is pure data: a Campaign with ordered Steps. The dispatcher
// (dispatch.server.ts) is generic — adding a new series never touches engine
// code, only the registry. Three trigger shapes cover current + future needs:
//   time      — onboarding: fire N ms after an anchor (install)
//   condition — limit nudges: fire when a runtime check flips true
//   broadcast — feature announcements: fire once after a release date
// All three reduce to one method: due() returns whether this step should send
// now for this shop. The engine only knows due() + render().

export interface NudgeContext {
  shop: string;
  now: Date;
  /** Install/enrollment anchor for this shop+campaign, set on first tick. */
  enrolledAt: Date;
}

export interface RenderedEmail {
  /** Key of a Resend template (see templates.ts / template-ids.json). Subject
   *  + HTML live in Resend; we only supply variables. */
  templateKey: string;
  /** Values for the template's {{{VARS}}}. UNSUB_URL is injected centrally in
   *  send.server, so campaigns omit it. */
  variables?: Record<string, string | number>;
}

export interface Step {
  /** Stable id, used as the dedupe key in NudgeLog. NEVER reuse or the
   *  step is treated as already-sent. Encode a period (e.g. "-2026-07") to
   *  re-arm a recurring step per month. */
  id: string;
  due(ctx: NudgeContext): boolean | Promise<boolean>;
  render(ctx: NudgeContext): RenderedEmail | Promise<RenderedEmail>;
}

export interface Campaign {
  /** Stable key, part of the dedupe PK. */
  key: string;
  /** Which shops enter this series. Return false to skip a shop entirely
   *  (e.g. broadcast to paid plans only). Onboarding = always true. */
  shouldEnroll(shop: string): boolean | Promise<boolean>;
  steps: Step[];
}
