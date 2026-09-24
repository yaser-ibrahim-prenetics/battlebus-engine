import { Inngest } from "inngest";
import { validateConfig } from "@/lib/config";
import { InngestApiRateLimitTerminalMiddleware } from "./middleware/inngest-api-rate-limit-terminal";

// Create the Inngest client with checkpointing below Cloud Run's request timeout.
export const inngest = new Inngest({
  id: "im8-battle-bus",
  name: "IM8 Battle Bus",
  appVersion: process.env.BATTLE_BUS_VERSION || process.env.K_REVISION,
  checkpointing: {
    maxRuntime: "240s",
  },
  middleware: [InngestApiRateLimitTerminalMiddleware],
});

const { valid, errors } = validateConfig();
if (!valid) {
  console.warn("[Config] Configuration warnings:", errors.join(", "));
}
