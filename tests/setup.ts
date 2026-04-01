import { existsSync } from "fs";
import { resolve } from "path";
import { config as loadEnv } from "dotenv";
import { vi } from "vitest";

// Load local secrets for optional integration tests (Supabase, etc.)
const envLocal = resolve(__dirname, "../.env.local");
if (existsSync(envLocal)) {
  loadEnv({ path: envLocal });
}

process.env.ENABLE_DYNAMICS_SYNC = "true";
process.env.ENABLE_GPS_SYNC = "true";
process.env.DRY_RUN_MODE = "false";
process.env.SKIP_TEST_ORDERS = "false";
process.env.SKIP_HIGH_RISK_ORDERS = "false";
process.env.CS_PLATFORM_ENABLED = "false";
process.env.ORDERS_LIVE_DATE = "2020-01-01T00:00:00Z";
process.env.ENABLE_SLACK_RISK_CHECK = "false";
process.env.TAG_WAIT_ENABLED = "false";
process.env.BACKORDER_RETRY_ENABLED = "true";
process.env.BACKORDER_AUTO_RETRY_ENABLED = "false";
