import type { SaveOrderLinesResult } from "@/lib/services/order-lines";

export type OrderLinesSupabaseSyncLog = {
  attempted: boolean;
  skipReason?: "d365_order_already_existed" | "dynamics_sync_disabled";
  note?: string;
  d365LineCount?: number;
  recordsPrepared?: number;
  skippedD365ServiceLines?: number;
  save?: SaveOrderLinesResult;
  preview?: Array<{
    shopify_line_item_id: string;
    d365_item_number: string;
    hasLotId: boolean;
  }>;
};

export type GpsOrderResult =
  | {
      type: "real";
      result: {
        response?: {
          data?: Array<{ orderNo?: string; outboundOrderNo?: string }>;
        };
      };
      metafieldStored: boolean;
    }
  | { type: "out_of_stock"; error: string }
  | { type: "failed"; error: string }
  | { type: "skipped"; reason: string };

export type OrderSyncResult = {
  type: "already_exists" | "sync_complete";
  salesOrderNumber: string;
  lineItems: unknown[];
  d365InventoryLotsBySku: Record<string, string>;
  orderLinesSupabase: OrderLinesSupabaseSyncLog;
  gpsResult: GpsOrderResult;
};

export type StepTools = {
  run: <T>(id: string, handler: () => Promise<T>) => Promise<T>;
  sleep: (id: string, duration: string) => Promise<void>;
};

export type PublishStatus = (
  stepName: string,
  status: "running" | "completed" | "failed" | "skipped",
  message?: string,
  data?: Record<string, unknown>
) => Promise<void>;

export type PublishResult = (
  status: "success" | "failed" | "skipped",
  resultData?: {
    d365OrderNumber?: string;
    gpsOrderNo?: string;
    warehouse?: string;
    error?: string;
  }
) => Promise<void>;
