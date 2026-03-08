// ============================================================================
// EXTENSIV (3PL CENTRAL) API CLIENT
// ============================================================================
// Handles authentication and API calls to Extensiv warehouse management system

import { config } from "../config";
import * as crypto from "crypto";

type ExtensivWarehouseName = "Charlotte Warehouse";

interface AuthToken {
  token: string;
  expiresAt: number;
}

interface ExtensivOrderItem {
  itemIdentifier: { sku: string };
  qty: number;
}

interface ExtensivAddress {
  companyName: string;
  name: string;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phoneNumber: string;
  emailAddress: string;
}

export interface ExtensivOrderRequest {
  referenceNum: string;
  shippingAddress: ExtensivAddress;
  orderItems: ExtensivOrderItem[];
  billingCode?: string;
  routingInfo: { carrier: string; mode: string };
}

export interface ExtensivOrderConfirm {
  referenceNum: string;
  readOnly: {
    orderId: number;
    customerIdentifier: { id: number; name: string };
    facilityIdentifier: { id: number; name: string };
    createdByIdentifier: { id: number; name: string };
  };
  routingInfo: {
    carrier: string;
    mode: string;
    trackingNumber: string;
  };
}

export interface ExtensivReceiverConfirm {
  referenceNum: string;
  readOnly: {
    receiverId: number;
    customerIdentifier: { id: number; name: string };
    facilityIdentifier: { id: number; name: string };
  };
}

export interface ExtensivEvent {
  tplId: string;
  wmsEventId: string;
  dateTime: string;
  eventType: "OrderConfirm" | "ReceiverConfirm" | "InventorySummaryUpdate";
  resource: {
    rel: string;
    href: string;
    body: ExtensivOrderConfirm | ExtensivReceiverConfirm;
  };
}

// Token cache per warehouse
const tokenCache: Record<string, AuthToken> = {};

function getWarehouseConfig(warehouse: ExtensivWarehouseName) {
  if (warehouse === "Charlotte Warehouse") {
    return config.extensiv.warehouse.charlotte;
  }
  throw new Error(`Unknown Extensiv warehouse: ${warehouse}`);
}

export async function authenticate(warehouse: ExtensivWarehouseName): Promise<AuthToken> {
  if (!config.extensiv.enabled) {
    console.log("[Extensiv] Integration disabled, returning mock token");
    return { token: "MOCK_ACCESS_TOKEN", expiresAt: Date.now() + 3600000 };
  }

  const warehouseConfig = getWarehouseConfig(warehouse);
  const { grantType, clientId, clientSecret, userLoginId } = warehouseConfig;

  console.log(`[Extensiv] Authenticating for ${warehouse}`);

  const response = await fetch(`${config.extensiv.baseUrl}/AuthServer/api/Token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: JSON.stringify({
      grant_type: grantType,
      user_login_id: userLoginId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`[Extensiv] Authentication failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const token: AuthToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 60000, // Subtract 1 min buffer
  };

  tokenCache[warehouse] = token;
  console.log(`[Extensiv] Got token expiring at ${new Date(token.expiresAt).toISOString()}`);

  return token;
}

async function getAuthToken(warehouse: ExtensivWarehouseName): Promise<string> {
  const cached = tokenCache[warehouse];
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const newToken = await authenticate(warehouse);
  return newToken.token;
}

export async function getWebhookPublicKey(): Promise<string> {
  if (!config.extensiv.enabled) {
    console.log("[Extensiv] Integration disabled, returning mock public key");
    return `-----BEGIN PUBLIC KEY-----
MF4wDQYJKoZIhvcNAQEBBQADTQAwSgJDAm77j/QXt+8a3qIRDjEIU9C6Q8bdgYLs
gbW1qRvoCta00H37/6TT3vuttxhjE2kF5uN8lE8ZbCWCKdBk0XlB/nHCpwIDAQAB
-----END PUBLIC KEY-----`;
  }

  console.log("[Extensiv] Fetching webhook public key");

  const response = await fetch(`${config.extensiv.baseUrl}/events/webhook/key`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`[Extensiv] Failed to get webhook key: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.publicKey;
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  publicKey: string
): boolean {
  if (config.extensiv.disableWebhookVerification) {
    console.warn("[Extensiv] Webhook verification disabled");
    return true;
  }

  try {
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(payload);
    return verifier.verify(publicKey, signature, "base64");
  } catch (error) {
    console.error("[Extensiv] Signature verification error:", error);
    return false;
  }
}

export async function createOrder(
  request: ExtensivOrderRequest,
  warehouse: ExtensivWarehouseName
): Promise<{ response: { ReadOnly: { OrderId: string } }; request: object }> {
  const warehouseConfig = getWarehouseConfig(warehouse);

  const body = {
    customerIdentifier: { id: warehouseConfig.customerIdentifier },
    facilityIdentifier: { id: warehouseConfig.facilityIdentifier },
    referenceNum: request.referenceNum,
    poNum: request.referenceNum,
    shipTo: request.shippingAddress,
    orderItems: request.orderItems,
    BillingCode: request.billingCode,
    RoutingInfo: {
      Carrier: request.routingInfo.carrier,
      Mode: request.routingInfo.mode,
    },
  };

  console.log(`[Extensiv] Creating order ${request.referenceNum}`);

  if (!config.extensiv.enabled) {
    console.log("[Extensiv] Integration disabled, returning mock response");
    return {
      response: { ReadOnly: { OrderId: `MOCK_ORDER_ID_${Date.now()}` } },
      request: body,
    };
  }

  const token = await getAuthToken(warehouse);

  const response = await fetch(`${config.extensiv.baseUrl}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`[Extensiv] Failed to create order: ${response.status} - ${error}`);
  }

  const data = await response.json();
  console.log(`[Extensiv] Order created: ${data.ReadOnly?.OrderId}`);

  return { response: data, request: body };
}

export async function createReturnTransaction(
  referenceNum: string,
  receiveItems: Array<{ itemIdentifier: { sku: string }; qty: number }>,
  warehouse: ExtensivWarehouseName
): Promise<{ response: any; request: object }> {
  const warehouseConfig = getWarehouseConfig(warehouse);

  const body = {
    customerIdentifier: { id: warehouseConfig.customerIdentifier },
    facilityIdentifier: { id: warehouseConfig.facilityIdentifier },
    isReturn: true,
    deferNotification: false,
    referenceNum,
    ReceiveItems: receiveItems.map((item) => ({
      ...item,
      ExpirationDate: new Date().toISOString(),
      LotNumber: "Return",
    })),
  };

  console.log(`[Extensiv] Creating return transaction ${referenceNum}`);

  if (!config.extensiv.enabled) {
    console.log("[Extensiv] Integration disabled, returning mock response");
    return {
      response: {
        ReadOnly: { ReceiverId: `MOCK_RECEIVER_ID_${Date.now()}` },
        ReceiveItems: receiveItems.map((item) => ({
          ReadOnly: { ReceiveItemId: `MOCK_ITEM_${Date.now()}` },
          ItemIdentifier: { Sku: item.itemIdentifier.sku },
        })),
      },
      request: body,
    };
  }

  const token = await getAuthToken(warehouse);

  const response = await fetch(`${config.extensiv.baseUrl}/inventory/receivers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`[Extensiv] Failed to create return: ${response.status} - ${error}`);
  }

  const data = await response.json();
  console.log(`[Extensiv] Return transaction created: ${data.ReadOnly?.ReceiverId}`);

  return { response: data, request: body };
}

export function parseWebhookEvent(body: unknown): ExtensivEvent {
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString()) as ExtensivEvent;
  }
  return body as ExtensivEvent;
}
