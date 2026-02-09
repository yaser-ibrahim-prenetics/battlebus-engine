// ============================================================================
// INNGEST API ROUTE
// ============================================================================
// This route serves the Inngest Dev Server and handles function invocations

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

// Increase Vercel function timeout for Inngest (Pro plan: max 300s)
// D365 API calls can take 60-90s, so we need more than the default 60s
export const maxDuration = 300;

// Create and export the Inngest serve handler
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
