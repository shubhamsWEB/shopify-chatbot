// IntentProfile persistence — Postgres is the single store (durable + dashboard
// source + per-turn reads). Neon roundtrip is a few ms; no cache layer needed.
import prisma from "../db.server";
import type { IntentProfile } from "./events";

export async function writeProfile(shopId: string, profileKey: string, profile: IntentProfile) {
  await prisma.intentProfile.upsert({
    where: { shopId_profileKey: { shopId, profileKey } },
    create: {
      shopId,
      profileKey,
      sessionId: profile.sessionId,
      customerId: profile.customerId,
      narrative: profile.intentNarrative,
      profile: profile as object,
      conversionLikelihood: profile.conversionLikelihood,
      eventsConsidered: profile.eventsConsidered,
      computeTier: profile.computeTier,
    },
    update: {
      sessionId: profile.sessionId,
      customerId: profile.customerId,
      narrative: profile.intentNarrative,
      profile: profile as object,
      conversionLikelihood: profile.conversionLikelihood,
      eventsConsidered: profile.eventsConsidered,
      computeTier: profile.computeTier,
    },
  });
}

export async function readProfile(shopId: string, profileKey: string): Promise<IntentProfile | null> {
  const row = await prisma.intentProfile.findUnique({
    where: { shopId_profileKey: { shopId, profileKey } },
  });
  return row ? (row.profile as unknown as IntentProfile) : null;
}
