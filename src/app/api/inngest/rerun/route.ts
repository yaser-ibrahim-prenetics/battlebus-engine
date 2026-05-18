// ============================================================================
// INNGEST RERUN API (Battle Bus)
// ============================================================================
// Allows battle-hub to trigger event reruns via the Inngest client
// This endpoint fetches the order from Shopify and sends a new event
// Inngest's durable execution will skip already-completed steps

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { searchOrdersByName } from "@/lib/clients/shopify";

const INNGEST_API_URL = process.env.INNGEST_API_URL || "https://api.inngest.com";

/** Inngest Cloud does not expose `POST /v1/runs/{id}/rerun`; replay is done by re-sending the source event. */
async function ingApiFetch(path: string, signingKey: string): Promise<Response> {
  return fetch(`${INNGEST_API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${signingKey}`,
      "Content-Type": "application/json",
    },
  });
}

const RUN_ID_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * After a new event is sent, the function run is created shortly after. Poll
 * `GET /v1/events/{eventId}/runs` so the Hub can persist the new `run_id` on the order.
 */
async function waitForNewRunIdForEvent(
  eventId: string,
  signingKey: string,
  maxAttempts = 32,
  delayMs = 250
): Promise<string | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await ingApiFetch(`/v1/events/${encodeURIComponent(eventId)}/runs`, signingKey);
    if (res.ok) {
      const j: unknown = await res.json();
      const listRaw =
        j && typeof j === "object" && j !== null && "data" in (j as object)
          ? (j as { data: unknown }).data
          : j;
      const runs = Array.isArray(listRaw) ? listRaw : [];
      const first = runs[0] as Record<string, unknown> | undefined;
      const rid = first?.run_id ?? first?.id;
      if (typeof rid === "string" && RUN_ID_ULID.test(rid.trim())) {
        return rid.trim();
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/** `GET /v1/runs` may be `{ data: run }` or a run object at the root. */
function parseRunFromApiJson(json: unknown): Record<string, unknown> {
  if (!json || typeof json !== "object") return {};
  const o = json as Record<string, unknown>;
  const hasRunFields =
    o.event_id != null || o.run_id != null || (typeof o.id === "string" && o.id.length >= 20);
  if (!hasRunFields && o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
    return o.data as Record<string, unknown>;
  }
  return o;
}

/**
 * `GET /v1/events` returns `{ name, data: payload, ... }` — do not treat `data` as an API envelope
 * (that would drop `name` and leave only the payload object).
 */
function parseEventFromApiJson(
  json: unknown
): { name: string; data: Record<string, unknown> } {
  if (!json || typeof json !== "object") return { name: "", data: {} };
  const o = json as Record<string, unknown>;
  if (typeof o.name === "string" && o.name.length > 0) {
    const d = o.data;
    return {
      name: o.name,
      data: d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {},
    };
  }
  if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
    const inner = o.data as Record<string, unknown>;
    if (typeof inner.name === "string" && inner.name.length > 0) {
      const d = inner.data;
      return {
        name: inner.name,
        data: d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {},
      };
    }
  }
  return { name: "", data: {} };
}

function extractInternalEventIdFromRun(run: Record<string, unknown>): string | null {
  const fromEvent = run.event as Record<string, unknown> | undefined;
  const fromTrigger = run.trigger as Record<string, unknown> | undefined;
  const raw =
    run.event_id ??
    fromEvent?.internal_id ??
    fromEvent?.id ??
    fromEvent?.event_id ??
    fromTrigger?.event_id;
  const s = typeof raw === "string" ? raw.trim() : "";
  return s.length > 0 ? s : null;
}

/**
 * Functions that key idempotency on `event.data.shopifyOrderId` only need a mutated id for replay.
 * @see process-shopify-order, process-order-cancellation, process-subscription-order
 */
function applyReplayDataMutations(
  eventName: string,
  data: Record<string, unknown>,
  sourceRunId: string
): Record<string, unknown> {
  const ts = Date.now();
  const out: Record<string, unknown> = { ...data };
  out.isRerun = true;
  out.battleHubReplayOfRunId = sourceRunId;

  const shopifyIdOnlyRerunNames = new Set([
    "shopify/order.paid",
    "shopify/order.created",
    "shopify/order.cancelled",
    "shopify/subscription.renewed",
  ]);

  if (shopifyIdOnlyRerunNames.has(eventName) && out.shopifyOrderId != null) {
    const raw = String(out.shopifyOrderId);
    const base = raw.split("-rerun-")[0] || raw;
    out.shopifyOrderId = `${base}-rerun-${ts}`;
    if (out.originalShopifyOrderId == null) out.originalShopifyOrderId = base;
  }

  return out;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { runId, eventId, eventName, eventData, orderName } = body;

    // If orderName is provided, fetch the order from Shopify and trigger reprocess
    if (orderName) {
      // Shopify order names include the # prefix (e.g., #IM8-14931)
      // Ensure we search with the correct format
      const searchName = orderName.startsWith("#") ? orderName : `#${orderName}`;
      console.log(`[Inngest Rerun] Fetching order ${searchName} from Shopify for reprocess`);

      // Fetch the full order from Shopify
      const orders = await searchOrdersByName(searchName);
      const shopifyOrder = orders?.[0];

      if (!shopifyOrder) {
        return NextResponse.json(
          { error: `Order ${orderName} not found in Shopify` },
          { status: 404 }
        );
      }

      const rerunTimestamp = Date.now();
      const resolvedEventName =
        typeof eventName === "string" && eventName.trim().length > 0
          ? eventName.trim()
          : "shopify/order.paid";

      // Hub bulk "Rerun fulfillments" — replay fulfillment → D365 pipeline from current Shopify payloads.
      if (resolvedEventName === "shopify/order.fulfilled") {
        const orderAny = shopifyOrder as unknown as Record<string, unknown>;
        const fulfillments = Array.isArray(orderAny.fulfillments) ? orderAny.fulfillments : [];
        if (fulfillments.length === 0) {
          return NextResponse.json(
            {
              error: `Order ${orderName} has no fulfillments in Shopify — nothing to send for fulfillment rerun.`,
            },
            { status: 400 }
          );
        }

        const eventPayload = {
          name: "shopify/order.fulfilled" as const,
          data: {
            shopifyOrderId: `${shopifyOrder.id}-rerun-${rerunTimestamp}`,
            originalShopifyOrderId: String(shopifyOrder.id),
            shopifyOrderName: shopifyOrder.name,
            shopifyStore: "im8-battle-bus",
            orderJson: shopifyOrder,
            fulfillments,
            receivedAt: new Date().toISOString(),
            source: "battle-hub",
            isRerun: true,
            ...(eventData?.fromStart !== undefined && { fromStart: eventData.fromStart }),
          },
        };

        const result = await inngest.send(eventPayload);

        return NextResponse.json({
          success: true,
          message: `Fulfillment rerun event sent for order ${orderName}`,
          eventId: result.ids?.[0],
        });
      }

      // Default: full order pipeline (shopify/order.paid)
      const eventPayload = {
        name: resolvedEventName,
        data: {
          shopifyOrderId: `${shopifyOrder.id}-rerun-${rerunTimestamp}`,
          originalShopifyOrderId: String(shopifyOrder.id),
          shopifyOrderName: shopifyOrder.name,
          shopifyStore: "im8-battle-bus",
          orderJson: shopifyOrder,
          reprocessedAt: new Date().toISOString(),
          source: "battle-hub",
          receivedAt: new Date().toISOString(),
          isRerun: true,
          ...(eventData?.fromStart !== undefined && { fromStart: eventData.fromStart }),
        },
      };

      const result = await inngest.send(eventPayload);

      return NextResponse.json({
        success: true,
        message: `Reprocess event sent for order ${orderName}`,
        eventId: result.ids?.[0],
      });
    }

    // If eventId is provided (Firestore order ID), we need to look up the order name first
    if (eventId && eventData?.orderName) {
      // If orderName is in eventData, use that to fetch from Shopify
      // Shopify order names include the # prefix (e.g., #IM8-14931)
      const rawOrderName = eventData.orderName;
      const shopifyOrderName = rawOrderName.startsWith("#") ? rawOrderName : `#${rawOrderName}`;
      console.log(`[Inngest Rerun] Fetching order ${shopifyOrderName} from Shopify`);

      const orders = await searchOrdersByName(shopifyOrderName);
      const shopifyOrder = orders?.[0];

      if (!shopifyOrder) {
        return NextResponse.json(
          { error: `Order ${shopifyOrderName} not found in Shopify` },
          { status: 404 }
        );
      }

      const rerunTimestamp = Date.now();
      const resolvedEventName =
        typeof eventName === "string" && eventName.trim().length > 0
          ? eventName.trim()
          : "shopify/order.paid";

      if (resolvedEventName === "shopify/order.fulfilled") {
        const orderAny = shopifyOrder as unknown as Record<string, unknown>;
        const fulfillments = Array.isArray(orderAny.fulfillments) ? orderAny.fulfillments : [];
        if (fulfillments.length === 0) {
          return NextResponse.json(
            {
              error: `Order ${shopifyOrderName} has no fulfillments in Shopify — nothing to send for fulfillment rerun.`,
            },
            { status: 400 }
          );
        }

        const result = await inngest.send({
          name: "shopify/order.fulfilled",
          data: {
            shopifyOrderId: `${shopifyOrder.id}-rerun-${rerunTimestamp}`,
            originalShopifyOrderId: String(shopifyOrder.id),
            shopifyOrderName: shopifyOrder.name,
            shopifyStore: "im8-battle-bus",
            orderJson: shopifyOrder,
            fulfillments,
            receivedAt: new Date().toISOString(),
            source: "battle-hub",
            isRerun: true,
          },
        });

        return NextResponse.json({
          success: true,
          message: `Fulfillment rerun event sent for order ${shopifyOrderName}`,
          eventId: result.ids?.[0],
        });
      }

      const eventPayload = {
        name: resolvedEventName,
        data: {
          shopifyOrderId: `${shopifyOrder.id}-rerun-${rerunTimestamp}`,
          originalShopifyOrderId: String(shopifyOrder.id),
          shopifyOrderName: shopifyOrder.name,
          shopifyStore: "im8-battle-bus",
          orderJson: shopifyOrder,
          reprocessedAt: new Date().toISOString(),
          source: "battle-hub",
          receivedAt: new Date().toISOString(),
          isRerun: true,
        },
      };

      const result = await inngest.send(eventPayload);

      return NextResponse.json({
        success: true,
        message: `Rerun event sent for order ${shopifyOrderName}`,
        eventId: result.ids?.[0],
      });
    }

    // Legacy: If only eventId is provided without orderName, send a generic rerun event
    if (eventId) {
      console.warn(`[Inngest Rerun] eventId provided without orderName - this may fail validation`);
      const eventPayload = {
        name: eventName || "support/rerun",
        data: {
          eventId,
          rerunAt: new Date().toISOString(),
          source: "battle-hub",
          ...eventData,
        },
      };

      const result = await inngest.send(eventPayload);

      return NextResponse.json({
        success: true,
        message: `Rerun event sent for eventId ${eventId}`,
        eventId: result.ids?.[0],
      });
    }

    // If runId is provided: Inngest Cloud has no public `POST /v1/runs/{id}/rerun`.
    // Load the run → load its source event via REST → re-send with `inngest.send()`.
    if (runId) {
      const INNGEST_SIGNING_KEY = process.env.INNGEST_SIGNING_KEY;

      if (!INNGEST_SIGNING_KEY) {
        return NextResponse.json({ error: "INNGEST_SIGNING_KEY not configured" }, { status: 500 });
      }

      const runRes = await ingApiFetch(`/v1/runs/${encodeURIComponent(String(runId))}`, INNGEST_SIGNING_KEY);
      if (!runRes.ok) {
        const errText = await runRes.text();
        return NextResponse.json(
          { error: `Failed to load Inngest run: ${errText || runRes.statusText}` },
          { status: runRes.status }
        );
      }

      const runJson: unknown = await runRes.json();
      const run = parseRunFromApiJson(runJson);
      const internalEventId = extractInternalEventIdFromRun(run);

      if (!internalEventId) {
        return NextResponse.json(
          {
            error:
              "Could not resolve an internal event id for this run; replay is only supported for runs linked to a stored Inngest event.",
          },
          { status: 422 }
        );
      }

      const eventRes = await ingApiFetch(
        `/v1/events/${encodeURIComponent(internalEventId)}`,
        INNGEST_SIGNING_KEY
      );
      if (!eventRes.ok) {
        const errText = await eventRes.text();
        return NextResponse.json(
          { error: `Failed to load Inngest event ${internalEventId}: ${errText || eventRes.statusText}` },
          { status: eventRes.status }
        );
      }

      const eventJson: unknown = await eventRes.json();
      const { name, data: dataObj } = parseEventFromApiJson(eventJson);
      if (!name) {
        return NextResponse.json({ error: "Inngest event is missing a name" }, { status: 422 });
      }

      const newSendId = `hub-rerun-${String(runId)}-${Date.now()}`;
      const prepared = applyReplayDataMutations(name, dataObj, String(runId));

      const result = await inngest.send({
        id: newSendId,
        name,
        data: prepared,
      });

      const newEventId = result.ids?.[0];
      const newRunId =
        typeof newEventId === "string" && newEventId.length > 0
          ? await waitForNewRunIdForEvent(newEventId, INNGEST_SIGNING_KEY)
          : null;

      return NextResponse.json({
        success: true,
        message: `Replayed ${name} (new Inngest event id: ${result.ids?.[0] ?? "unknown"})`,
        data: {
          newEventId: result.ids?.[0],
          newRunId,
          sendIdempotencyKey: newSendId,
          sourceRunId: String(runId),
        },
      });
    }

    return NextResponse.json(
      { error: "Either runId, eventId, or orderName is required" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[Inngest Rerun] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
