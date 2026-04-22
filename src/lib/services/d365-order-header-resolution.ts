/**
 * Shared Dynamics sales order header resolution for refund, fulfillment, and similar flows.
 * Order of attempt:
 * 1) Supabase `orders` row (Shopify **name** first, then numeric id) → `d365_order_number` → OData by SalesOrderNumber
 * 2) OData `SalesOrderHeadersV3` by `THK_ShopifyReference` (name, numeric id, variants) across candidate data areas
 * 3) If Hub still has `d365_order_number` but area-scoped reads miss: loose OData by `SalesOrderNumber` only (cross-company), tie-break by preferred data areas
 */
import type { D365SalesOrderHeader } from "@/lib/types/dynamics";
import * as dynamics from "@/lib/clients/dynamics";
import * as warehouseHelper from "@/lib/helpers/warehouse";
import { config } from "@/lib/config";
import type { D365ODataTraceContext } from "@/lib/utils/d365-odata-trace";
import { logRefundTraceLifecycle } from "@/lib/utils/d365-odata-trace";
import { fetchD365HintByShopifyOrderId } from "./supabase-order-lookup";

const MAX_THK_REF_AUDIT_ROWS = 25;

function looksLikeHubOrTestOrder(tags: string | null | undefined): boolean {
  if (!tags || typeof tags !== "string") return false;
  const t = tags.toLowerCase();
  return (
    t.includes("mass-test") ||
    t.includes("test-order") ||
    t.includes("battle-hub-test") ||
    t.includes("battle-hub-bulk") ||
    t.includes("battle-hub-created")
  );
}

function dynamicsTenantHost(): string {
  try {
    const u = config.dynamics.baseUrl?.trim();
    if (!u) return "";
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

export type ResolveD365OrderHeaderInput = {
  shopifyOrderId: string;
  shopifyOrderName: string | null | undefined;
  /** Drives data-area candidate list; defaults to US */
  shippingCountryCode?: string | null;
  /** e.g. STORD/HK location mapping — tried early for getSalesOrderByNumber */
  preferredDataAreaId?: string | null;
  /** When set, emits `RefundTraceLifecycle` + passes through to OData trace lines */
  trace?: D365ODataTraceContext;
  /** Shopify REST `tags` (comma-separated) — audit only */
  orderTags?: string | null;
};

/** Serializable summary for Inngest step output (not full OData entity). */
export type D365HeaderResolutionAudit = {
  /** Step id for support: Supabase runs inside the same `get-d365-order` step */
  flow: "supabase_orders_then_odata";
  shopifyOrderId: string;
  shopifyOrderName: string | null;
  shippingCountryCode: string;
  dynamicsSyncDisabled: boolean;
  /** Result of `fetchD365HintByShopifyOrderId` (Hub `orders` table / service role) */
  supabaseLookup: {
    attempted: boolean;
    d365OrderNumber: string | null;
    warehouse: string | null;
  };
  dataAreaCandidates: string[];
  thkShopifyReferenceCandidates: string[];
  /** OData `SalesOrderNumber eq ...` tries */
  odataBySalesOrderNumberDataAreasTried: string[];
  /** OData `THK_ShopifyReference eq ...` tries (capped) */
  odataByThkRefAttempts: Array<{ dataAreaId: string; ref: string }>;
  outcome:
    | "resolved_by_sales_order_number"
    | "resolved_by_thk_shopify_ref"
    | "resolved_by_sales_order_number_loose"
    | "not_found";
  /** Set when loose SO-number lookup ran */
  salesOrderNumberLooseMatchCount?: number;
  /** Host from `D365_BASE_URL` — confirms which Dynamics tenant was queried */
  dynamicsTenantHost?: string;
  /** `warehouse-config.json` `dataAreaId` when Hub `warehouse` label matched */
  warehouseHintDataAreaId?: string | null;
  /** Hub had `d365_order_number` but tenant-wide `SalesOrderNumber` OData returned 0 rows */
  hubSalesOrderNumberAbsentInDynamicsTenant?: boolean;
  /** Why resolution failed (mainly `not_found`) */
  notFoundDiagnosis?: string;
  /** Shopify order tags (comma-separated) — e.g. mass-test / test-order */
  shopifyOrderTags?: string | null;
  resolvedHeaderSummary: {
    SalesOrderNumber?: string;
    dataAreaId?: string;
  } | null;
};

export type ResolveD365OrderHeaderResult = {
  header: D365SalesOrderHeader | null;
  audit: D365HeaderResolutionAudit;
};

async function resolveD365OrderHeaderCore(
  input: ResolveD365OrderHeaderInput
): Promise<ResolveD365OrderHeaderResult> {
  const country = input.shippingCountryCode || "US";
  const trace = input.trace;

  const shopifyOrderId = String(input.shopifyOrderId);
  const shopifyOrderName =
    typeof input.shopifyOrderName === "string" ? input.shopifyOrderName.trim() || null : null;
  const orderTags =
    typeof input.orderTags === "string" && input.orderTags.trim() ? input.orderTags.trim() : null;

  const odataBySalesOrderNumberDataAreasTried: string[] = [];
  const odataByThkRefAttempts: Array<{ dataAreaId: string; ref: string }> = [];
  const host = dynamicsTenantHost();
  let looseTotalMatches: number | undefined;

  if (!config.features.enableDynamicsSync) {
    return {
      header: null,
      audit: {
        flow: "supabase_orders_then_odata",
        shopifyOrderId,
        shopifyOrderName,
        shippingCountryCode: country,
        dynamicsSyncDisabled: true,
        supabaseLookup: { attempted: false, d365OrderNumber: null, warehouse: null },
        dataAreaCandidates: [],
        thkShopifyReferenceCandidates: [],
        odataBySalesOrderNumberDataAreasTried,
        odataByThkRefAttempts,
        outcome: "not_found",
        dynamicsTenantHost: host || undefined,
        shopifyOrderTags: orderTags,
        resolvedHeaderSummary: null,
      },
    };
  }

  const envArea = (config.dynamics.dataAreaId || "").toUpperCase();
  const pref = input.preferredDataAreaId
    ? String(input.preferredDataAreaId).toUpperCase().trim()
    : "";

  const dataAreaIds = [
    ...(pref ? [pref] : []),
    ...warehouseHelper.getSalesOrderLookupDataAreaCandidates(country),
    envArea,
    ...warehouseHelper.getConfiguredWarehouseDataAreaIds(),
  ].filter(Boolean);
  const uniqueAreas = [...new Set(dataAreaIds.map((a) => String(a).toUpperCase()))];

  const rawName = typeof input.shopifyOrderName === "string" ? input.shopifyOrderName.trim() : "";
  const stripped = rawName.replace(/^#/, "").trim();
  const idStr = shopifyOrderId.trim();
  const refs = [
    ...new Set(
      [rawName, stripped, stripped ? `#${stripped}` : "", idStr].filter(
        (x): x is string => typeof x === "string" && x.length > 0
      )
    ),
  ];

  let preferredAreasForLoose: string[] = [];
  let warehouseHintDataAreaId: string | null = null;

  if (trace) {
    logRefundTraceLifecycle({
      ...trace,
      phase: "lifecycle_start",
      shopifyOrderName: input.shopifyOrderName ?? null,
      dataAreaCandidates: uniqueAreas,
      thkShopifyReferenceCandidates: refs,
      shippingCountryCode: country,
    });
  }

  const hint = await fetchD365HintByShopifyOrderId(
    String(input.shopifyOrderId),
    input.shopifyOrderName
  );

  const supabaseLookup = {
    attempted: true,
    d365OrderNumber: hint?.d365OrderNumber ?? null,
    warehouse: hint?.warehouse ?? null,
  };

  if (trace) {
    logRefundTraceLifecycle({
      ...trace,
      phase: "supabase_hint",
      d365OrderNumber: hint?.d365OrderNumber ?? null,
      warehouse: hint?.warehouse ?? null,
    });
  }

  if (hint?.d365OrderNumber) {
    let warehouseArea: string | null = null;
    if (hint.warehouse) {
      try {
        warehouseArea = warehouseHelper.getWarehouseConfig(hint.warehouse).dataAreaId.toUpperCase();
        warehouseHintDataAreaId = warehouseArea;
      } catch {
        console.warn(
          `[D365Resolve] Hub warehouse="${hint.warehouse}" has no matching entry in warehouse-config.json — ` +
            `cannot prefer that legal entity for OData`
        );
      }
    }
    const byNumberAreas = [warehouseArea, pref || null, ...uniqueAreas].filter(Boolean) as string[];
    const salesOrderAreas = [...new Set(byNumberAreas)];
    preferredAreasForLoose = salesOrderAreas;

    for (const dataAreaId of salesOrderAreas) {
      odataBySalesOrderNumberDataAreasTried.push(dataAreaId);
      const found = await dynamics.getSalesOrderByNumber(hint.d365OrderNumber, dataAreaId, trace);
      if (found) {
        console.log(
          `[D365Resolve] Header via Supabase d365_order_number=${hint.d365OrderNumber} ` +
            `(dataAreaId=${found.dataAreaId || dataAreaId})`
        );
        if (trace) {
          logRefundTraceLifecycle({
            ...trace,
            phase: "lifecycle_done",
            resolved: true,
            via: "Supabase_d365_order_number_OData",
            salesOrderNumber: found.SalesOrderNumber,
            dataAreaId: found.dataAreaId || dataAreaId,
          });
        }
        return {
          header: found,
          audit: {
            flow: "supabase_orders_then_odata",
            shopifyOrderId,
            shopifyOrderName,
            shippingCountryCode: country,
            dynamicsSyncDisabled: false,
            supabaseLookup,
            dataAreaCandidates: uniqueAreas,
            thkShopifyReferenceCandidates: refs,
            odataBySalesOrderNumberDataAreasTried: [...odataBySalesOrderNumberDataAreasTried],
            odataByThkRefAttempts: [],
            outcome: "resolved_by_sales_order_number",
            dynamicsTenantHost: host || undefined,
            warehouseHintDataAreaId,
            shopifyOrderTags: orderTags,
            resolvedHeaderSummary: {
              SalesOrderNumber: found.SalesOrderNumber,
              dataAreaId: found.dataAreaId || dataAreaId,
            },
          },
        };
      }
    }
    console.warn(
      `[D365Resolve] Supabase d365_order_number=${hint.d365OrderNumber} but getSalesOrderByNumber ` +
        `missed in all tried data areas`
    );
    if (trace) {
      logRefundTraceLifecycle({
        ...trace,
        phase: "by_number_exhausted",
        d365OrderNumber: hint.d365OrderNumber,
        triedDataAreas: salesOrderAreas,
      });
    }
  } else if (String(input.shopifyOrderId || "").trim()) {
    console.warn(
      `[D365Resolve] No Supabase row with d365_order_number for shopifyOrderId=${input.shopifyOrderId} ` +
        `name=${input.shopifyOrderName || "n/a"} — falling back to THK_ShopifyReference OData`
    );
  }

  for (const dataAreaId of uniqueAreas) {
    for (const ref of refs) {
      if (odataByThkRefAttempts.length < MAX_THK_REF_AUDIT_ROWS) {
        odataByThkRefAttempts.push({ dataAreaId, ref });
      }
      const found = await dynamics.getSalesOrderByShopifyId(ref, dataAreaId, trace);
      if (found) {
        if (trace) {
          logRefundTraceLifecycle({
            ...trace,
            phase: "lifecycle_done",
            resolved: true,
            via: "THK_ShopifyReference_OData",
            thkShopifyReference: ref,
            salesOrderNumber: found.SalesOrderNumber,
            dataAreaId: found.dataAreaId || dataAreaId,
          });
        }
        return {
          header: found,
          audit: {
            flow: "supabase_orders_then_odata",
            shopifyOrderId,
            shopifyOrderName,
            shippingCountryCode: country,
            dynamicsSyncDisabled: false,
            supabaseLookup,
            dataAreaCandidates: uniqueAreas,
            thkShopifyReferenceCandidates: refs,
            odataBySalesOrderNumberDataAreasTried: [...odataBySalesOrderNumberDataAreasTried],
            odataByThkRefAttempts: [...odataByThkRefAttempts],
            outcome: "resolved_by_thk_shopify_ref",
            dynamicsTenantHost: host || undefined,
            warehouseHintDataAreaId,
            shopifyOrderTags: orderTags,
            resolvedHeaderSummary: {
              SalesOrderNumber: found.SalesOrderNumber,
              dataAreaId: found.dataAreaId || dataAreaId,
            },
          },
        };
      }
    }
  }

  if (hint?.d365OrderNumber && preferredAreasForLoose.length > 0) {
    const looseResult = await dynamics.getSalesOrderHeadersBySalesOrderNumberLoose(
      hint.d365OrderNumber,
      preferredAreasForLoose,
      trace
    );
    looseTotalMatches = looseResult.totalMatches;
    const loose = looseResult.header;
    if (loose) {
      if (trace) {
        logRefundTraceLifecycle({
          ...trace,
          phase: "lifecycle_done",
          resolved: true,
          via: "SalesOrderNumber_loose_OData",
          salesOrderNumber: loose.SalesOrderNumber,
          dataAreaId: loose.dataAreaId,
        });
      }
      return {
        header: loose,
        audit: {
          flow: "supabase_orders_then_odata",
          shopifyOrderId,
          shopifyOrderName,
          shippingCountryCode: country,
          dynamicsSyncDisabled: false,
          supabaseLookup,
          dataAreaCandidates: uniqueAreas,
          thkShopifyReferenceCandidates: refs,
          odataBySalesOrderNumberDataAreasTried: [...odataBySalesOrderNumberDataAreasTried],
          odataByThkRefAttempts: [...odataByThkRefAttempts],
          outcome: "resolved_by_sales_order_number_loose",
          salesOrderNumberLooseMatchCount: looseResult.totalMatches,
          dynamicsTenantHost: host || undefined,
          warehouseHintDataAreaId,
          shopifyOrderTags: orderTags,
          resolvedHeaderSummary: {
            SalesOrderNumber: loose.SalesOrderNumber,
            dataAreaId: loose.dataAreaId ?? null,
          },
        },
      };
    }
  }

  if (trace) {
    logRefundTraceLifecycle({
      ...trace,
      phase: "lifecycle_done",
      resolved: false,
    });
  }

  const hubAbsent =
    Boolean(hint?.d365OrderNumber) &&
    typeof looseTotalMatches === "number" &&
    looseTotalMatches === 0;

  if (hubAbsent && hint?.d365OrderNumber) {
    console.warn(
      `[D365Resolve] Hub orders.d365_order_number=${hint.d365OrderNumber} not found in ` +
        `SalesOrderHeadersV3 on ${host || "D365"}. Loose SalesOrderNumber query returned 0 rows. ` +
        `Fix: update Hub when the SO exists in this tenant, or point Bus D365_* at the environment where the order was created.`
    );
  }

  let notFoundDiagnosis = hubAbsent
    ? `Hub has d365_order_number=${hint?.d365OrderNumber} but that SalesOrderNumber does not exist in Dynamics tenant ${host || "(unknown)"} (loose OData returned 0). Data is stale or Bus uses a different D365 environment than where the order was posted.`
    : hint?.d365OrderNumber
      ? `No SalesOrderHeadersV3 row for THK refs tried; SalesOrderNumber ${hint.d365OrderNumber} also unmatched after area + loose queries.`
      : `No Supabase d365_order_number for this Shopify order; THK_ShopifyReference lookups returned no header.`;

  if (hubAbsent && looksLikeHubOrTestOrder(orderTags)) {
    notFoundDiagnosis +=
      " Shopify tags suggest a Hub/mass-test order: Hub may have written d365_order_number without a matching D365 UAT sales order — fix or clear orders.d365_order_number for this row.";
  }

  return {
    header: null,
    audit: {
      flow: "supabase_orders_then_odata",
      shopifyOrderId,
      shopifyOrderName,
      shippingCountryCode: country,
      dynamicsSyncDisabled: false,
      supabaseLookup,
      dataAreaCandidates: uniqueAreas,
      thkShopifyReferenceCandidates: refs,
      odataBySalesOrderNumberDataAreasTried,
      odataByThkRefAttempts,
      outcome: "not_found",
      dynamicsTenantHost: host || undefined,
      warehouseHintDataAreaId,
      hubSalesOrderNumberAbsentInDynamicsTenant: hubAbsent,
      notFoundDiagnosis,
      shopifyOrderTags: orderTags,
      resolvedHeaderSummary: null,
    },
  };
}

export async function resolveD365OrderHeaderForLifecycle(
  input: ResolveD365OrderHeaderInput
): Promise<D365SalesOrderHeader | null> {
  return (await resolveD365OrderHeaderCore(input)).header;
}

/** Use from refund step when Inngest should show non-null output with Supabase + OData audit. */
export async function resolveD365OrderHeaderForLifecycleWithAudit(
  input: ResolveD365OrderHeaderInput
): Promise<ResolveD365OrderHeaderResult> {
  return resolveD365OrderHeaderCore(input);
}
