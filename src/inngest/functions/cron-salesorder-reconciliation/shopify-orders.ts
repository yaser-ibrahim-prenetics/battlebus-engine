import { config } from "@/lib/config";
import { shopifyAdminGraphql } from "@/lib/clients/shopify";
import { orderCreatedAtInUtcHalfOpenWindow } from "./date-range";
import { reconTrace } from "./trace";
import type { ReconType, ShopifyWindowOrder } from "./types";

export async function fetchShopifyWindowOrders(params: {
  createdAtFromIso: string;
  /** Exclusive end UTC instant (first instant not included). */
  createdAtBeforeIso: string;
  extraQuery?: string;
  trace?: { runId: string; type: ReconType };
}): Promise<ShopifyWindowOrder[]> {
  const items: ShopifyWindowOrder[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  let pageIndex = 0;
  let skippedOutsideCreatedAtWindow = 0;

  const query = `
    query ReconciliationWindowOrders($query: String!, $after: String) {
      orders(first: 250, query: $query, after: $after, reverse: false, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            cancelledAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  type ShopifyOrdersQueryResponse = {
    data?: {
      orders?: {
        edges?: Array<{
          cursor?: string;
          node?: {
            id?: string;
            name?: string;
            createdAt?: string | null;
            cancelledAt?: string | null;
            displayFinancialStatus?: string | null;
            displayFulfillmentStatus?: string | null;
            totalPriceSet?: {
              shopMoney?: { amount?: string | null; currencyCode?: string | null } | null;
            } | null;
          };
        }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
  };

  const { createdAtFromIso, createdAtBeforeIso } = params;
  const baseQuery = `created_at:>=${createdAtFromIso} created_at:<${createdAtBeforeIso}`;
  const shopifyQuery = params.extraQuery ? `${baseQuery} ${params.extraQuery}` : baseQuery;

  const { trace } = params;
  if (trace) {
    reconTrace(trace.runId, trace.type, "shopify_window_start", {
      shopifyQuery,
      createdAtFromIso,
      createdAtBeforeIso,
      windowMode: "utc",
      extraQuery: params.extraQuery ?? null,
    });
  }

  while (hasNextPage) {
    pageIndex += 1;
    const res: ShopifyOrdersQueryResponse = await shopifyAdminGraphql<ShopifyOrdersQueryResponse>(
      query,
      {
        query: shopifyQuery,
        after: cursor,
      }
    );

    const edges = res?.data?.orders?.edges || [];
    const pageInfo = res?.data?.orders?.pageInfo;
    if (trace && config.reconciliation.verboseLog) {
      reconTrace(trace.runId, trace.type, "shopify_window_page", {
        page: pageIndex,
        edgeCount: edges.length,
        hasNextPage: Boolean(pageInfo?.hasNextPage),
      });
    }
    for (const edge of edges) {
      const name = String(edge?.node?.name || "").trim();
      if (!name) continue;
      if (edge?.node?.cancelledAt) continue;
      const createdAt = String(edge?.node?.createdAt || "").trim();
      if (!orderCreatedAtInUtcHalfOpenWindow(createdAt, createdAtFromIso, createdAtBeforeIso)) {
        skippedOutsideCreatedAtWindow += 1;
        continue;
      }
      const amount = edge?.node?.totalPriceSet?.shopMoney?.amount;
      items.push({
        id: String(edge?.node?.id || ""),
        name,
        createdAt,
        financialStatus: String(edge?.node?.displayFinancialStatus || "").toUpperCase(),
        fulfillmentStatus: String(edge?.node?.displayFulfillmentStatus || "").toUpperCase(),
        totalPrice: amount != null && amount !== "" ? String(amount) : null,
      });
    }
    const endCursor =
      pageInfo?.endCursor || (edges.length > 0 ? edges[edges.length - 1]?.cursor : null) || null;
    cursor = endCursor;
    hasNextPage = Boolean(pageInfo?.hasNextPage && cursor);
  }

  // Dedupe by name (keep latest createdAt if duplicates).
  const byName = new Map<string, ShopifyWindowOrder>();
  for (const it of items) {
    const prev = byName.get(it.name);
    if (!prev || (it.createdAt && it.createdAt > (prev.createdAt || ""))) {
      byName.set(it.name, it);
    }
  }
  const unique = Array.from(byName.values());
  if (trace) {
    const sorted = unique.map((o) => o.name).sort();
    const head = sorted.slice(0, 8);
    const tail = sorted.length > 16 ? sorted.slice(-8) : [];
    reconTrace(trace.runId, trace.type, "shopify_window_done", {
      pages: pageIndex,
      rowsRaw: items.length,
      graphQLEdgesSkippedWrongCreatedAt: skippedOutsideCreatedAtWindow,
      uniqueOrderCount: unique.length,
      sampleNamesStart: head,
      sampleNamesEnd: tail.length ? tail : undefined,
    });
  }
  return unique;
}
