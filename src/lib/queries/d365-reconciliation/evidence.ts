export const headerEvidenceFields =
  "SalesOrderNumber,THK_ShopifyReference,CurrencyCode,SalesOrderProcessingStatus";
export const lineEvidenceFields =
  "SalesOrderNumber,ItemNumber,InventoryLotId,OrderedSalesQuantity,SalesPrice,LineDiscountAmount,CurrencyCode";
export const slipEvidenceFields = "SalesId,PackingSlipId,InventTransId,ItemId,Qty,DeliveryDate";
export const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
