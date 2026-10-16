import { createHash } from "crypto";

import { NextRequest, NextResponse } from "next/server";

import { requireServiceAuth } from "@/lib/auth/service-auth";
import { getWarehouseMapping } from "@/lib/services/inventory-sync";
import { mapDynamicsSkuToShopify } from "@/lib/transformers/sku";
import { publishWebhookEvents } from "@/lib/webhooks/publish-with-inbox";

type InventoryLine = { itemNumber: string; quantity: number };

function parseLines(value: unknown): InventoryLine[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const lines: InventoryLine[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const line = raw as Record<string, unknown>;
    const itemNumber = String(line.itemNumber || "").trim();
    const quantity = Number(line.quantity);
    if (!itemNumber || !Number.isFinite(quantity) || quantity < 0) return null;
    lines.push({ itemNumber, quantity: Math.trunc(quantity) });
  }
  return lines;
}

export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request, {
    envVars: [
      "DYNAMICS_INVENTORY_WEBHOOK_SECRET",
      "DYNAMICS_FULFILLMENT_WEBHOOK_SECRET",
      "BATTLE_BUS_WEBHOOK_SECRET",
    ],
  });
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const dataAreaId = String(body?.dataAreaId || "").trim().toUpperCase();
  const lines = parseLines(body?.available);
  if (!dataAreaId || !lines) {
    return NextResponse.json(
      { error: "dataAreaId and available[{itemNumber, quantity}] are required" },
      { status: 400 }
    );
  }

  const mapping = await getWarehouseMapping(dataAreaId);
  if (!mapping?.shopifyLocationId) {
    return NextResponse.json(
      { error: `No Shopify location is mapped to D365 data area ${dataAreaId}` },
      { status: 422 }
    );
  }

  const digest = createHash("sha256")
    .update(JSON.stringify({ dataAreaId, lines }))
    .digest("hex")
    .slice(0, 24);
  const receivedAt = new Date().toISOString();
  const events = lines.map((line, index) => ({
    id: `d365-inventory-${dataAreaId}-${digest}-${index}`,
    name: "inventory/sync",
    data: {
      source: "dynamics",
      destination: "shopify",
      payload: {
        sku: mapDynamicsSkuToShopify(line.itemNumber),
        quantity: line.quantity,
        locationId: mapping.shopifyLocationId,
        dataAreaId,
        action: "update",
        source: "dynamics",
        destination: "shopify",
        timestamp: receivedAt,
        reason: "d365_inventory_notification",
      },
    },
  }));

  const result = await publishWebhookEvents({
    source: "dynamics_inventory",
    topic: "inventory/sync",
    payload: { dataAreaId, available: lines },
    headers: Object.fromEntries(request.headers.entries()),
    events,
  });
  if (!result.published) {
    return NextResponse.json(
      { received: false, error: "inngest_publication_failed", requestId: digest },
      { status: 502 }
    );
  }

  return NextResponse.json(
    { received: true, requestId: digest, dataAreaId, queued: events.length },
    { status: 202 }
  );
}

export async function GET() {
  return NextResponse.json({ ok: true, path: "/api/webhooks/dynamics/inventory" });
}
