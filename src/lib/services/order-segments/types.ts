import type { WarehouseName } from "@/lib/helpers/warehouse";

export interface SegmentLine {
  lineItemId: string;
  quantity: number;
}
export interface OrderSegment {
  index: number;
  sourceFulfillmentOrderId: string;
  locationId: string;
  warehouse: WarehouseName;
  dataAreaId: string;
  lines: SegmentLine[];
}
export interface SegmentPlan {
  version: 1;
  orderId: string;
  orderName: string;
  inputHash: string;
  segments: OrderSegment[];
}
export interface RecordedSegmentLine {
  sourceLineId: string;
  sourceQuantity: number;
  itemNumber: string;
  quantity: number;
  lotId: string;
  isService: boolean;
}
export interface SegmentProgress {
  lines?: RecordedSegmentLine[];
  fulfillmentOrderId?: string;
  salesOrderNumber?: string;
  gpsOrderId?: string;
  completed?: boolean;
}
export interface StoredPlan {
  plan: SegmentPlan;
  progress: Record<string, SegmentProgress>;
}
export interface StepRunner {
  run<T>(id: string, callback: () => Promise<T>): Promise<T>;
}
