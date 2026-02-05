import { Inngest } from "inngest";
import { realtimeMiddleware } from "@inngest/realtime/middleware";

// Create the Inngest client with realtime middleware
export const inngest = new Inngest({
  id: "im8-battle-bus",
  name: "IM8 Battle Bus",
  middleware: [realtimeMiddleware()],
});
