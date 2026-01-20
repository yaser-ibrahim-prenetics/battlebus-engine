// ============================================================================
// DYNAMICS 365 API CLIENT
// ============================================================================
// Extracted from spock-store src/component/dynamics.ts
// Refactored for stateless execution with Inngest

import { config } from "../config";
import type {
  D365AuthToken,
  D365SalesOrderHeader,
  D365SalesOrderLine,
  D365PrepaymentRequest,
  D365FulfilmentRequest,
} from "../types/dynamics";

// Token cache (in-memory, will refresh on cold starts)
let tokenCache: D365AuthToken | null = null;

/**
 * Authenticate with D365 using OAuth2 client credentials
 */
export async function authenticate(): Promise<D365AuthToken> {
  // Check if we have a valid cached token
  if (tokenCache && tokenCache.expires_at && Date.now() < tokenCache.expires_at - 60000) {
    return tokenCache;
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.dynamics.tenantId}/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.dynamics.clientId,
    client_secret: config.dynamics.clientSecret,
    resource: config.dynamics.resource,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`D365 authentication failed: ${response.status} - ${error}`);
  }

  const token: D365AuthToken = await response.json();
  token.expires_at = Date.now() + token.expires_in * 1000;
  tokenCache = token;

  return token;
}

/**
 * Create a Sales Order Header in D365
 */
export async function createSalesOrderHeader(
  header: D365SalesOrderHeader
): Promise<{ SalesOrderNumber: string }> {
  const token = await authenticate();
  const url = `${config.dynamics.baseUrl}/data/SalesOrderHeadersV2`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
    body: JSON.stringify(header),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create D365 sales order header: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Create a Sales Order Line in D365
 */
export async function createSalesOrderLine(
  line: D365SalesOrderLine
): Promise<{ LineNumber: number }> {
  const token = await authenticate();
  const url = `${config.dynamics.baseUrl}/data/SalesOrderLines`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
    body: JSON.stringify(line),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create D365 sales order line: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Confirm a Sales Order in D365
 */
export async function confirmSalesOrder(
  dataAreaId: string,
  salesOrderNumber: string
): Promise<void> {
  const token = await authenticate();
  const url = `${config.dynamics.baseUrl}/data/SalesOrderHeadersV2(dataAreaId='${dataAreaId}',SalesOrderNumber='${salesOrderNumber}')/Microsoft.Dynamics.DataEntities.ConfirmSalesOrder`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to confirm D365 sales order: ${response.status} - ${error}`);
  }
}

/**
 * Create a Prepayment for a Sales Order
 */
export async function createPrepayment(
  prepayment: D365PrepaymentRequest
): Promise<void> {
  const token = await authenticate();
  const url = `${config.dynamics.baseUrl}/data/SalesOrderPrepayments`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
    body: JSON.stringify(prepayment),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create D365 prepayment: ${response.status} - ${error}`);
  }
}

/**
 * Create a Fulfilment (Packing Slip) in D365
 */
export async function createFulfilment(
  fulfilment: D365FulfilmentRequest
): Promise<void> {
  const token = await authenticate();
  const url = `${config.dynamics.baseUrl}/data/SalesOrderPackingSlips`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
    body: JSON.stringify(fulfilment),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create D365 fulfilment: ${response.status} - ${error}`);
  }
}

/**
 * Get Sales Order by Shopify Order ID
 */
export async function getSalesOrderByShopifyId(
  shopifyOrderId: string,
  dataAreaId: string = config.dynamics.dataAreaId
): Promise<D365SalesOrderHeader | null> {
  const token = await authenticate();
  const url = `${config.dynamics.baseUrl}/data/SalesOrderHeadersV2?$filter=dataAreaId eq '${dataAreaId}' and IM8ShopifyOrderId eq '${shopifyOrderId}'`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get D365 sales order: ${response.status} - ${error}`);
  }

  const result = await response.json();
  return result.value?.[0] || null;
}
