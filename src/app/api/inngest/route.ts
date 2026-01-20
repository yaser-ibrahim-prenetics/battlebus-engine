// ============================================================================
// INNGEST API ROUTE
// ============================================================================
// This route serves the Inngest Dev Server and handles function invocations

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

// Create and export the Inngest serve handler
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
