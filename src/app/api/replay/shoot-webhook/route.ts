import { NextRequest, NextResponse } from "next/server";

const BATTLE_BUS_URL =
  process.env.BATTLE_BUS_URL || "https://battle-bus.vercel.app";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      topic,
      shopDomain,
      hmac,
      webhookId,
      apiVersion,
      payload,
    }: {
      topic: string;
      shopDomain: string;
      hmac?: string;
      webhookId?: string;
      apiVersion?: string;
      payload: unknown;
    } = body;

    if (!topic || !shopDomain || !payload) {
      return NextResponse.json(
        { error: "Missing required fields (topic, shopDomain, payload)" },
        { status: 400 }
      );
    }

    const targetUrl = `${BATTLE_BUS_URL}/api/webhooks/shopify`;

    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": shopDomain,
        ...(hmac ? { "x-shopify-hmac-sha256": hmac } : {}),
        ...(webhookId ? { "x-shopify-webhook-id": webhookId } : {}),
        "x-shopify-api-version": apiVersion || "2025-01",
      },
      body: JSON.stringify(payload),
    });

    const responseJson = await res
      .json()
      .catch(() => ({ raw: "non-json response" }));

    return NextResponse.json(
      {
        ok: res.ok,
        status: res.status,
        response: responseJson,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[replay/shoot-webhook] Error:", error);
    return NextResponse.json(
      { error: "Internal error sending webhook" },
      { status: 500 }
    );
  }
}


