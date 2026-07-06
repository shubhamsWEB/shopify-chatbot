import Anthropic from "@anthropic-ai/sdk";

// Reads ANTHROPIC_API_KEY from env. Model tiering per spec §7.2:
// Haiku for high-volume micro-summaries, Sonnet for synthesis.
const client = new Anthropic();

export default client;

export const HAIKU = "claude-haiku-4-5";
// Sonnet 5: intro pricing $2/$10 per MTok through 2026-08-31 (then $3/$15 —
// Sonnet 4.6's price, for a better model). CHAT_MODEL overrides the main
// shopper-facing loop (chat replies + popup composes ≈ 85% of LLM spend);
// set CHAT_MODEL=claude-haiku-4-5 to A/B a 3x cheaper tier.
export const SONNET = "claude-sonnet-5";
// eslint-disable-next-line no-undef
export const CHAT_MODEL = process.env.CHAT_MODEL || SONNET;

// Force a single tool call and return its parsed input. Robust JSON across SDK
// versions without relying on output_config (newer-SDK-only).
export async function toolCall<T>(opts: {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  shop?: string; // when set, usage is metered into the shop's LlmUsage ledger
}): Promise<T> {
  const res = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: { type: "object", ...opts.schema } as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: opts.toolName },
    messages: [{ role: "user", content: opts.user }],
  });
  if (opts.shop) {
    // Dynamic import avoids a load-time cycle (usage.server → db.server).
    import("./usage.server").then((m) => m.recordUsage(opts.shop!, opts.model, res.usage)).catch(() => {});
  }
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("no tool_use in response");
  return block.input as T;
}
