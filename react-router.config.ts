import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

// SSR app; the Vercel preset emits serverless functions for the loaders/actions
// (including /api/chat and /api/ingest). The intent worker runs on a separate host.
export default {
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;
