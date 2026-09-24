import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "../client";
import { config } from "@/lib/config";
import { getOrder, searchOrdersByName, type ShopifyOrder } from "@/lib/clients/shopify";

type RecoverInput = {
  shopifyOrderIds?: string[];
  shopifyOrderNames?: string[];
  shopifyStore?: string;
  force?: boolean;
  requestedBy?: string;
  source?: "reconciliation" | "manual";
};

function normalizeTokens(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .flatMap((v) => v.split(/[\n,\s]+/).map((x) => x.trim()).filter(Boolean))
    )
  );
}

function toNumericShopifyOrderId(id: string): string | null {
  const token = String(id || "").trim();
  if (!token) return null;
  if (/^\d+$/.test(token)) return token;
  const gidMatch = token.match(/\/(\d+)\s*$/);
  return gidMatch ? gidMatch[1] : null;
}

/** Try variants Shopify search accepts (with/without #). */
async function getOrderByShopifyName(
  name: string,
  shopDomainHint: string | null
): Promise<ShopifyOrder | null> {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const variants = Array.from(
    new Set([
      raw,
      raw.replace(/^#/, "").trim(),
      raw.startsWith("#") ? raw : `#${raw.replace(/^#/, "")}`,
    ])
  ).filter(Boolean);

  for (const q of variants) {
    try {
      const rows = await searchOrdersByName(q, shopDomainHint);
      const orderLite = rows?.[0];
      if (!orderLite?.id) continue;
      return await getOrder(String(orderLite.id), shopDomainHint);
    } catch {
      /* try next variant */
    }
  }
  return null;
}

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function fetchExistingHubOrderKeys(params: {
  supabase: SupabaseClient;
  shopifyOrderIds: string[];
  shopifyOrderNames: string[];
}): Promise<{ idKeys: string[]; nameKeys: string[] }> {
  const idKeys = new Set<string>();
  const nameKeys = new Set<string>();
  const { supabase, shopifyOrderIds, shopifyOrderNames } = params;

  if (shopifyOrderIds.length > 0) {
    const { data } = await supabase
      .from("orders")
      .select("shopify_order_id")
      .in("shopify_order_id", shopifyOrderIds);
    for (const row of (data || []) as Array<{ shopify_order_id?: string | null }>) {
      const id = String(row.shopify_order_id || "").trim();
      if (id) idKeys.add(id);
    }
  }

  if (shopifyOrderNames.length > 0) {
    const { data } = await supabase
      .from("orders")
      .select("shopify_order_name")
      .in("shopify_order_name", shopifyOrderNames);
    for (const row of (data || []) as Array<{ shopify_order_name?: string | null }>) {
      const n = String(row.shopify_order_name || "").trim();
      if (n) nameKeys.add(n);
    }
  }

  return { idKeys: Array.from(idKeys), nameKeys: Array.from(nameKeys) };
}

function resolveReplayEventName(order: ShopifyOrder): "shopify/order.created" | "shopify/order.paid" {
  const fin = String(order.financial_status || "").toLowerCase();
  const isPaidLike =
    fin === "paid" ||
    fin === "partially_paid" ||
    fin === "partially_refunded" ||
    fin === "refunded" ||
    fin === "authorized";
  return isPaidLike ? "shopify/order.paid" : "shopify/order.created";
}

export const processShopifyOrderRecover = inngest.createFunction(
  {
    id: "process-shopify-order-recover",
    name: "Recover Shopify Orders Into Pipeline",
    triggers: [{ event: "shopify/order.recover" }],
    retries: 1,
  },
  async ({ event, step }) => {
    const data = (event.data || {}) as RecoverInput;
    const source = data.source === "reconciliation" ? "reconciliation" : "manual";
    let requestedIds = normalizeTokens(data.shopifyOrderIds);
    const requestedNames = normalizeTokens(data.shopifyOrderNames);
    const force = Boolean(data.force);
    const shopDomainHint = String(data.shopifyStore || "").trim() || null;

    if (source === "reconciliation") {
      if (requestedNames.length === 0) {
        throw new Error("reconciliation recover requires shopifyOrderNames (Shopify order names)");
      }
      requestedIds = [];
    }

    if (requestedIds.length === 0 && requestedNames.length === 0) {
      throw new Error("No shopifyOrderNames (or legacy shopifyOrderIds) provided");
    }

    const fetchedOrders = new Map<string, ShopifyOrder>();
    const failures: Array<{ input: string; reason: string }> = [];

    await step.run("fetch-orders-from-shopify", async () => {
      for (const raw of requestedIds) {
        const id = toNumericShopifyOrderId(raw);
        if (!id) {
          failures.push({ input: raw, reason: "invalid_shopify_order_id" });
          continue;
        }
        try {
          const order = await getOrder(id, shopDomainHint);
          const k = String(order.id || "").trim();
          if (k) fetchedOrders.set(k, order);
        } catch (error) {
          failures.push({
            input: raw,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      for (const name of requestedNames) {
        try {
          const order = await getOrderByShopifyName(name, shopDomainHint);
          if (!order?.id) {
            failures.push({ input: name, reason: "order_not_found_by_name" });
            continue;
          }
          const key = String(order.id || "").trim();
          if (key) fetchedOrders.set(key, order);
        } catch (error) {
          failures.push({
            input: name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    const orders = Array.from(fetchedOrders.values());
    if (orders.length === 0) {
      return {
        status: "no_orders_resolved",
        requestedIds: requestedIds.length,
        requestedNames: requestedNames.length,
        failures,
      };
    }

    const supabase = getSupabaseClient();
    const existingRaw: { idKeys: string[]; nameKeys: string[] } =
      !force && supabase
        ? await step.run("lookup-existing-hub-orders", async () =>
            fetchExistingHubOrderKeys({
              supabase,
              shopifyOrderIds: orders.map((o) => String(o.id)),
              shopifyOrderNames: orders.map((o) => String(o.name || "")).filter(Boolean),
            })
          )
        : { idKeys: [], nameKeys: [] };
    const existing = {
      idKeys: new Set(existingRaw.idKeys),
      nameKeys: new Set(existingRaw.nameKeys),
    };

    const queued: Array<{ shopifyOrderId: string; shopifyOrderName: string; eventName: string }> = [];
    const skipped: Array<{ shopifyOrderId: string; shopifyOrderName: string; reason: string }> = [];

    await step.run("dispatch-replay-events", async () => {
      for (const order of orders) {
        const shopifyOrderId = String(order.id || "").trim();
        const shopifyOrderName = String(order.name || "").trim();
        if (!shopifyOrderId || !shopifyOrderName) {
          skipped.push({
            shopifyOrderId,
            shopifyOrderName,
            reason: "missing_order_identity",
          });
          continue;
        }

        if (!force) {
          const alreadyInHub =
            existing.idKeys.has(shopifyOrderId) || existing.nameKeys.has(shopifyOrderName);
          if (alreadyInHub) {
            skipped.push({
              shopifyOrderId,
              shopifyOrderName,
              reason: "already_exists_in_hub",
            });
            continue;
          }
        }

        const replayEventName = resolveReplayEventName(order);
        const result = await inngest.send({
          name: replayEventName,
          data: {
            shopifyOrderId,
            shopifyOrderName,
            shopifyStore: shopDomainHint || config.shopify.im8.shopDomain,
            orderJson: order as unknown,
            receivedAt: new Date().toISOString(),
          },
        });
        queued.push({
          shopifyOrderId,
          shopifyOrderName,
          eventName: replayEventName,
        });
        console.log(
          `[recover-order] queued ${replayEventName} for ${shopifyOrderName} (${shopifyOrderId}) ids=${JSON.stringify(
            result.ids || []
          )}`
        );
      }
    });

    return {
      status: "completed",
      requestedIds: requestedIds.length,
      requestedNames: requestedNames.length,
      resolvedOrders: orders.length,
      queuedCount: queued.length,
      skippedCount: skipped.length,
      queued,
      skipped,
      failures,
      force,
      requestedBy: data.requestedBy || null,
      source,
    };
  }
);
