// Follow-up CTAs (quick replies). Cheap Haiku call that turns the assistant's
// reply + the shopper's intent profile into 3 short, tap-able suggestions phrased
// as the SHOPPER would say them — each one designed to NARROW and reveal intent
// (price ceiling, attribute, use-case, comparison, category), not generic filler.
import { toolCall, HAIKU } from "./claude.server";
import type { IntentProfile } from "./events";

const SYSTEM =
  "You write 3 short tap-able follow-up suggestions for a storefront shopper. Rules:\n" +
  "- Each ≤ 6 words, phrased as the SHOPPER (first person / imperative), e.g. 'Show cheaper options', 'Only waterproof ones', 'Compare these two', 'For a gift'.\n" +
  "- Each must move the conversation toward CLARIFYING the shopper's intent: budget/price, a specific attribute, use-case/occasion, brand, comparison, or category.\n" +
  "- Ground them in the assistant's last reply and the profile. No generic 'Tell me more' / 'Thanks'.\n" +
  "- Any price you mention MUST use the store's currency symbol (given in the prompt) and realistic amounts from the reply/profile — never assume dollars.\n" +
  "- Distinct from each other.";

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹", USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "CA$", AUD: "A$", AED: "د.إ", SGD: "S$",
};

export async function suggestFollowups(args: {
  userMessage: string;
  assistantResponse: string;
  profile?: IntentProfile | null;
  currency?: string;
  shop?: string;
}): Promise<string[]> {
  const p = args.profile;
  const profileHint = p
    ? `Profile: ${p.intentNarrative}; priceCeiling=${p.priceCeiling ?? "?"}; attributes=${(p.attributePriorities ?? []).join(",")}; categories=${(p.categoriesViewed ?? []).map((c) => c.category).join(",")}; recentSearches=${(p.recentSearches ?? []).join(",")}`
    : "Profile: (none yet)";
  try {
    const out = await toolCall<{ followups: string[] }>({
      model: HAIKU,
      system: SYSTEM,
      user:
        `Store currency: ${args.currency ?? "unknown"} (symbol: ${CURRENCY_SYMBOLS[args.currency ?? ""] ?? args.currency ?? "unknown"})\n` +
        `Shopper's last message: ${args.userMessage}\n\nAssistant replied:\n${args.assistantResponse}\n\n${profileHint}`,
      toolName: "suggest_followups",
      toolDescription: "Record 3 short intent-clarifying follow-up suggestions.",
      maxTokens: 200,
      shop: args.shop,
      schema: {
        properties: { followups: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } },
        required: ["followups"],
      },
    });
    return (out.followups ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
  } catch {
    return []; // never block the turn on follow-ups
  }
}
