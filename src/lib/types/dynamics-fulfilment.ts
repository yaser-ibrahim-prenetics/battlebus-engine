// Dynamics → Shopify fulfilment (same contract as spock-store DynamicsFulfilmentRequest)

export type DynamicsFulfilmentLine = {
  quantity: number;
  itemNumber: string;
  trackingNumber: string;
  /** Required on shipment; may be present on return flows */
  shippingSiteId?: string;
  ModeOfDelivery?: string | null;
  shippingWarehouseId?: string | null;
  shippingWarehouseLocationId?: string | null;
};

/**
 * Inbound from D365 (or a relay). Matches spock OpenAPI `DynamicsFulfilmentRequest`.
 */
export type DynamicsFulfilmentNotificationPayload = {
  customerAccount?: string;
  type: "shipment" | "return";
  completed?: boolean;
  salesOrderNumber: string;
  dataAreaId: string;
  confirmedShippedDate?: string;
  lines: DynamicsFulfilmentLine[];
};
