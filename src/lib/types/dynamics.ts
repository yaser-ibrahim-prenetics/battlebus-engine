// ============================================================================
// DYNAMICS 365 TYPES
// ============================================================================
// These types represent the D365 OData schemas for sales orders

export interface D365SalesOrderHeader {
  dataAreaId: string;
  SalesOrderNumber?: string;
  CustomerAccountNumber: string;
  InvoiceCustomerAccountNumber: string;
  SalesOrderName: string;
  OrderingCustomerAccountNumber: string;
  RequestedShippingDate: string;
  RequestedReceiptDate: string;
  DeliveryAddressName: string;
  DeliveryAddressStreet: string;
  DeliveryAddressCity: string;
  DeliveryAddressState: string;
  DeliveryAddressCountryRegionId: string;
  DeliveryAddressZipCode: string;
  DeliveryAddressDescription: string;
  SalesOrderOriginCode: string;
  Email: string;
  CurrencyCode: string;
  LanguageId: string;
  DeliveryModeCode: string;
  SiteId: string;
  WarehouseId: string;
  DefaultShippingSiteId: string;
  DefaultShippingWarehouseId: string;
  // IM8 Custom Fields
  IM8ShopifyOrderId?: string;
  IM8ShopifyOrderName?: string;
  IM8ShopifyStore?: string;
}

export interface D365SalesOrderLine {
  dataAreaId: string;
  SalesOrderNumber: string;
  LineNumber?: number;
  ItemNumber: string;
  SalesQuantity: number;
  SalesPrice: number;
  LineAmount: number;
  SalesUnitSymbol: string;
  RequestedShippingDate: string;
  ShippingSiteId: string;
  ShippingWarehouseId: string;
  LineDescription: string;
  // Tax
  SalesTaxGroupCode?: string;
  ItemSalesTaxGroupCode?: string;
  // Discount
  LineDiscountAmount?: number;
  LineDiscountPercentage?: number;
}

export interface D365PrepaymentRequest {
  dataAreaId: string;
  SalesOrderNumber: string;
  PrepaymentAmount: number;
  PaymentReference: string;
  PaymentDate: string;
  CurrencyCode: string;
}

export interface D365FulfilmentRequest {
  dataAreaId: string;
  SalesOrderNumber: string;
  PackingSlipId: string;
  ShipDate: string;
  Lines: D365FulfilmentLine[];
}

export interface D365FulfilmentLine {
  ItemNumber: string;
  Quantity: number;
  LineNumber: number;
}

export interface D365AuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
}

export interface D365ApiConfig {
  baseUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  resource: string;
}

export interface D365Response<T> {
  value: T[];
  "@odata.context"?: string;
  "@odata.nextLink"?: string;
}
