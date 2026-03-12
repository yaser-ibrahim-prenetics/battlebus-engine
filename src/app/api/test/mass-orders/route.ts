// ============================================================================
// MASS ORDER TEST RUNNER (Battle Bus API)
// ============================================================================
// Generates synthetic Shopify order payloads and fires them into Inngest
// for full pipeline testing (D365 + GPS) without hitting Shopify.
//
// POST /api/test/mass-orders
//   Body: { count, distribution?, sku?, testRunId? }
//   Returns: { testRunId, orders: [{ id, name, country, sku }] }
//
// Orders are distributed across countries to exercise different warehouse
// routing paths. TAG_WAIT is always skipped for test orders (testMode=true).

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

// ─── Address templates per country ───────────────────────────────────────────

const ADDRESS_BY_COUNTRY: Record<string, object> = {
  GB: {
    first_name: "James", last_name: "Smith",
    address1: "221B Baker Street", city: "London",
    country: "United Kingdom", country_code: "GB",
    zip: "NW1 6XE", province: "England", province_code: "ENG",
    phone: "+447911123456", company: null, address2: null,
    latitude: 51.5237, longitude: -0.1585, name: "James Smith",
  },
  HK: {
    first_name: "Wei", last_name: "Chen",
    address1: "1 Harbour Road", city: "Hong Kong",
    country: "Hong Kong SAR China", country_code: "HK",
    zip: "000000", province: "Hong Kong", province_code: "HK",
    phone: "+85212345678", company: null, address2: null,
    latitude: 22.2793, longitude: 114.1628, name: "Wei Chen",
  },
  US: {
    first_name: "Mike", last_name: "Johnson",
    address1: "350 Fifth Avenue", city: "New York",
    country: "United States", country_code: "US",
    zip: "10118", province: "New York", province_code: "NY",
    phone: "+12125551234", company: null, address2: null,
    latitude: 40.7484, longitude: -73.9967, name: "Mike Johnson",
  },
  SG: {
    first_name: "Priya", last_name: "Tan",
    address1: "1 Marina Boulevard", city: "Singapore",
    country: "Singapore", country_code: "SG",
    zip: "018989", province: "Singapore", province_code: "SG",
    phone: "+6591234567", company: null, address2: null,
    latitude: 1.2897, longitude: 103.8501, name: "Priya Tan",
  },
  AU: {
    first_name: "Sarah", last_name: "Wilson",
    address1: "1 Market Street", city: "Sydney",
    country: "Australia", country_code: "AU",
    zip: "2000", province: "New South Wales", province_code: "NSW",
    phone: "+61212345678", company: null, address2: null,
    latitude: -33.8688, longitude: 151.2093, name: "Sarah Wilson",
  },
  DE: {
    first_name: "Anna", last_name: "Müller",
    address1: "Unter den Linden 1", city: "Berlin",
    country: "Germany", country_code: "DE",
    zip: "10117", province: "Berlin", province_code: "BE",
    phone: "+4930123456", company: null, address2: null,
    latitude: 52.5166, longitude: 13.3806, name: "Anna Müller",
  },
};

const CURRENCY_BY_COUNTRY: Record<string, string> = {
  GB: "GBP", HK: "HKD", US: "USD", SG: "SGD", AU: "AUD", DE: "EUR",
};

const DEFAULT_DISTRIBUTION: Record<string, number> = {
  GB: 0.30, HK: 0.20, US: 0.20, SG: 0.15, AU: 0.10, DE: 0.05,
};

const SKU_PRESETS = [
  { sku: "IM8-FG-000035", price: 79.0, title: "Daily Ultimate Essentials (30 days)" },
  { sku: "IM8-FG-000080", price: 79.0, title: "Daily Ultimate Essential" },
  { sku: "IM8-FG-000010", price: 79.0, title: "Daily Ultimate Essentials + Hydration" },
  { sku: "IM8-FG-000011", price: 89.0, title: "Daily Ultimate Longevity" },
  { sku: "IM8-FG-000030", price: 29.0, title: "Daily Ultimate Essentials (7 days)" },
];

// ─── Order generator ──────────────────────────────────────────────────────────

function buildSyntheticOrder(opts: {
  orderId: number;
  orderName: string;
  country: string;
  skuPreset: { sku: string; price: number; title: string };
  testRunId: string;
}) {
  const { orderId, orderName, country, skuPreset, testRunId } = opts;
  const addr = ADDRESS_BY_COUNTRY[country] ?? ADDRESS_BY_COUNTRY["GB"];
  const currency = CURRENCY_BY_COUNTRY[country] ?? "USD";
  const now = new Date().toISOString();

  const money = (amount: string) => ({
    shop_money: { amount, currency_code: currency },
    presentment_money: { amount, currency_code: currency },
  });

  const priceStr = skuPreset.price.toFixed(2);

  return {
    id: orderId,
    name: orderName,
    admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
    email: `test+${testRunId.slice(0, 8)}@im8test.dev`,
    created_at: now,
    updated_at: now,
    closed_at: null,
    number: orderId % 100000,
    note: `[MASS TEST] Run: ${testRunId}`,
    tags: `test-order,mass-test,battle-hub-bulk,test-run-${testRunId}`,
    token: `test-${orderId}`,
    gateway: "stripe",
    test: false,
    total_price: priceStr,
    subtotal_price: priceStr,
    total_tax: "0.00",
    taxes_included: false,
    currency,
    financial_status: "paid",
    confirmed: true,
    total_discounts: "0.00",
    buyer_accepts_marketing: false,
    cancel_reason: null,
    cancelled_at: null,
    contact_email: `test+${testRunId.slice(0, 8)}@im8test.dev`,
    source_name: "web",
    total_line_items_price: priceStr,
    total_outstanding: "0.00",
    fulfillment_status: null,
    shipping_address: addr,
    billing_address: addr,
    customer: {
      id: 9_000_000 + (orderId % 100_000),
      email: `test+${testRunId.slice(0, 8)}@im8test.dev`,
      first_name: (addr as any).first_name,
      last_name: (addr as any).last_name,
      phone: (addr as any).phone,
    },
    line_items: [
      {
        id: orderId * 10,
        variant_id: orderId * 10 + 1,
        product_id: orderId * 10 + 2,
        title: skuPreset.title,
        name: skuPreset.title,
        quantity: 1,
        sku: skuPreset.sku,
        vendor: "IM8",
        requires_shipping: true,
        taxable: false,
        gift_card: false,
        price: priceStr,
        price_set: money(priceStr),
        total_discount: "0.00",
        total_discount_set: money("0.00"),
        variant_title: null,
        fulfillment_service: "manual",
        variant_inventory_management: null,
        tax_lines: [],
      },
    ],
    discount_codes: [],
    note_attributes: [],
    shipping_lines: [],
    tax_lines: [],
    total_price_set: money(priceStr),
    total_tax_set: money("0.00"),
    subtotal_price_set: money(priceStr),
    fulfillments: [],
    refunds: [],
    payment_gateway_names: ["stripe"],
    processing_method: "direct",
    app_id: 580111,
    browser_ip: "127.0.0.1",
    client_details: null,
  };
}

// ─── Distribution helper ──────────────────────────────────────────────────────

function distributeOrders(
  count: number,
  distribution: Record<string, number>
): string[] {
  const countries = Object.keys(distribution);
  const weights = Object.values(distribution);
  const total = weights.reduce((s, w) => s + w, 0);
  const normalized = weights.map((w) => w / total);

  const result: string[] = [];
  const allocated: number[] = normalized.map((p) => Math.floor(count * p));
  let remaining = count - allocated.reduce((s, n) => s + n, 0);

  // Distribute remainder round-robin to countries with highest fractional part
  const fractions = normalized.map((p, i) => ({ i, frac: count * p - allocated[i] }));
  fractions.sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remaining; k++) {
    allocated[fractions[k % fractions.length].i]++;
  }

  countries.forEach((c, i) => {
    for (let j = 0; j < allocated[i]; j++) result.push(c);
  });

  // Shuffle so different countries are interleaved
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      count = 10,
      distribution = DEFAULT_DISTRIBUTION,
      skuIndex = 0,
      testRunId: providedRunId,
    } = body;

    if (typeof count !== "number" || count < 1 || count > 500) {
      return NextResponse.json(
        { error: "count must be between 1 and 500" },
        { status: 400 }
      );
    }

    const testRunId =
      providedRunId ||
      `TR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const sku = SKU_PRESETS[skuIndex % SKU_PRESETS.length];
    const countryList = distributeOrders(count, distribution);

    // Base order ID range: 9_900_000_000_000 + timestamp slice to avoid collisions
    const baseId = 9_900_000_000_000 + (Date.now() % 1_000_000_000);

    const orders: { id: number; name: string; country: string; sku: string }[] = [];
    const inngestEvents: object[] = [];

    countryList.forEach((country, idx) => {
      const orderId = baseId + idx;
      const seq = String(idx + 1).padStart(3, "0");
      const orderName = `TEST-${testRunId.replace(/^TR-/, "")}-${seq}`;

      const orderJson = buildSyntheticOrder({ orderId, orderName, country, skuPreset: sku, testRunId });

      orders.push({ id: orderId, name: orderName, country, sku: sku.sku });

      inngestEvents.push({
        name: "shopify/order.paid",
        id: `mass-test-${testRunId}-${seq}`,
        data: {
          shopifyOrderId: String(orderId),
          shopifyOrderName: orderName,
          shopifyStore: "im8",
          orderJson,
          testMode: true,
          testRunId,
        },
      });
    });

    // Send all events to Inngest in one batch (up to 512 per Inngest limit)
    const BATCH = 512;
    for (let i = 0; i < inngestEvents.length; i += BATCH) {
      await inngest.send(inngestEvents.slice(i, i + BATCH) as any);
    }

    console.log(`[MassTest] Dispatched ${orders.length} test orders for run ${testRunId}`);

    return NextResponse.json({
      ok: true,
      testRunId,
      count: orders.length,
      sku: sku.sku,
      orders,
    });
  } catch (err) {
    console.error("[MassTest] Error:", err);
    return NextResponse.json(
      { error: "Failed to dispatch mass test", message: String(err) },
      { status: 500 }
    );
  }
}
