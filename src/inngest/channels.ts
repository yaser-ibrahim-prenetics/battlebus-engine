import { realtime, staticSchema } from "inngest";

type OrderStatusData = {
  orderName: string;
  inngestIdempotencyKey?: string;
  inngestRunId?: string;
  step?: string;
  status: string;
  message?: string;
  data?: Record<string, unknown>;
  durationMs?: number;
  timestamp: string;
};

type OrderResultData = {
  orderName: string;
  inngestIdempotencyKey?: string;
  inngestRunId?: string;
  status: string;
  d365OrderNumber?: string;
  gpsOrderNo?: string;
  warehouse?: string;
  error?: string;
  timestamp: string;
};

type InventorySyncStatusData = {
  syncId: string;
  step?: string;
  status: string;
  message?: string;
  itemsProcessed?: number;
  itemsFailed?: number;
  driftDetected?: number;
  timestamp: string;
  [key: string]: unknown;
};

export const orderChannel = realtime.channel({
  name: ({ orderName }: { orderName: string }) => `order:${orderName}`,
  topics: {
    status: { schema: staticSchema<OrderStatusData>() },
    result: { schema: staticSchema<OrderResultData>() },
  },
});

export const inventorySyncChannel = realtime.channel({
  name: ({ syncId }: { syncId: string }) => `inventory:sync:${syncId}`,
  topics: {
    status: { schema: staticSchema<InventorySyncStatusData>() },
  },
});
