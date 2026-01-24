// ============================================================================
// DYNAMICS 365 API CLIENT
// ============================================================================
// Ported from spock-store src/component/integration/dynamics.ts
// Uses THK custom API endpoints (not generic OData)

import { config } from "../config";
import type {
  D365AuthToken,
  D365SalesOrderHeader,
  D365SalesOrderLine,
  D365PrepaymentRequest,
  D365FulfilmentRequest,
  D365ThkApiResponse,
  D365SalesOrderHeaderV3Request,
  D365SalesOrderLineRequest,
  D365FulfilmentLine,
  D365SalesOrderHeaderV3RequestForReturn,
  D365SalesOrderLineForReturn,
} from "../types/dynamics";

// Token cache (in-memory, will refresh on cold starts)
let tokenCache: D365AuthToken | null = null;

// THK API success status code
export const DYNAMICS_THK_API_SUCCESS_STATUS = 1;

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Authenticate with D365 using OAuth2 client credentials
 * Ported from spock-store integration/dynamics.ts
 */
export async function authenticate(): Promise<D365AuthToken> {
  // Check if we have a valid cached token
  if (
    tokenCache &&
    tokenCache.expires_at &&
    Date.now() < tokenCache.expires_at - 60000
  ) {
    return tokenCache;
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.dynamics.tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.dynamics.clientId,
    client_secret: config.dynamics.clientSecret,
    scope: config.dynamics.scope,
  });

  console.log(`[D365] Authenticating to ${tokenUrl}`);

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

  console.log(`[D365] Authentication successful, token expires in ${token.expires_in}s`);

  return token;
}

async function getAuthToken(): Promise<string> {
  const token = await authenticate();
  return token.access_token;
}

// ============================================================================
// SALES ORDER HEADER (V3 API)
// ============================================================================

/**
 * Create a Sales Order Header in D365 using SalesOrderHeadersV3
 * Ported from spock-store - uses THK custom fields
 */
export async function createSalesOrderHeaderV3(
  req: D365SalesOrderHeaderV3Request
): Promise<{ SalesOrderNumber: string; request: object }> {
  const {
    shippingAddress,
    billingAddress,
    customerId,
    orderId,
    dataAreaId,
    orderingCustomerAccountNumber,
    defaultLedgerDimensionDisplayValue,
    customerOrderReference,
    email,
    name,
    shopifyReference,
    comment,
    shippingWarehouseId,
    currency,
    paymentId,
    skipFulfillmentNotification,
  } = req;

  const body = {
    SalesOrderPoolId: "D2C",
    DefaultShippingSiteId: "Prenetics",
    CurrencyCode: currency ?? "USD",
    OrderingCustomerAccountNumber: orderingCustomerAccountNumber,
    DefaultLedgerDimensionDisplayValue: defaultLedgerDimensionDisplayValue,
    dataAreaId,
    CustomersOrderReference: customerOrderReference,
    // THK Custom Fields
    THK_ShopifyReference: shopifyReference,
    THK_ShopifyCustName: name,
    THK_ShopifyCustomerEmail: email,
    THK_BillingName: billingAddress?.addressLine,
    THK_BillingAddressCountryRegionId: billingAddress?.addressCountryCode,
    THK_BillingAddressZipCode: billingAddress?.addressZipCode,
    THK_BillingAddressStreet: billingAddress?.addressStreet,
    THK_BillingAddressCity: billingAddress?.addressCity,
    THK_ShopifyCustomerPhonenum: billingAddress?.addressPhone,
    THK_Comments: comment,
    THK_ShopifyPaymentReference: paymentId,
    // Delivery Address
    DeliveryAddressName: shippingAddress?.addressName,
    DeliveryAddressDescription: shippingAddress?.addressLine,
    DeliveryAddressCountryRegionId: shippingAddress?.addressCountryCode,
    DeliveryAddressZipCode: shippingAddress?.addressZipCode,
    DeliveryAddressStreet: shippingAddress?.addressStreet,
    DeliveryAddressCity: shippingAddress?.addressCity,
    ...(shippingWarehouseId
      ? { DefaultShippingWarehouseId: shippingWarehouseId }
      : {}),
    ...(skipFulfillmentNotification
      ? { THK_SkipFulfillmentNotification: skipFulfillmentNotification }
      : {}),
  };

  console.log(`[D365] Creating sales order header: ${JSON.stringify(body)}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would create sales order for ${orderId}`);
    return {
      SalesOrderNumber: `DRY-RUN-${Date.now()}`,
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/data/SalesOrderHeadersV3`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to create sales order header for ${orderId}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] Created sales order: ${result.SalesOrderNumber}`);

  return {
    SalesOrderNumber: result.SalesOrderNumber,
    request: body,
  };
}

// ============================================================================
// SALES ORDER LINE
// ============================================================================

/**
 * Create a Sales Order Line in D365
 * Ported from spock-store
 */
export async function createSalesOrderLine(
  req: D365SalesOrderLineRequest
): Promise<{ InventoryLotId: string; request: object }> {
  const {
    giftCardNumber,
    salesOrderNumber,
    discount,
    quantity,
    itemNumber,
    price,
    dataAreaId,
    shippingWarehouseId,
    currency,
    countryCode,
    discountCode,
  } = req;

  const body = {
    dataAreaId,
    CurrencyCode: currency ?? "USD",
    SalesOrderNumber: salesOrderNumber,
    ItemNumber: itemNumber,
    OrderedSalesQuantity: quantity,
    SalesPrice: price,
    LineDiscountAmount: discount,
    THK_DiscountType: giftCardNumber,
    THK_PromotionCode: discountCode && discountCode.length > 0 ? discountCode[0] : "",
    ...(shippingWarehouseId ? { ShippingWarehouseId: shippingWarehouseId } : {}),
  };

  console.log(`[D365] Creating sales order line: ${JSON.stringify(body)}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would create line for ${salesOrderNumber}`);
    return {
      InventoryLotId: `DRY-RUN-LOT-${Date.now()}`,
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/data/SalesOrderLines`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to create sales order line ${itemNumber} for ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] Created sales order line with lot ID: ${result.InventoryLotId}`);

  return {
    InventoryLotId: result.InventoryLotId,
    request: body,
  };
}

// ============================================================================
// RETURN SALES ORDER FUNCTIONS
// ============================================================================

/**
 * Create a Return Sales Order Header in D365 using SalesOrderHeadersV3
 */
export async function createSalesOrderHeadersV3ForReturn(
  req: D365SalesOrderHeaderV3RequestForReturn
): Promise<{ SalesOrderNumber: string; request: object }> {
  const {
    customerId,
    orderId,
    dataAreaId,
    orderingCustomerAccountNumber,
    defaultLedgerDimensionDisplayValue,
    customerOrderReference,
    email,
    name,
    shopifyReference,
  } = req;

  const body = {
    SalesOrderPoolId: "Return",
    DefaultShippingSiteId: "Prenetics",
    CurrencyCode: "USD",
    OrderingCustomerAccountNumber: orderingCustomerAccountNumber,
    DefaultLedgerDimensionDisplayValue: defaultLedgerDimensionDisplayValue,
    dataAreaId,
    CustomersOrderReference: customerOrderReference,
    THK_ShopifyReference: shopifyReference,
    THK_ShopifyCustName: name,
    THK_ShopifyCustomerEmail: email,
  };

  console.log(
    `[D365] Creating return sales order header: ${JSON.stringify(body)}`
  );

  if (config.features.dryRunMode) {
    console.log(
      `[D365] DRY RUN - Would create return sales order for ${orderId}`
    );
    return {
      SalesOrderNumber: `DRY-RUN-RETURN-${Date.now()}`,
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/data/SalesOrderHeadersV3`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to create return sales order header for ${orderId}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] Created return sales order: ${result.SalesOrderNumber}`);

  return {
    SalesOrderNumber: result.SalesOrderNumber,
    request: body,
  };
}

/**
 * Create a Return Sales Order Line in D365
 */
export async function createSalesOrderLineForReturn(
  req: D365SalesOrderLineForReturn
): Promise<{ InventoryLotId: string; request: object }> {
  const {
    salesOrderNumber,
    quantity,
    itemNumber,
    price,
    discount,
    dataAreaId,
    inventTransIdReturn,
    shippingSiteId,
  } = req;

  const body = {
    dataAreaId,
    CurrencyCode: "USD",
    SalesOrderNumber: salesOrderNumber,
    ItemNumber: itemNumber,
    OrderedSalesQuantity: quantity,
    SalesPrice: price,
    LineDiscountAmount: discount,
    InventTransIdReturn: inventTransIdReturn,
    ShippingSiteId: shippingSiteId,
  };

  console.log(
    `[D365] Creating return sales order line: ${JSON.stringify(body)}`
  );

  if (config.features.dryRunMode) {
    console.log(
      `[D365] DRY RUN - Would create return line for ${salesOrderNumber}`
    );
    return {
      InventoryLotId: `DRY-RUN-RETURN-LOT-${Date.now()}`,
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/data/SalesOrderLines`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to create return sales order line ${itemNumber} for ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(
    `[D365] Created return sales order line with lot ID: ${result.InventoryLotId}`
  );

  return {
    InventoryLotId: result.InventoryLotId,
    request: body,
  };
}

// ============================================================================
// THK CUSTOM API ENDPOINTS
// ============================================================================

/**
 * Confirm a Sales Order using THK API
 * Ported from spock-store - uses THK_APISyncServiceGroup endpoint
 */
export async function confirmSalesOrder(
  salesOrderNumber: string,
  dataAreaId: string
): Promise<{ response: D365ThkApiResponse; request: object }> {
  const body = {
    _dataContract: {
      DataAreaId: dataAreaId,
      SalesId: salesOrderNumber,
    },
  };

  console.log(`[D365] Confirming sales order: ${salesOrderNumber}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would confirm ${salesOrderNumber}`);
    return {
      response: {
        status: DYNAMICS_THK_API_SUCCESS_STATUS,
        Message: "DRY RUN SUCCESS",
        Result: "DRY_RUN_RESULT",
        $id: "DRY_RUN_ID",
      },
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/confirmSO`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to confirm sales order ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result: D365ThkApiResponse = await response.json();

  if (result.status !== DYNAMICS_THK_API_SUCCESS_STATUS) {
    throw new Error(
      `[D365] THK API failed to confirm ${salesOrderNumber}: ${result.Message}`
    );
  }

  console.log(`[D365] Confirmed sales order: ${salesOrderNumber}`);

  return { response: result, request: body };
}

/**
 * Create Prepayment using THK API
 * Ported from spock-store - uses THK_APISyncServiceGroup endpoint
 */
export async function createPrepayment(
  salesOrderNumber: string,
  dataAreaId: string
): Promise<{ response: D365ThkApiResponse; request: object }> {
  const body = {
    _dataContract: {
      DataAreaId: dataAreaId,
      SalesId: salesOrderNumber,
    },
  };

  console.log(`[D365] Creating prepayment for: ${salesOrderNumber}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would create prepayment for ${salesOrderNumber}`);
    return {
      response: {
        status: DYNAMICS_THK_API_SUCCESS_STATUS,
        Message: "DRY RUN SUCCESS",
        Result: "DRY_RUN_RESULT",
        $id: "DRY_RUN_ID",
      },
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/PostPrepayment`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to create prepayment for ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result: D365ThkApiResponse = await response.json();

  if (result.status !== DYNAMICS_THK_API_SUCCESS_STATUS) {
    throw new Error(
      `[D365] THK API failed to create prepayment for ${salesOrderNumber}: ${result.Message}`
    );
  }

  console.log(`[D365] Created prepayment for: ${salesOrderNumber}`);

  return { response: result, request: body };
}

/**
 * Create Fulfilment (Packing Slip) using THK API
 * Ported from spock-store - uses THK_APISyncServiceGroup endpoint
 */
export async function createFulfilment(
  req: D365FulfilmentRequest
): Promise<{ response: D365ThkApiResponse; request: object }> {
  const { salesOrderNumber, dataAreaId, lines, type, confirmedShippedDate } = req;

  const body = {
    _dataContract: {
      DataAreaId: dataAreaId,
      Type: type,
      D365FOSalesOrder: salesOrderNumber,
      ConfirmedShippedDate: confirmedShippedDate,
      Lines: lines.map((line) => {
        const lineData: Record<string, unknown> = {
          ItemNumber: line.itemNumber,
          Quantity: line.quantity,
          Site: line.shippingSiteId,
          TrackingNumber: line.trackingNumber,
          Lotid: line.lotId,
        };

        if (line.shippingWarehouseId && line.shippingWarehouseLocationId) {
          // U001 (US) doesn't use warehouse/location in fulfilment
          if (dataAreaId === "U001") {
            lineData["Warehouse"] = "";
            lineData["Location"] = "";
          } else {
            lineData["Warehouse"] = line.shippingWarehouseId;
            lineData["Location"] = line.shippingWarehouseLocationId;
          }
        }

        return lineData;
      }),
    },
  };

  console.log(`[D365] Creating fulfilment for: ${salesOrderNumber}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would create fulfilment for ${salesOrderNumber}`);
    return {
      response: {
        status: DYNAMICS_THK_API_SUCCESS_STATUS,
        Message: "DRY RUN SUCCESS",
        Result: "DRY_RUN_RESULT",
        $id: "DRY_RUN_ID",
      },
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/fulfilment`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to create fulfilment for ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result: D365ThkApiResponse = await response.json();

  if (result.status !== DYNAMICS_THK_API_SUCCESS_STATUS) {
    throw new Error(
      `[D365] THK API failed to create fulfilment for ${salesOrderNumber}: ${result.Message}`
    );
  }

  console.log(`[D365] Created fulfilment for: ${salesOrderNumber}`);

  return { response: result, request: body };
}

// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

/**
 * Get Sales Order by Shopify Order ID
 */
export async function getSalesOrderByShopifyId(
  shopifyOrderId: string,
  dataAreaId: string = config.dynamics.dataAreaId
): Promise<D365SalesOrderHeader | null> {
  console.log(`[D365] Looking up order by Shopify ID: ${shopifyOrderId}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would look up ${shopifyOrderId}`);
    return null;
  }

  const token = await getAuthToken();
  const filter = `dataAreaId eq '${dataAreaId}' and THK_ShopifyReference eq '${shopifyOrderId}'`;
  const url = `${config.dynamics.baseUrl}/data/SalesOrderHeadersV3?$filter=${encodeURIComponent(filter)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`[D365] Failed to get sales order: ${response.status} - ${error}`);
  }

  const result = await response.json();
  const order = result.value?.[0] || null;

  if (order) {
    console.log(`[D365] Found order: ${order.SalesOrderNumber}`);
  } else {
    console.log(`[D365] No order found for Shopify ID: ${shopifyOrderId}`);
  }

  return order;
}

/**
 * Get Sales Order Lines by Sales Order Number
 */
export async function getSalesOrderLines(
  salesOrderNumber: string,
  dataAreaId: string = config.dynamics.dataAreaId
): Promise<D365SalesOrderLine[]> {
  console.log(
    `[D365] Getting lines for sales order: ${salesOrderNumber} (${dataAreaId})`
  );

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would get lines for ${salesOrderNumber}`);
    return [];
  }

  const token = await getAuthToken();
  const filter = `dataAreaId eq '${dataAreaId}' and SalesOrderNumber eq '${salesOrderNumber}'`;
  const url = `${
    config.dynamics.baseUrl
  }/data/SalesOrderLines?$filter=${encodeURIComponent(filter)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to get sales order lines: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  const lines = result.value || [];
  console.log(`[D365] Found ${lines.length} lines for ${salesOrderNumber}`);

  return lines;
}

// ============================================================================
// LEGACY EXPORTS (for backwards compatibility)
// ============================================================================

// Alias for the old function name
export const createSalesOrderHeader = createSalesOrderHeaderV3;
