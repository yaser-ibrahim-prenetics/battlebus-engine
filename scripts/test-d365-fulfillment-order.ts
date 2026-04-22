/**
 * Test a direct THK D365 fulfilment API call for a known order.
 *
 * Usage:
 *   npx tsx scripts/test-d365-fulfillment-order.ts
 *
 * Optional overrides:
 *   D365_TEST_ORDER_NUMBER=H007-SO-101902
 *   D365_TEST_DATA_AREA_ID=H007
 *   D365_TEST_TRACKING=LOCAL-TEST-H007-101902
 *   D365_TEST_LINE1_ITEM=IM8-FG-000031
 *   D365_TEST_LINE1_LOT=H007-339177
 *   D365_TEST_LINE2_ITEM=IM8-FG-000011
 *   D365_TEST_LINE2_LOT=H007-339178
 */

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });

type TokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

async function getAccessToken(): Promise<string> {
  const tenantId = required("D365_TENANT_ID");
  const clientId = required("D365_CLIENT_ID");
  const clientSecret = required("D365_CLIENT_SECRET");
  const baseUrl = required("D365_BASE_URL");

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: `${baseUrl}/.default`,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `D365 auth failed (${response.status}): ${payload.error || "unknown"} ${payload.error_description || ""}`.trim()
    );
  }
  return payload.access_token;
}

async function main() {
  const baseUrl = required("D365_BASE_URL");
  const dataAreaId = process.env.D365_TEST_DATA_AREA_ID || "H007";
  const salesOrderNumber = process.env.D365_TEST_ORDER_NUMBER || "H007-SO-101902";
  const trackingNumber = process.env.D365_TEST_TRACKING || "LOCAL-TEST-H007-101902";
  const confirmedShippedDate = new Date().toISOString().split("T")[0];

  const line1Item = process.env.D365_TEST_LINE1_ITEM || "IM8-FG-000031";
  const line1Lot = process.env.D365_TEST_LINE1_LOT || "H007-339177";
  const line2Item = process.env.D365_TEST_LINE2_ITEM || "IM8-FG-000011";
  const line2Lot = process.env.D365_TEST_LINE2_LOT || "H007-339178";

  const endpoint = `${baseUrl}/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/fulfilment`;
  const requestBody = {
    _dataContract: {
      DataAreaId: dataAreaId,
      Type: "shipment",
      D365FOSalesOrder: salesOrderNumber,
      ConfirmedShippedDate: confirmedShippedDate,
      Lines: [
        {
          ItemNumber: line1Item,
          Quantity: 1,
          Site: "Prenetics",
          TrackingNumber: trackingNumber,
          Lotid: line1Lot,
        },
        {
          ItemNumber: line2Item,
          Quantity: 1,
          Site: "Prenetics",
          TrackingNumber: trackingNumber,
          Lotid: line2Lot,
        },
      ],
    },
  };

  console.log("=== D365 Fulfilment Test ===");
  console.log(
    JSON.stringify(
      {
        endpoint,
        dataAreaId,
        salesOrderNumber,
        confirmedShippedDate,
      },
      null,
      2
    )
  );
  console.log("\nRequest Body:");
  console.log(JSON.stringify(requestBody, null, 2));

  const accessToken = await getAccessToken();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await response.text();
  let parsedResponse: unknown = responseText;
  try {
    parsedResponse = JSON.parse(responseText);
  } catch {
    // Keep raw text if not JSON.
  }

  console.log("\nResponse:");
  console.log(
    JSON.stringify(
      {
        ok: response.ok,
        httpStatus: response.status,
        body: parsedResponse,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("\nTest failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
