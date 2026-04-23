// ============================================================================
// DYNAMICS FULFILMENT NOTIFICATION (D365 → Battle Bus → Shopify)
// ============================================================================
// Same role as spock-store POST /v1.0/dynamics/fulfilment/notification.
// Auth: Bearer DYNAMICS_FULFILLMENT_WEBHOOK_SECRET, or ?apiKey= (same value),
// or HMAC x-battle-bus-signature with BATTLE_BUS_WEBHOOK_SECRET (Battle Hub style).

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import type { DynamicsFulfilmentNotificationPayload } from "@/lib/types/dynamics-fulfilment";

function timingSafeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function isAllowedCustomerAccount(body: DynamicsFulfilmentNotificationPayload): boolean {
  const raw = (process.env.D365_FULFILLMENT_SHOPIFY_CUSTOMER_ACCOUNTS || "IM8-SHOPIFY").trim();
  if (!raw) return true;
  if (!body.customerAccount) return true;
  const allowed = raw.split(",").map((s) => s.trim().toUpperCase());
  return allowed.includes(String(body.customerAccount).toUpperCase());
}

function validateBody(body: unknown): { ok: true; data: DynamicsFulfilmentNotificationPayload } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const type = b.type;
  if (type !== "shipment" && type !== "return") return { ok: false, error: "type must be shipment or return" };
  const salesOrderNumber = String(b.salesOrderNumber || "").trim();
  const dataAreaId = String(b.dataAreaId || "").trim();
  if (!salesOrderNumber) return { ok: false, error: "salesOrderNumber is required" };
  if (!dataAreaId) return { ok: false, error: "dataAreaId is required" };
  if (!Array.isArray(b.lines)) return { ok: false, error: "lines must be an array" };
  const lines: DynamicsFulfilmentNotificationPayload["lines"] = [];
  for (const line of b.lines) {
    if (!line || typeof line !== "object") continue;
    const l = line as Record<string, unknown>;
    lines.push({
      quantity: Number(l.quantity),
      itemNumber: String(l.itemNumber ?? ""),
      trackingNumber: String(l.trackingNumber ?? ""),
      shippingSiteId: l.shippingSiteId != null ? String(l.shippingSiteId) : undefined,
      ModeOfDelivery: l.ModeOfDelivery != null ? String(l.ModeOfDelivery) : undefined,
      shippingWarehouseId: l.shippingWarehouseId != null ? String(l.shippingWarehouseId) : null,
      shippingWarehouseLocationId:
        l.shippingWarehouseLocationId != null ? String(l.shippingWarehouseLocationId) : null,
    });
  }
  if (type === "shipment" && lines.some((l) => !l.itemNumber.trim())) {
    return { ok: false, error: "Each line must have itemNumber for shipment" };
  }
  return {
    ok: true,
    data: {
      customerAccount: b.customerAccount != null ? String(b.customerAccount) : undefined,
      type,
      completed: typeof b.completed === "boolean" ? b.completed : undefined,
      salesOrderNumber,
      dataAreaId,
      confirmedShippedDate: b.confirmedShippedDate != null ? String(b.confirmedShippedDate) : undefined,
      lines,
    },
  };
}

function verifyAuth(request: NextRequest, rawBody: string): boolean {
  const bearer = process.env.DYNAMICS_FULFILLMENT_WEBHOOK_SECRET?.trim();
  const hmacSecret = process.env.BATTLE_BUS_WEBHOOK_SECRET?.trim();

  if (!bearer && !hmacSecret) {
    return false;
  }

  const q = request.nextUrl.searchParams.get("apiKey");
  if (bearer && q && timingSafeEqual(q, bearer)) return true;

  const auth = request.headers.get("authorization")?.trim();
  if (bearer && auth === `Bearer ${bearer}`) return true;

  if (hmacSecret) {
    const sig = request.headers.get("x-battle-bus-signature")?.trim();
    if (sig) {
      const expected = crypto.createHmac("sha256", hmacSecret).update(rawBody).digest("hex");
      try {
        if (timingSafeEqual(sig, expected)) return true;
      } catch {
        return false;
      }
    }
  }

  return false;
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  if (!verifyAuth(request, rawBody)) {
    const hasAny =
      Boolean(process.env.DYNAMICS_FULFILLMENT_WEBHOOK_SECRET?.trim()) ||
      Boolean(process.env.BATTLE_BUS_WEBHOOK_SECRET?.trim());
    if (!hasAny) {
      return NextResponse.json(
        { error: "Configure DYNAMICS_FULFILLMENT_WEBHOOK_SECRET and/or BATTLE_BUS_WEBHOOK_SECRET" },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const validation = validateBody(parsed);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const payload = validation.data;
  if (!isAllowedCustomerAccount(payload)) {
    return new NextResponse(null, { status: 202 });
  }

  const lineKey = crypto.createHash("sha256").update(JSON.stringify(payload.lines)).digest("hex").slice(0, 24);
  const id = `dynamics-fulfill-${payload.salesOrderNumber}-${lineKey}`;

  await inngest.send({
    id,
    name: "dynamics/fulfillment.notify",
    data: {
      ...payload,
      receivedAt: new Date().toISOString(),
    },
  });

  return NextResponse.json({ received: true }, { status: 202 });
}

export async function GET() {
  return NextResponse.json({ ok: true, path: "/api/webhooks/dynamics/fulfillment" });
}
