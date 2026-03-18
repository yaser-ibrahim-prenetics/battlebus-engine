import { Inngest } from "inngest";
import { realtimeMiddleware } from "@inngest/realtime/middleware";
import { validateConfig } from "@/lib/config";

// Create the Inngest client with realtime middleware
export const inngest = new Inngest({
  id: "im8-battle-bus",
  name: "IM8 Battle Bus",
  middleware: [realtimeMiddleware()],
});

const { valid, errors } = validateConfig();
if (!valid) {
  console.warn("[Config] Configuration warnings:", errors.join(", "));
}
