import { randomUUID } from "crypto";

import { NextRequest, NextResponse } from "next/server";

import { inngest } from "@/inngest/client";
import { requireServiceAuth } from "@/lib/auth/service-auth";

const OPERATIONS = {
  "pending-actions.drain": "admin/pending-actions.drain",
  "webhook-inbox.drain": "admin/webhook-inbox.drain",
  "webhook-outbox.replay": "admin/webhook-outbox.replay",
  "openai-ads.redeliver": "admin/openai-ads.redeliver",
  "inventory.sync": "inventory/sync.requested",
  "reconciliation.run": "reconciliation/run",
  "order.recover": "shopify/order.recover",
  "gps-fulfilment.recover": "gps/recover.fulfilment",
} as const;

type Operation = keyof typeof OPERATIONS;

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function validate(operation: Operation, input: Record<string, unknown>): string | null {
  if (operation === "webhook-outbox.replay") {
    const outboxId = String(input.outboxId || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(outboxId)) {
      return "outboxId must be a valid UUID";
    }
  }
  if (operation === "openai-ads.redeliver" && !String(input.eventId || "").trim()) {
    return "eventId is required";
  }
  if (operation === "order.recover" && strings(input.shopifyOrderNames).length === 0) {
    return "shopifyOrderNames must contain at least one order";
  }
  if (operation === "gps-fulfilment.recover" && !String(input.shopifyOrderName || "").trim()) {
    return "shopifyOrderName is required";
  }
  if (operation === "reconciliation.run") {
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (!date.test(String(input.dateFrom || "")) || !date.test(String(input.dateTo || ""))) {
      return "dateFrom and dateTo must use YYYY-MM-DD";
    }
  }
  if (operation === "inventory.sync") {
    const allowed = new Set(["gps", "d365", "shopify"]);
    const steps = strings(input.steps);
    if (steps.length === 0 || steps.some((step) => !allowed.has(step))) {
      return "steps must contain gps, d365, or shopify";
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const operation = String(body?.operation || "") as Operation;
  if (!(operation in OPERATIONS)) {
    return NextResponse.json(
      { error: "Unsupported operation", allowedOperations: Object.keys(OPERATIONS) },
      { status: 400 }
    );
  }

  const input =
    body?.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : {};
  const validationError = validate(operation, input);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  const requestId =
    typeof body?.requestId === "string" && body.requestId.trim()
      ? body.requestId.trim()
      : randomUUID();
  const requestedAt = new Date().toISOString();
  const eventData: Record<string, unknown> = {
    ...input,
    source: "battle-hub-admin",
    requestedAt,
    requestId,
  };
  if (operation === "inventory.sync") {
    eventData.syncId = String(input.syncId || `admin-${requestId}`);
  }

  const result = await inngest.send({
    id: `admin-${operation}-${requestId}`,
    name: OPERATIONS[operation],
    data: eventData,
  });
  return NextResponse.json(
    { success: true, queued: true, operation, requestId, eventIds: result.ids || [] },
    { status: 202 }
  );
}

export async function GET(request: NextRequest) {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  return NextResponse.json({ operations: Object.keys(OPERATIONS) });
}
