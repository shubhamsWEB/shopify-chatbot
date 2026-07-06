// Deterministic holdout assignment (spec §12.3): stable per sessionId, ~holdoutPct%.
// Leaf module (no deps) so both hot.server and the engine can use it without a cycle.
import { config } from "./config";

export function isHoldout(sessionId: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100 < config.holdoutPct;
}
