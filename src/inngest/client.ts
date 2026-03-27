import { Inngest } from "inngest";
import { validateConfig } from "@/lib/config";

// Create the Inngest client with checkpointing for Vercel (maxDuration=300s)
export const inngest = new Inngest({
  id: "im8-battle-bus",
  name: "IM8 Battle Bus",
  checkpointing: {
    maxRuntime: "240s",
  },
});

const { valid, errors } = validateConfig();
if (!valid) {
  console.warn("[Config] Configuration warnings:", errors.join(", "));
}
