import { Inngest } from "inngest";
import { realtimeMiddleware } from "@inngest/realtime/middleware";
import { channel } from "@inngest/realtime";

// Define typed channels for realtime updates
// Order processing channel - scoped by order name for security
export const orderChannel = channel<{
  // Status updates during order processing
  status: {
    orderName: string;
    step: string;
    status: "running" | "completed" | "failed" | "skipped";
    message?: string;
    data?: Record<string, unknown>;
    timestamp: string;
  };
  // Final result when processing completes
  result: {
    orderName: string;
    status: "success" | "failed" | "skipped";
    d365OrderNumber?: string;
    warehouse?: string;
    error?: string;
    timestamp: string;
  };
}>("order");

// Create the Inngest client with realtime middleware
export const inngest = new Inngest({
  id: "im8-battle-bus",
  name: "IM8 Battle Bus",
  middleware: [realtimeMiddleware()],
});
