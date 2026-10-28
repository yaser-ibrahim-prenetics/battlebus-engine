/** No addresses, credentials or customer details are retained for provider verification. */
export interface FulfillmentRecoveryContext {
  version: 1;
  kind: "d365_shipment";
  company: string;
  salesOrderNumber: string;
  postingDate: string;
  lines: { lotId: string; itemNumber: string; quantity: number }[];
}
