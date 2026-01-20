// Re-export all types
export * from "./dynamics";
export * from "./gps";

// Common types
export interface ProcessingResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export type DataAreaId = "im8" | "cdna" | "prv";

export interface WarehouseConfig {
  dataAreaId: DataAreaId;
  warehouseId: string;
  siteId: string;
  warehouseType: "GPS" | "STORD" | "EXTENSIV" | "D365";
}
