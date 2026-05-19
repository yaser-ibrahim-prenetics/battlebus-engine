// ============================================================================
// GPS FULFILMENT RECOVERY (Hub-triggered, per order)
// ============================================================================
// 1. Load Hub order → GPS US/UK outbound id
// 2. POST /openapi/v1/outboundOrder/detail
// 3. If status=3 (shipped), queue gps/individual.fulfilment

import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { config } from "@/lib/config";
import { getOutboundOrdersDetails } from "@/lib/clients/gps";
import { isGpsUkWarehouse, isValidGpsWarehouse } from "@/lib/helpers/warehouse";
import { RETRY_CONFIGS } from "@/lib/utils/constants";
import { fetchGpsRecoveryContextByShopifyOrderName } from "@/lib/services/supabase-order-lookup";
import { logFlowEvent } from "@/lib/services/supabase-flow-logs";
import type { IGpsIndividualFulfilment, IGpsIndividualOrderData } from "@/lib/types/gps";

type GpsWarehouseName = "GPS Warehouse" | "GPS UK Warehouse";

function resolveGpsOutbound(context: {
  warehouse: string | null;
  gpsOrderNo: string | null;
  gpsUkOrderNo: string | null;
}): { outboundId: string; warehouseName: GpsWarehouseName } | null {
  const warehouse = String(context.warehouse || "").trim();
  if (isGpsUkWarehouse(warehouse)) {
    const id = context.gpsUkOrderNo || context.gpsOrderNo;
    return id ? { outboundId: id, warehouseName: "GPS UK Warehouse" } : null;
  }
  if (warehouse === "GPS Warehouse" || isValidGpsWarehouse(warehouse)) {
    const id = context.gpsOrderNo || context.gpsUkOrderNo;
    return id ? { outboundId: id, warehouseName: "GPS Warehouse" } : null;
  }
  if (context.gpsUkOrderNo) {
    return { outboundId: context.gpsUkOrderNo, warehouseName: "GPS UK Warehouse" };
  }
  if (context.gpsOrderNo) {
    return { outboundId: context.gpsOrderNo, warehouseName: "GPS Warehouse" };
  }
  return null;
}

function toIndividualOrderData(
  detail: {
    outboundOrderNo: string;
    status: number;
    logisticsTrackNo: string;
    logisticsCarrier: string;
    platformOrderNo: string;
    outboundTime: string;
    referOrderNo?: string;
    thirdOrderNo?: string;
    productList?: IGpsIndividualOrderData["productList"];
    expressList?: IGpsIndividualOrderData["expressList"];
  },
  shopifyOrderName: string,
  d365OrderNumber: string | null
): IGpsIndividualOrderData {
  const trackNo = String(detail.logisticsTrackNo || "").trim();
  return {
    outboundOrderNo: detail.outboundOrderNo,
    platformOrderNo: shopifyOrderName || detail.platformOrderNo,
    referOrderNo: d365OrderNumber || detail.referOrderNo || "",
    thirdOrderNo: detail.thirdOrderNo || detail.referOrderNo || "",
    status: detail.status,
    statusName: detail.status === config.gps.gpsFulfilledStatus ? "已出库" : "",
    whCode: "",
    email: "",
    receiver: "",
    telephone: "",
    companyName: "",
    addressOne: "",
    addressTwo: "",
    cityName: "",
    cityCode: "",
    provinceName: "",
    provinceCode: "",
    postCode: "",
    countryRegionCode: "",
    countryRegionName: "",
    houseNum: "",
    productList: detail.productList || [],
    expressList:
      detail.expressList ||
      (trackNo
        ? [
            {
              trackNo,
              pkgSkuNumInfo: "",
              weight: 0,
              length: 0,
              width: 0,
              height: 0,
              fileUrl: "",
            },
          ]
        : []),
    logisticsCarrier: detail.logisticsCarrier || "GPS",
    logisticsChannel: "",
    logisticsTrackNo: trackNo,
    logisticsTrackNos: trackNo ? [trackNo] : [],
    orderCreateTime: "",
    outboundTime: detail.outboundTime,
    canceledTime: "",
    exceptionTime: "",
    interceptTime: "",
    costItems: [],
    costTotal: 0,
    costCurrencyCode: "USD",
    orderTypeName: "",
    subOrderTypeName: "",
    salesPlatform: "",
    exceptionDesc: "",
    remark: "",
    taxNum: "",
    orderList: "",
    storeName: "",
    needRelabel: 0,
    appendixList: [],
  };
}

export const recoverGpsFulfilment = inngest.createFunction(
  {
    id: "recover-gps-fulfillment",
    name: "Recover GPS Fulfilment (Hub)",
    idempotency: "event.data.shopifyOrderName",
    retries: RETRY_CONFIGS.DEFAULT,
    triggers: [{ event: "gps/recover.fulfilment" }],
  },
  async ({ event, step, runId }: { event: any; step: any; runId?: string }) => {
    const shopifyOrderName = String(event.data.shopifyOrderName || "").trim();
    const source = String(event.data.source || "hub_recovery");
    const _runId = String(runId ?? "") || undefined;

    if (!shopifyOrderName) {
      throw new NonRetriableError("shopifyOrderName is required for gps/recover.fulfilment");
    }

    logFlowEvent({
      flow: "gps_recovery",
      step: "start",
      status: "started",
      runId: _runId,
      shopifyOrderName,
      payload: { source },
    });

    const hubOrder = await step.run("load-hub-order", async () => {
      return fetchGpsRecoveryContextByShopifyOrderName(shopifyOrderName);
    });

    if (!hubOrder) {
      throw new NonRetriableError(`Order not found in Hub: ${shopifyOrderName}`);
    }

    const resolved = resolveGpsOutbound(hubOrder);
    if (!resolved) {
      logFlowEvent({
        flow: "gps_recovery",
        step: "done",
        status: "completed",
        runId: _runId,
        shopifyOrderName,
        payload: { skipped: true, reason: "gps_no_outbound_id" },
      });
      return {
        status: "skipped",
        reason: "gps_no_outbound_id",
        shopifyOrderName,
      };
    }

    const { outboundId, warehouseName } = resolved;

    const gpsResult = await step.run("fetch-gps-outbound-detail", async () => {
      return getOutboundOrdersDetails([outboundId], warehouseName);
    });

    const { response } = gpsResult;
    if (response.code !== 200) {
      throw new NonRetriableError(
        `GPS detail API failed for ${outboundId}: code=${response.code} msg=${response.msg}`
      );
    }

    const detail = (response.data || []).find(
      (row: { outboundOrderNo?: string }) =>
        String(row.outboundOrderNo || "") === outboundId
    ) ?? response.data?.[0];

    if (!detail) {
      throw new NonRetriableError(`GPS returned no detail for outbound ${outboundId}`);
    }

    if (detail.status !== config.gps.gpsFulfilledStatus) {
      logFlowEvent({
        flow: "gps_recovery",
        step: "done",
        status: "completed",
        runId: _runId,
        shopifyOrderName,
        payload: {
          skipped: true,
          reason: "gps_not_shipped",
          gpsStatus: detail.status,
          outboundId,
          warehouse: warehouseName,
        },
      });
      return {
        status: "skipped",
        reason: "gps_not_shipped",
        shopifyOrderName,
        gpsStatus: detail.status,
        outboundId,
        warehouse: warehouseName,
      };
    }

    if (!detail.logisticsTrackNo?.trim() || !detail.outboundTime?.trim()) {
      throw new NonRetriableError(
        `GPS order ${outboundId} is shipped but missing tracking or outboundTime`
      );
    }

    const fulfilmentPayload: IGpsIndividualFulfilment = {
      type: "individual",
      warehouse: warehouseName,
      orderData: toIndividualOrderData(
        detail as Parameters<typeof toIndividualOrderData>[0],
        hubOrder.shopifyOrderName,
        hubOrder.d365OrderNumber
      ),
    };

    const childIds = await step.run("queue-individual-fulfilment", async () => {
      const result = await inngest.send({
        id: `GPSR-${outboundId}`,
        name: "gps/individual.fulfilment",
        data: {
          gpsOrderNo: outboundId,
          shopifyOrderName: hubOrder.shopifyOrderName,
          trackingNumber: detail.logisticsTrackNo,
          warehouse: warehouseName,
          fulfilmentPayload,
          receivedAt: new Date().toISOString(),
          source,
        },
      });
      return result.ids || [];
    });

    logFlowEvent({
      flow: "gps_recovery",
      step: "done",
      status: "completed",
      runId: _runId,
      shopifyOrderName,
      payload: {
        queued: true,
        outboundId,
        warehouse: warehouseName,
        inngestChildIds: childIds,
      },
    });

    return {
      status: "queued",
      shopifyOrderName,
      outboundId,
      warehouse: warehouseName,
      inngestIds: childIds,
    };
  }
);
