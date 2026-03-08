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
  D365ReturnSalesOrderHeadersV3Request,
  D365ReturnSalesOrderLineRequest,
  D365ReturnOrderInvoiceRequest,
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
  if (tokenCache && tokenCache.expires_at && Date.now() < tokenCache.expires_at - 60000) {
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
    ...(shippingWarehouseId ? { DefaultShippingWarehouseId: shippingWarehouseId } : {}),
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
  const response = await fetch(`${config.dynamics.baseUrl}/data/SalesOrderHeadersV3`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`[D365] ❌ Failed to create sales order header for ${orderId}`);
    console.error(`[D365] Error Status: ${response.status}`);
    console.error(`[D365] Full Error Response: ${error}`);
    console.error(`[D365] Request Payload: ${JSON.stringify(body, null, 2)}`);
    throw new Error(
      `[D365] Failed to create sales order header for ${orderId}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] ✅ Created sales order: ${result.SalesOrderNumber}`);
  console.log(`[D365] Full D365 response: ${JSON.stringify(result, null, 2)}`);
  console.log(`[D365] Request payload: ${JSON.stringify(body, null, 2)}`);

  return {
    SalesOrderNumber: result.SalesOrderNumber,
    request: body,
  };
}

/**
 * Update a Sales Order Header in D365 using SalesOrderHeadersV3
 * Ported from spock-store - uses THK custom fields
 */
export async function updateSalesOrderHeaderV3(
  salesOrderNumber: string,
  req: Partial<D365SalesOrderHeaderV3Request>
): Promise<{ SalesOrderNumber: string; request: object; response: object }> {
  const {
    shippingAddress,
    billingAddress,
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

  // Build the update body - only include fields that are provided
  const body: Record<string, any> = {};

  if (req.orderingCustomerAccountNumber !== undefined)
    body.OrderingCustomerAccountNumber = orderingCustomerAccountNumber;
  if (req.defaultLedgerDimensionDisplayValue !== undefined)
    body.DefaultLedgerDimensionDisplayValue = defaultLedgerDimensionDisplayValue;
  if (req.customerOrderReference !== undefined)
    body.CustomersOrderReference = customerOrderReference;
  if (currency !== undefined) body.CurrencyCode = currency;

  // THK Custom Fields
  if (shopifyReference !== undefined) body.THK_ShopifyReference = shopifyReference;
  if (name !== undefined) body.THK_ShopifyCustName = name;
  if (email !== undefined) body.THK_ShopifyCustomerEmail = email;
  if (comment !== undefined) body.THK_Comments = comment;
  if (paymentId !== undefined) body.THK_ShopifyPaymentReference = paymentId;
  if (skipFulfillmentNotification !== undefined)
    body.THK_SkipFulfillmentNotification = skipFulfillmentNotification;

  // Billing Address
  if (billingAddress) {
    if (billingAddress.addressLine !== undefined) body.THK_BillingName = billingAddress.addressLine;
    if (billingAddress.addressCountryCode !== undefined)
      body.THK_BillingAddressCountryRegionId = billingAddress.addressCountryCode;
    if (billingAddress.addressZipCode !== undefined)
      body.THK_BillingAddressZipCode = billingAddress.addressZipCode;
    if (billingAddress.addressStreet !== undefined)
      body.THK_BillingAddressStreet = billingAddress.addressStreet;
    if (billingAddress.addressCity !== undefined)
      body.THK_BillingAddressCity = billingAddress.addressCity;
    if (billingAddress.addressPhone !== undefined)
      body.THK_ShopifyCustomerPhonenum = billingAddress.addressPhone;
  }

  // Delivery Address
  if (shippingAddress) {
    if (shippingAddress.addressName !== undefined)
      body.DeliveryAddressName = shippingAddress.addressName;
    if (shippingAddress.addressLine !== undefined)
      body.DeliveryAddressDescription = shippingAddress.addressLine;
    if (shippingAddress.addressCountryCode !== undefined)
      body.DeliveryAddressCountryRegionId = shippingAddress.addressCountryCode;
    if (shippingAddress.addressZipCode !== undefined)
      body.DeliveryAddressZipCode = shippingAddress.addressZipCode;
    if (shippingAddress.addressStreet !== undefined)
      body.DeliveryAddressStreet = shippingAddress.addressStreet;
    if (shippingAddress.addressCity !== undefined)
      body.DeliveryAddressCity = shippingAddress.addressCity;
  }

  if (shippingWarehouseId !== undefined) body.DefaultShippingWarehouseId = shippingWarehouseId;

  console.log(`[D365] Updating sales order header ${salesOrderNumber}: ${JSON.stringify(body)}`);
  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would update sales order ${salesOrderNumber}`);
    return {
      SalesOrderNumber: salesOrderNumber,
      request: body,
      response: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/data/SalesOrderHeadersV3(dataAreaId='${dataAreaId}',SalesOrderNumber='${salesOrderNumber}')`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "OData-Version": "4.0",
        "OData-MaxVersion": "4.0",
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to update sales order header ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] Updated sales order: ${salesOrderNumber}`);

  return {
    SalesOrderNumber: salesOrderNumber,
    request: body,
    response: result,
  };
}

/**
 * Cancel a SalesOrder in D365 using SalesOrderHeadersV3
 * Ported from spock-store - uses THK custom fields
 */
export async function deleteSalesOrderHeaderV3(dataAreaId: string, salesOrderNumber: string) {
  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/data/SalesOrderHeadersV3(dataAreaId='${dataAreaId}',SalesOrderNumber='${salesOrderNumber}')`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "OData-Version": "4.0",
        "OData-MaxVersion": "4.0",
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Delete failed: ${response.status} - ${error}`);
  }

  console.log(`Deleted sales order: ${salesOrderNumber}`);
  return true;
}

export async function createReturnSalesOrderHeaderV3(
  req: D365ReturnSalesOrderHeadersV3Request
): Promise<{ SalesOrderNumber: string; request: object }> {
  const {
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
    // THK Custom Fields
    THK_ShopifyReference: shopifyReference,
    THK_ShopifyCustName: name,
    THK_ShopifyCustomerEmail: email,
  };

  console.log(`[D365] Creating return order header: ${JSON.stringify(body)}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would create return order for ${orderId}`);
    return {
      SalesOrderNumber: `DRY-RUN-RETURN-${Date.now()}`,
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(`${config.dynamics.baseUrl}/data/SalesOrderHeadersV3`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to create return order header for ${orderId}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] Created return order: ${result.SalesOrderNumber}`);

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
    ...(discount != null && discount !== undefined && !isNaN(discount)
      ? { LineDiscountAmount: discount }
      : {}),
    THK_DiscountType: giftCardNumber,
    THK_PromotionCode: discountCode && discountCode.length > 0 ? discountCode[0] : "",
    ...(shippingWarehouseId ? { ShippingWarehouseId: shippingWarehouseId } : {}),
    ...(countryCode ? { CountryCode: countryCode } : {}),
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
  const response = await fetch(`${config.dynamics.baseUrl}/data/SalesOrderLines`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

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

/**
 * Create a Return Sales Order Line in D365
 * Ported from spock-store
 */
export async function createReturnSalesOrderLineV3(
  req: D365ReturnSalesOrderLineRequest
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

  console.log(`[D365] Creating return order line: ${JSON.stringify(body)}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would create return line for ${salesOrderNumber}`);
    return {
      InventoryLotId: `DRY-RUN-LOT-${Date.now()}`,
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/data/SalesOrderLines`, // Note: SalesOrderLines, not V3
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
      `[D365] Failed to create return order line for ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] Created return order line: ${result.InventoryLotId} for ${salesOrderNumber}`);

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

  console.log(`[D365] Creating return sales order header: ${JSON.stringify(body)}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would create return sales order for ${orderId}`);
    return {
      SalesOrderNumber: `DRY-RUN-RETURN-${Date.now()}`,
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(`${config.dynamics.baseUrl}/data/SalesOrderHeadersV3`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

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
    ...(discount != null && discount !== undefined && !isNaN(discount)
      ? { LineDiscountAmount: discount }
      : {}),
    InventTransIdReturn: inventTransIdReturn,
    ShippingSiteId: shippingSiteId,
  };

  console.log(`[D365] Creating return sales order line: ${JSON.stringify(body)}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would create return line for ${salesOrderNumber}`);
    return {
      InventoryLotId: `DRY-RUN-RETURN-LOT-${Date.now()}`,
      request: body,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(`${config.dynamics.baseUrl}/data/SalesOrderLines`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[D365] Failed to create return sales order line ${itemNumber} for ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] Created return sales order line with lot ID: ${result.InventoryLotId}`);

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
    throw new Error(`[D365] THK API failed to confirm ${salesOrderNumber}: ${result.Message}`);
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

export async function postReturnOrderInvoice(req: D365ReturnOrderInvoiceRequest) {
  const { salesOrderNumber, dataAreaId, invoiceDate } = req;
  const body = {
    salesOrderNumber,
    dataAreaId,
    invoiceDate: invoiceDate ?? new Date().toISOString().split("T")[0],
  };

  console.log(`[D365] Posting return order invoice: ${JSON.stringify(body)}`);
  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would post invoice for ${salesOrderNumber}`);
    return {
      creditNoteNumber: `DRY-CN-${Date.now()}`,
      success: true,
    };
  }

  const token = await getAuthToken();
  const response = await fetch(
    `${config.dynamics.baseUrl}/api/services/THK_APISyncServiceGroup/THK_SalesOrderService/postReturnOrderInvoice`,
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
      `[D365] Failed to post return invoice for ${salesOrderNumber}: ${response.status} - ${error}`
    );
  }

  const result = await response.json();
  console.log(`[D365] Posted return invoice: ${result.creditNoteNumber}`);
  return {
    creditNoteNumber: result.creditNoteNumber,
    success: true,
  };
}

// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

/**
 * Get Sales Order Lines by Sales Order Number
 * Returns line items with their InventoryLotId for use in fulfillment
 */
export async function getSalesOrderLines(
  salesOrderNumber: string,
  dataAreaId: string = config.dynamics.dataAreaId
): Promise<D365SalesOrderLine[]> {
  console.log(`[D365] Getting sales order lines for: ${salesOrderNumber}`);

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would get lines for ${salesOrderNumber}`);
    return [];
  }

  const token = await getAuthToken();
  const filter = `dataAreaId eq '${dataAreaId}' and SalesOrderNumber eq '${salesOrderNumber}'`;
  const select = "ItemNumber,InventoryLotId,SalesQuantity,SalesPrice,LineDiscountAmount";
  const url = `${config.dynamics.baseUrl}/data/SalesOrderLines?$filter=${encodeURIComponent(filter)}&$select=${select}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`[D365] Failed to get sales order lines: ${response.status} - ${error}`);
  }

  const result = await response.json();
  const lines: D365SalesOrderLine[] = result.value || [];

  console.log(`[D365] Found ${lines.length} lines for ${salesOrderNumber}`);
  if (lines.length > 0) {
    console.log(
      `[D365] Line items with lotIds:`,
      lines.map((l) => ({ item: l.ItemNumber, lotId: l.InventoryLotId }))
    );
  }

  return lines;
}

/**
 * Build a lookup map of ItemNumber -> InventoryLotId for a sales order
 * Useful for fulfillment processing
 */
export async function getLotIdMap(
  salesOrderNumber: string,
  dataAreaId: string = config.dynamics.dataAreaId
): Promise<Record<string, string>> {
  const lines = await getSalesOrderLines(salesOrderNumber, dataAreaId);

  const lotIdMap: Record<string, string> = {};
  for (const line of lines) {
    if (line.ItemNumber && line.InventoryLotId) {
      lotIdMap[line.ItemNumber] = line.InventoryLotId;
    }
  }

  console.log(`[D365] LotId map for ${salesOrderNumber}:`, lotIdMap);
  return lotIdMap;
}

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
    console.log(`[D365] Query used: ${filter}`);
    console.log(`[D365] Response: ${JSON.stringify(result)}`);
  }

  return order;
}

// ============================================================================
// PRODUCT & INVENTORY SYNC (PLACEHOLDER)
// ============================================================================

/**
 * Sync a Shopify product to D365 as a Released Product
 *
 * IMPORTANT: D365 OData API does not support direct product creation.
 * Products must be created through D365 UI or custom D365 services.
 * This function only checks if products exist and logs what would be synced.
 *
 * For actual product creation, use:
 * - D365 Product Information Management UI
 * - Custom D365 service actions (if configured)
 * - D365 Data Management Framework (DMF) packages
 */
export async function syncProduct(product: {
  productId: string;
  title: string;
  variants: {
    sku: string;
    price: string;
    barcode: string | null;
    weight: number;
    weight_unit: string;
  }[];
  vendor: string;
  productType: string;
  tags: string;
  status: string;
}): Promise<{ success: boolean; message: string; d365ItemNumbers?: string[] }> {
  console.log(`[D365] 🔄 syncProduct called for "${product.title}" (${product.productId})`);
  console.log(
    `[D365]   Vendor: ${product.vendor}, Type: ${product.productType}, Status: ${product.status}`
  );
  console.log(`[D365]   Variants: ${product.variants.length}`);
  for (const v of product.variants) {
    console.log(
      `[D365]   - SKU: ${v.sku}, Price: ${v.price}, Barcode: ${v.barcode}, Weight: ${v.weight}${v.weight_unit}`
    );
  }

  if (config.features.dryRunMode) {
    console.log(`[D365] DRY RUN - Would sync product ${product.title}`);
    return {
      success: true,
      message: "DRY RUN - Product sync",
      d365ItemNumbers: product.variants.map((v) => v.sku),
    };
  }

  if (!product.variants || product.variants.length === 0) {
    console.log(`[D365] ⚠️  No variants to sync for product ${product.productId}`);
    return { success: false, message: "No variants to sync", d365ItemNumbers: [] };
  }

  const token = await getAuthToken();
  const dataAreaId = config.dynamics.dataAreaId;
  const baseUrl = config.dynamics.baseUrl;
  const d365ItemNumbers: string[] = [];

  // Process each variant as a separate D365 item
  for (const variant of product.variants) {
    if (!variant.sku || variant.sku.trim() === "") {
      console.log(`[D365] ⚠️  Skipping variant without SKU`);
      continue;
    }

    const itemNumber = variant.sku;
    const productName = product.title || itemNumber;

    try {
      // Check if product already exists using ReleasedProductsV2 (read-only endpoint)
      const checkUrl = `${baseUrl}/data/ReleasedProductsV2?$filter=ItemNumber eq '${itemNumber}' and dataAreaId eq '${dataAreaId}'&$top=1`;
      const checkResponse = await fetch(checkUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "OData-MaxVersion": "4.0",
          "OData-Version": "4.0",
        },
      });

      if (!checkResponse.ok) {
        const errorText = await checkResponse.text();
        console.error(`[D365] Failed to check product ${itemNumber}: ${errorText}`);
        continue;
      }

      const checkData = await checkResponse.json();
      const exists = checkData.value && checkData.value.length > 0;

      if (exists) {
        console.log(`[D365] ✅ Product ${itemNumber} already exists in D365`);
        d365ItemNumbers.push(itemNumber);
      } else {
        // D365 OData API does not support direct product creation
        // Products must be created through D365 UI or custom services
        console.log(`[D365] ⚠️  Product ${itemNumber} does not exist in D365`);
        console.log(`[D365]    Product creation via OData is not supported.`);
        console.log(
          `[D365]    Please create product "${productName}" (SKU: ${itemNumber}) manually in D365:`
        );
        console.log(
          `[D365]    1. Go to Product Information Management → Products → Released products`
        );
        console.log(`[D365]    2. Create new product with Item Number: ${itemNumber}`);
        console.log(`[D365]    3. Set Product Name: ${productName}`);
        if (variant.barcode) {
          console.log(`[D365]    4. Set Barcode: ${variant.barcode}`);
        }
        if (variant.weight && variant.weight > 0) {
          const weightInKg =
            variant.weight_unit?.toLowerCase() === "kg"
              ? variant.weight
              : variant.weight * 0.453592;
          console.log(`[D365]    5. Set Weight: ${weightInKg} kg`);
        }
        // Don't add to d365ItemNumbers since it wasn't actually created
      }
    } catch (error) {
      console.error(`[D365] Error syncing variant ${itemNumber}:`, error);
      // Continue with other variants
    }
  }

  // Check if we had any variants with SKUs to process
  const variantsWithSkus = product.variants.filter((v) => v.sku && v.sku.trim() !== "");

  if (variantsWithSkus.length === 0) {
    return {
      success: false,
      message: "No variants with SKUs to sync to D365",
      d365ItemNumbers: [],
    };
  }

  if (d365ItemNumbers.length === 0) {
    // Products don't exist in D365 - this is expected since we can't create via OData
    return {
      success: false,
      message: `No products found in D365 for ${variantsWithSkus.length} variant(s). Products must be created manually in D365 UI.`,
      d365ItemNumbers: [],
    };
  }

  return {
    success: true,
    message: `Found ${d365ItemNumbers.length} of ${variantsWithSkus.length} variant(s) in D365`,
    d365ItemNumbers,
  };
}

// ============================================================================
// INVENTORY QUERY (READ ONLY)
// ============================================================================

export interface D365InventoryItem {
  dataAreaId: string;
  ItemNumber: string;
  ProductName: string;
  InventorySiteId: string;
  OnHandQuantity: number;
  AvailableOnHandQuantity: number;
  TotalAvailableQuantity: number;
  ReservedOnHandQuantity: number;
  OrderedQuantity: number;
  AvailableOrderedQuantity: number;
}

export interface D365GetInventoryOptions {
  dataAreaId?: string; // Filter by company (e.g., 'u001')
  itemNumber?: string; // Filter by specific item
  top?: number; // Limit results
  skip?: number; // Pagination offset
}

/**
 * Fetch inventory levels from D365 InventorySitesOnHandV2 (READ ONLY)
 * This is safe to call - it only reads data, no writes.
 */
export async function getInventory(
  options: D365GetInventoryOptions = {}
): Promise<{ items: D365InventoryItem[]; count: number }> {
  const accessToken = await getAuthToken();
  const { dataAreaId, itemNumber, top = 100, skip = 0 } = options;

  // Build OData query
  let url = `${config.dynamics.baseUrl}/data/InventorySitesOnHandV2?cross-company=true`;

  // Add filters
  const filters: string[] = [];
  if (dataAreaId) {
    filters.push(`dataAreaId eq '${dataAreaId.toLowerCase()}'`);
  }
  if (itemNumber) {
    filters.push(`ItemNumber eq '${itemNumber}'`);
  }
  if (filters.length > 0) {
    url += `&$filter=${filters.join(" and ")}`;
  }

  // Add pagination
  url += `&$top=${top}&$skip=${skip}`;

  console.log(`[D365] Fetching inventory from: ${url}`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`D365 Inventory fetch failed: ${response.status} - ${error.substring(0, 500)}`);
  }

  const data = await response.json();
  const items = data.value || [];

  console.log(`[D365] Fetched ${items.length} inventory items`);

  return { items, count: items.length };
}

/**
 * Fetch ALL inventory from D365 (paginated, fetches all pages)
 */
export async function getAllInventory(
  options: Omit<D365GetInventoryOptions, "top" | "skip"> = {}
): Promise<D365InventoryItem[]> {
  const allItems: D365InventoryItem[] = [];
  let skip = 0;
  const pageSize = 1000; // D365 max is typically 1000
  let hasMore = true;

  console.log(`[D365] Fetching all inventory...`);

  while (hasMore) {
    const { items } = await getInventory({ ...options, top: pageSize, skip });
    allItems.push(...items);

    if (items.length < pageSize) {
      hasMore = false;
    } else {
      skip += pageSize;
    }
  }

  console.log(`[D365] Total inventory fetched: ${allItems.length} items`);
  return allItems;
}

/**
 * Sync inventory levels from Shopify to D365
 * TODO: Implement actual D365 inventory adjustment via InventoryOnHandEntities or Adjustment Journals
 */
export async function syncInventoryLevel(inventory: {
  inventoryItemId: string;
  locationId: string;
  available: number | null;
  sku?: string;
  dataAreaId?: string; // Location-specific data area ID
}): Promise<{ success: boolean; message: string }> {
  const dataAreaId = inventory.dataAreaId || config.dynamics.dataAreaId;
  console.log(`[D365] 🔄 syncInventoryLevel called for item ${inventory.inventoryItemId}`);
  console.log(
    `[D365]   Location: ${inventory.locationId}, Available: ${inventory.available}, SKU: ${inventory.sku || "N/A"}, DataAreaId: ${dataAreaId}`
  );

  if (config.features.dryRunMode) {
    console.log(
      `[D365] DRY RUN - Would sync inventory for item ${inventory.inventoryItemId} to ${dataAreaId}`
    );
    return { success: true, message: `DRY RUN - Inventory sync placeholder (${dataAreaId})` };
  }

  // TODO: Map Shopify inventory → D365 On-hand inventory
  // Example approaches:
  //   1. POST /data/InventoryOnHandEntities - direct on-hand update
  //   2. Use D365 Inventory Adjustment Journals for auditable changes
  //   3. Call THK custom API if one exists for inventory sync
  // Steps:
  //   1. Map Shopify inventory_item_id → D365 ItemNumber (via SKU lookup)
  //   2. Map Shopify location_id → D365 Warehouse/Site using dataAreaId
  //   3. Compare current D365 on-hand vs Shopify available
  //   4. Create adjustment if different
  console.log(`[D365] ⚠️  Inventory sync not yet implemented - placeholder only (${dataAreaId})`);
  return {
    success: true,
    message: `Placeholder - D365 inventory sync not yet implemented (${dataAreaId})`,
  };
}

// ============================================================================
// LEGACY EXPORTS (for backwards compatibility)
// ============================================================================

// Alias for the old function name
export const createSalesOrderHeader = createSalesOrderHeaderV3;
