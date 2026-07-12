// The only file you touch to add a series: import the campaign and list it.
import type { Campaign } from "./types";
import { onboarding } from "./campaigns/onboarding";
import { limitReached } from "./campaigns/limitReached";
import { newFeature } from "./campaigns/newFeature";

export const campaigns: Campaign[] = [onboarding, limitReached, newFeature];
