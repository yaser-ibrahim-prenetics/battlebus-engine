// ============================================================================
// DYNAMICS 365 TYPES
// ============================================================================
// Ported from spock-store src/type/dynamics.ts

export interface D365AuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
}

// ============================================================================
// THK API Response
// ============================================================================

export interface D365ThkApiResponse {
  status: number;
  Message: string;
  Result: string;
  $id: string;
}

// ============================================================================
// Address Types
// ============================================================================

export interface D365SalesOrderHeadersV3Address {
  addressCity: string;
  addressCountryCode: string;
  addressLine: string;
  addressName: string;
  addressStateId: string;
  addressStreet: string;
  addressZipCode: string;
  addressPhone: string;
}

// ============================================================================
// Sales Order Header V3 Request (THK Custom Fields)
// ============================================================================

export interface D365SalesOrderHeaderV3Request {
  customerId: string;
  orderId: string;
  dataAreaId: string;
  orderingCustomerAccountNumber: string;
  defaultLedgerDimensionDisplayValue: string;
  customerOrderReference: string;
  email: string;
  name: string;
  shopifyReference: string;
  shippingAddress?: D365SalesOrderHeadersV3Address;
  billingAddress?: D365SalesOrderHeadersV3Address;
  comment?: string;
  shippingWarehouseId?: string;
  currency?: string;
  paymentId?: string;
  skipFulfillmentNotification?: "Yes" | "No";
}

export interface D365SalesOrderHeaderV3RequestForReturn {
  customerId: string;
  orderId: string;
  dataAreaId: string;
  orderingCustomerAccountNumber: string;
  defaultLedgerDimensionDisplayValue: string;
  customerOrderReference: string;
  email: string;
  name: string;
  shopifyReference: string;
}

// ============================================================================
// Sales Order Line Request
// ============================================================================

export interface D365SalesOrderLineRequest {
  salesOrderNumber?: string;
  dataAreaId: string;
  itemNumber: string;
  quantity: number;
  price: number;
  discount?: number;
  giftCardNumber?: string;
  shippingWarehouseId?: string;
  currency?: string;
  countryCode?: string;
  discountCode?: string[];
}

export interface D365SalesOrderLineForReturn {
  salesOrderNumber: string;
  quantity: number;
  itemNumber: string;
  price: number;
  discount: number;
  dataAreaId: string;
  inventTransIdReturn: string;
  shippingSiteId: string;
}

// ============================================================================
// Return Sales Order Request
// ============================================================================
export interface D365ReturnSalesOrderHeadersV3Request {
  customerId: string;
  orderId: string;
  dataAreaId: string;
  defaultLedgerDimensionDisplayValue: string;
  orderingCustomerAccountNumber: string;
  email: string;
  name: string;
  customerOrderReference: string;
  shopifyReference: string;
  discount?: number;
}

// ============================================================================
// Return Sales Order Line Request
// ============================================================================
export interface D365ReturnSalesOrderLineRequest {
  inventTransIdReturn: string;
  shippingSiteId: string;
  salesOrderNumber: string;
  quantity: number;
  itemNumber: string;
  price: number;
  discount?: number;
  dataAreaId: string;
}

// ============================================================================
// Fulfilment Request
// ============================================================================

export interface D365FulfilmentLine {
  itemNumber: string;
  quantity: number;
  shippingSiteId: string;
  shippingWarehouseId?: string;
  shippingWarehouseLocationId?: string;
  trackingNumber?: string;
  lotId?: string;
}

export interface D365FulfilmentRequest {
  salesOrderNumber: string;
  dataAreaId: string;
  // Spock-store parity: THK fulfilment endpoint uses "shipment" for outbound shipments.
  type: "shipment" | "PackingSlip" | "Invoice" | "return";
  confirmedShippedDate: string;
  lines: D365FulfilmentLine[];
}

// ============================================================================
// Legacy Types (for backwards compatibility)
// ============================================================================

export interface D365SalesOrderHeader {
  dataAreaId: string;
  SalesOrderNumber?: string;
  CustomerAccountNumber?: string;
  InvoiceCustomerAccountNumber?: string;
  SalesOrderName?: string;
  OrderingCustomerAccountNumber?: string;
  RequestedShippingDate?: string;
  RequestedReceiptDate?: string;
  DeliveryAddressName?: string;
  DeliveryAddressStreet?: string;
  DeliveryAddressCity?: string;
  DeliveryAddressState?: string;
  DeliveryAddressCountryRegionId?: string;
  DeliveryAddressZipCode?: string;
  DeliveryAddressDescription?: string;
  SalesOrderOriginCode?: string;
  Email?: string;
  CurrencyCode?: string;
  LanguageId?: string;
  DeliveryModeCode?: string;
  SiteId?: string;
  WarehouseId?: string;
  DefaultShippingSiteId?: string;
  DefaultShippingWarehouseId?: string;
  // THK Custom Fields
  THK_ShopifyReference?: string;
  THK_ShopifyCustName?: string;
  THK_ShopifyCustomerEmail?: string;
  THK_BillingName?: string;
  THK_BillingAddressCountryRegionId?: string;
  THK_BillingAddressZipCode?: string;
  THK_BillingAddressStreet?: string;
  THK_BillingAddressCity?: string;
  THK_ShopifyCustomerPhonenum?: string;
  THK_Comments?: string;
  THK_ShopifyPaymentReference?: string;
  THK_SkipFulfillmentNotification?: string;
  // Read-only THK / D365 server-managed fields useful for diagnostics.
  // D365 sets THK_DepositFulfillment="Yes" when the customer/posting profile
  // is configured for the deposit-fulfillment flow. We cannot write this on
  // insert (403 ODataSecurityException) but we can read it back to verify
  // that PostPrepayment produced a prepayment invoice (not a standard one).
  THK_DepositFulfillment?: "Yes" | "No" | string;
  SalesOrderProcessingStatus?: string;
}

export interface D365SalesOrderLine {
  dataAreaId: string;
  SalesOrderNumber: string;
  ItemNumber: string;
  SalesQuantity: number;
  SalesPrice: number;
  LineAmount?: number;
  SalesUnitSymbol?: string;
  RequestedShippingDate?: string;
  ShippingSiteId?: string;
  ShippingWarehouseId?: string;
  LineDescription?: string;
  LineDiscountAmount?: number;
  InventoryLotId?: string;
}

export interface D365PrepaymentRequest {
  dataAreaId: string;
  SalesOrderNumber: string;
  PrepaymentAmount: number;
  CurrencyCode: string;
}

export interface D365ReturnOrderInvoiceRequest {
  salesOrderNumber: string;
  dataAreaId: string;
  invoiceDate: Date;
}
