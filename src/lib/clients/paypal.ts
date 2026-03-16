// ============================================================================
// PAYPAL TRACKING API CLIENT
// ============================================================================
// Ported from spock-store src/component/integration/paypal.ts
// Pushes tracking numbers to PayPal for seller protection

import { config } from "../config";

// ============================================================================
// TYPES
// ============================================================================

interface PayPalAuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
}

interface PayPalTracker {
  transaction_id: string;
  tracking_number: string;
  status: "SHIPPED";
  carrier?: string;
  carrier_name_other?: string;
}

interface PayPalTrackerBatchRequest {
  trackers: PayPalTracker[];
}

interface PayPalTrackerResult {
  transaction_id: string;
  tracking_number: string;
  status: string;
  errors?: Array<{ name: string; message: string }>;
}

export interface PayPalBatchResponse {
  tracker_identifiers: PayPalTrackerResult[];
  errors: Array<{ name: string; message: string; details?: unknown[] }>;
}

// ============================================================================
// TOKEN CACHE
// ============================================================================

let tokenCache: PayPalAuthToken | null = null;

// ============================================================================
// CARRIER MAPPING
// ============================================================================

const CARRIER_MAP: Record<string, string> = {
  fedex: "FEDEX",
  "federal express": "FEDEX",
  ups: "UPS",
  "united parcel service": "UPS",
  usps: "USPS",
  "united states postal service": "USPS",
  dhl: "DHL",
  "dhl express": "DHL",
};

/**
 * Map a carrier name to PayPal's carrier enum.
 * Returns { carrier } for known carriers, or { carrier: "OTHER", carrier_name_other } for unknown.
 */
function mapCarrier(carrierName: string | null | undefined): {
  carrier?: string;
  carrier_name_other?: string;
} {
  if (!carrierName) {
    return { carrier: "OTHER", carrier_name_other: "Unknown" };
  }

  const normalized = carrierName.toLowerCase().trim();
  const mapped = CARRIER_MAP[normalized];

  if (mapped) {
    return { carrier: mapped };
  }

  return { carrier: "OTHER", carrier_name_other: carrierName };
}

// ============================================================================
// BASE URL
// ============================================================================

function getBaseUrl(): string {
  return config.paypal.mode === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Authenticate with PayPal using OAuth2 client credentials.
 * Caches token in-memory with expiry check (60s buffer).
 */
export async function authenticate(): Promise<PayPalAuthToken> {
  // Return cached token if still valid (with 60s buffer)
  if (tokenCache && tokenCache.expires_at && Date.now() < tokenCache.expires_at - 60000) {
    return tokenCache;
  }

  const tokenUrl = `${getBaseUrl()}/v1/oauth2/token`;
  const credentials = Buffer.from(
    `${config.paypal.clientId}:${config.paypal.clientSecret}`
  ).toString("base64");

  console.log(`[PayPal] Authenticating to ${tokenUrl}`);

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`PayPal authentication failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const token: PayPalAuthToken = {
    access_token: data.access_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  tokenCache = token;

  console.log(`[PayPal] Authentication successful, token expires in ${token.expires_in}s`);

  return token;
}

async function getAuthToken(): Promise<string> {
  const token = await authenticate();
  return token.access_token;
}

// ============================================================================
// BATCH TRACKING SYNC
// ============================================================================

/**
 * Push tracking numbers to PayPal via the batch trackers API.
 *
 * @param trackers - Array of { transactionId, trackingNumber, carrierName }
 * @returns PayPal batch response with per-tracker results
 */
export async function syncTrackingBatch(
  trackers: Array<{
    transactionId: string;
    trackingNumber: string;
    carrierName: string | null | undefined;
  }>
): Promise<PayPalBatchResponse> {
  if (trackers.length === 0) {
    return { tracker_identifiers: [], errors: [] };
  }

  const accessToken = await getAuthToken();
  const url = `${getBaseUrl()}/v1/shipping/trackers-batch`;

  const payload: PayPalTrackerBatchRequest = {
    trackers: trackers.map((t) => {
      const carrierInfo = mapCarrier(t.carrierName);
      return {
        transaction_id: t.transactionId,
        tracking_number: t.trackingNumber,
        status: "SHIPPED" as const,
        ...carrierInfo,
      };
    }),
  };

  console.log(
    `[PayPal] Syncing ${trackers.length} tracker(s) to ${url}`,
    trackers.map((t) => ({
      txn: t.transactionId,
      tracking: t.trackingNumber,
      carrier: t.carrierName,
    }))
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`PayPal batch tracking sync failed: ${response.status} - ${error}`);
  }

  const result: PayPalBatchResponse = await response.json();

  console.log(
    `[PayPal] Batch tracking sync complete: ${result.tracker_identifiers?.length || 0} processed, ${result.errors?.length || 0} errors`
  );

  return result;
}

/**
 * Check if PayPal tracking sync is enabled.
 */
export function isEnabled(): boolean {
  return config.paypal.enabled;
}
