// ============================================================================
// INNGEST API ROUTE
// ============================================================================
// This route serves the Inngest Dev Server and handles function invocations

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

// Keep the framework limit aligned with Cloud Run's 300-second request timeout.
// D365 API calls can take 60-90s, so the full window is required.
export const maxDuration = 300;

// Create and export the Inngest serve handler
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
