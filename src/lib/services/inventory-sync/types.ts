export interface InventoryLevel {
  sku: string;
  available: number;
  reserved?: number;
  inTransit?: number;
  lastUpdated?: Date;
}

export interface InventoryDiff {
  sku: string;
  gpsLevel: number | null;
  d365Level: number | null;
  shopifyLevel: number | null;
  gpsToD365Diff: number | null;
  d365ToShopifyDiff: number | null;
  needsSync: boolean;
}

export interface SyncResult {
  success: boolean;
  message: string;
  sku: string;
  source: "gps" | "d365" | "shopify";
  destination: "gps" | "d365" | "shopify";
  previousLevel?: number;
  newLevel?: number;
  error?: string;
}

export interface ReconciliationResult {
  timestamp: Date;
  skusChecked: number;
  discrepanciesFound: number;
  syncActions: SyncResult[];
  errors: string[];
}

export interface WarehouseMapping {
  gpsName: string;
  gpsCode: string;
  gpsWarehouseId?: number;
  d365DataAreaId: string;
  d365WarehouseId: string;
  d365SiteId: string;
  shopifyLocationId: string;
}
