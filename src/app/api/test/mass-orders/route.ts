// ============================================================================
// MASS ORDER TEST RUNNER (Battle Bus API)
// ============================================================================
// Generates synthetic Shopify order payloads using:
//  - Real locations pulled live from Shopify
//  - Real products / variants / SKUs pulled live from Shopify
//  - Deterministic dummy customer data for supported store markets
//
// GET /api/test/mass-orders            → { locations, products }  (for UI setup)
// POST /api/test/mass-orders           → dispatch N test orders into Inngest

import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";
import { config } from "@/lib/config";

// ─── Supported markets ────────────────────────────────────────────────────────
// Only generate data for countries where IM8 actively sells.
// Any Shopify location whose country_code is not in this map will be skipped
// in the test run (not dispatched), unless you add it explicitly.

const CUSTOMER_PRESETS = {
  GB: {
    firstNames: ["James", "Oliver", "Amelia", "Sophia", "George", "Isla"],
    lastNames: ["Smith", "Jones", "Taylor", "Brown", "Wilson", "Evans"],
    streets: ["Baker Street", "Kings Road", "High Street", "Victoria Road"],
    city: "London",
    province: "England",
    zipPrefix: "SW1A",
    phonePrefix: "+44 7700",
  },
  HK: {
    firstNames: ["Jason", "Chloe", "Ryan", "Emily", "Marcus", "Hannah"],
    lastNames: ["Chan", "Wong", "Lee", "Lau", "Cheung", "Lam"],
    streets: ["Queens Road Central", "Nathan Road", "Hennessy Road", "Des Voeux Road"],
    city: "Hong Kong",
    province: "Hong Kong",
    zipPrefix: "000",
    phonePrefix: "+852 5",
  },
  AU: {
    firstNames: ["Liam", "Noah", "Charlotte", "Mia", "Jack", "Ella"],
    lastNames: ["Wilson", "Taylor", "Brown", "Anderson", "Thomas", "Walker"],
    streets: ["George Street", "Market Street", "Collins Street", "Elizabeth Street"],
    city: "Sydney",
    province: "New South Wales",
    zipPrefix: "20",
    phonePrefix: "+61 4",
  },
  NZ: {
    firstNames: ["Lucas", "Mason", "Olivia", "Sophie", "Aria", "Leo"],
    lastNames: ["Campbell", "Mitchell", "Reid", "Murray", "Walker", "Clark"],
    streets: ["Queen Street", "Victoria Street", "Albert Street", "Customs Street"],
    city: "Auckland",
    province: "Auckland",
    zipPrefix: "10",
    phonePrefix: "+64 21",
  },
  US: {
    firstNames: ["Michael", "Emma", "Daniel", "Ava", "Ethan", "Grace"],
    lastNames: ["Johnson", "Williams", "Miller", "Davis", "Moore", "Taylor"],
    streets: ["5th Avenue", "Broadway", "Madison Avenue", "Park Avenue"],
    city: "New York",
    province: "New York",
    zipPrefix: "10",
    phonePrefix: "+1 212",
  },
  CA: {
    firstNames: ["Noah", "Benjamin", "Avery", "Harper", "Mila", "Logan"],
    lastNames: ["Martin", "Roy", "Tremblay", "Gagnon", "Lee", "Wilson"],
    streets: ["King Street West", "Yonge Street", "Queen Street", "Bloor Street"],
    city: "Toronto",
    province: "Ontario",
    zipPrefix: "M5",
    phonePrefix: "+1 416",
  },
  DE: {
    firstNames: ["Anna", "Lukas", "Mia", "Leon", "Sophie", "Jonas"],
    lastNames: ["Muller", "Schmidt", "Weber", "Fischer", "Wagner", "Becker"],
    streets: ["Unter den Linden", "Friedrichstrasse", "Alexanderplatz", "Potsdamer Strasse"],
    city: "Berlin",
    province: "Berlin",
    zipPrefix: "10",
    phonePrefix: "+49 30",
  },
  SG: {
    firstNames: ["Ethan", "Cheryl", "Marcus", "Alicia", "Ryan", "Grace"],
    lastNames: ["Tan", "Lim", "Lee", "Ng", "Goh", "Chua"],
    streets: ["Orchard Road", "Shenton Way", "Robinson Road", "Victoria Street"],
    city: "Singapore",
    province: "Singapore",
    zipPrefix: "01",
    phonePrefix: "+65 8",
  },
} as const;

export const SUPPORTED_MARKET_CODES = Object.keys(CUSTOMER_PRESETS);

// Currency per supported market
const CURRENCY_BY_CC: Record<string, string> = {
  GB: "GBP",
  HK: "HKD",
  AU: "AUD",
  NZ: "NZD",
  US: "USD",
  CA: "CAD",
  DE: "EUR",
  SG: "SGD",
};

const DEFAULT_ALLOWED_ORIGINS = [
  "https://battle-hub-three.vercel.app",
  "https://battle-hub.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

const MASS_TEST_PROXY_SECRET =
  process.env.MASS_TEST_PROXY_SECRET || process.env.CONFIG_ENV_PROXY_SECRET || "";

function getAllowedOrigins(): string[] {
  const extraOrigins = (process.env.MASS_TEST_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins])];
}

function buildCorsHeaders(origin: string | null): HeadersInit {
  const allowedOrigins = getAllowedOrigins();
  const allowOrigin =
    origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonWithCors(body: unknown, init: ResponseInit = {}, origin: string | null = null) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...buildCorsHeaders(origin),
      ...(init.headers || {}),
    },
  });
}

function isAuthorized(request: NextRequest): boolean {
  if (!MASS_TEST_PROXY_SECRET) return false;
  const secret = request.headers.get("x-mass-test-proxy-secret") || "";
  return secret === MASS_TEST_PROXY_SECRET;
}

// ─── Shopify helpers ──────────────────────────────────────────────────────────

function shopifyHeaders() {
  return {
    "X-Shopify-Access-Token": config.shopify.im8.accessToken,
    "Content-Type": "application/json",
  };
}

function shopifyUrl(path: string) {
  return `https://${config.shopify.im8.shopDomain}/admin/api/${config.shopify.im8.apiVersion}${path}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestLocation {
  id: string;
  name: string;
  country: string;
  country_code: string;
  city: string | null;
  province: string | null;
  zip: string | null;
  address1: string | null;
}

export interface TestProduct {
  productId: number;
  variantId: number;
  title: string;
  variantTitle: string;
  sku: string;
  price: string;
}

function seededPick<T>(items: readonly T[], seed: number, offset = 0): T {
  return items[Math.abs(seed + offset) % items.length];
}

function seededDigits(seed: number, length: number): string {
  let value = Math.abs(seed);
  let output = "";
  while (output.length < length) {
    value = (value * 9301 + 49297) % 233280;
    output += String(value);
  }
  return output.slice(0, length);
}

function makeEmail(firstName: string, lastName: string, countryCode: string, seed: number): string {
  const local = `${firstName}.${lastName}.${countryCode}.${seededDigits(seed, 4)}`
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
  return `${local}@im8test.dev`;
}

function makeBrowserIp(seed: number): string {
  const octet = (offset: number) => (Math.abs(seed * (offset + 11)) % 253) + 1;
  return `${octet(1)}.${octet(2)}.${octet(3)}.${octet(4)}`;
}

/**
 * Generate deterministic dummy customer data for supported markets only.
 */
function seedCustomer(countryCode: string, seed: number) {
  const preset = CUSTOMER_PRESETS[countryCode as keyof typeof CUSTOMER_PRESETS];
  if (!preset) return undefined;

  const firstName = seededPick(preset.firstNames, seed, 1);
  const lastName = seededPick(preset.lastNames, seed, 2);
  const streetNumber = Number(seededDigits(seed, 3)) + 1;
  const streetName = seededPick(preset.streets, seed, 3);
  const city = preset.city;
  const state = preset.province;
  const zip = `${preset.zipPrefix}${seededDigits(seed, 4)}`;
  const phone = `${preset.phonePrefix} ${seededDigits(seed, 6)}`;
  const email = makeEmail(firstName, lastName, countryCode, seed);

  return {
    firstName,
    lastName,
    phone,
    email,
    street: `${streetNumber} ${streetName}`,
    city,
    state,
    zip,
  };
}

function currencyFor(countryCode: string): string {
  return CURRENCY_BY_CC[countryCode] ?? "USD";
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchShopifyLocations(): Promise<TestLocation[]> {
  const res = await fetch(shopifyUrl("/locations.json"), { headers: shopifyHeaders() });
  if (!res.ok) throw new Error(`Shopify locations error: ${res.status}`);
  const { locations = [] } = await res.json();

  return (locations as any[])
    .filter((l) => {
      if (!l.active) return false;
      const cc = (l.country_code || "").toUpperCase();
      // Only include locations in markets the store actually sells to
      return SUPPORTED_MARKET_CODES.includes(cc);
    })
    .map((l) => ({
      id: String(l.id),
      name: l.name,
      country: l.country_name || l.country || "Unknown",
      country_code: (l.country_code || "US").toUpperCase(),
      city: l.city || null,
      province: l.province || null,
      zip: l.zip || null,
      address1: l.address1 || null,
    }));
}

async function fetchShopifyProducts(): Promise<TestProduct[]> {
  // Fetch up to 50 products with their variants
  const res = await fetch(
    shopifyUrl("/products.json?status=active&limit=50&fields=id,title,variants"),
    { headers: shopifyHeaders() }
  );
  if (!res.ok) throw new Error(`Shopify products error: ${res.status}`);
  const { products = [] } = await res.json();

  const out: TestProduct[] = [];
  for (const p of products as any[]) {
    for (const v of p.variants || []) {
      if (!v.sku) continue;
      out.push({
        productId: p.id,
        variantId: v.id,
        title: p.title,
        variantTitle: v.title || "",
        sku: v.sku,
        price: v.price,
      });
    }
  }
  return out;
}

async function fetchNextShopifyStyleOrderNumber(): Promise<number> {
  const res = await fetch(
    shopifyUrl("/orders.json?status=any&limit=50&fields=name"),
    { headers: shopifyHeaders() }
  );

  if (!res.ok) {
    throw new Error(`Shopify recent orders error: ${res.status}`);
  }

  const { orders = [] } = await res.json();
  let maxOrderNumber = 0;

  for (const order of orders as Array<{ name?: string }>) {
    const match = String(order.name || "").match(/^IM8-(\d+)$/i);
    if (!match) continue;

    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > maxOrderNumber) {
      maxOrderNumber = parsed;
    }
  }

  return maxOrderNumber > 0 ? maxOrderNumber + 1 : 10000;
}

// ─── Synthetic order builder ──────────────────────────────────────────────────

function buildSyntheticOrder(opts: {
  orderId: number;
  orderName: string;
  location: TestLocation;
  product: TestProduct;
  testRunId: string;
  seed: number;
}) {
  const { orderId, orderName, location, product, testRunId, seed } = opts;

  // seedCustomer returns undefined for unsupported markets — callers must guard
  const customer = seedCustomer(location.country_code, seed)!;
  const currency = currencyFor(location.country_code);
  const now = new Date().toISOString();
  const priceStr = product.price;

  const money = (amount: string) => ({
    shop_money: { amount, currency_code: currency },
    presentment_money: { amount, currency_code: currency },
  });

  // Use the real location address as the shipping destination if available,
  // falling back to faker-generated address.
  const shipAddr = {
    first_name: customer.firstName,
    last_name: customer.lastName,
    address1: customer.street,
    address2: null,
    city: location.city ?? customer.city,
    province: location.province ?? customer.state,
    country: location.country,
    country_code: location.country_code,
    zip: location.zip ?? customer.zip,
    phone: customer.phone,
    company: null,
    latitude: null,
    longitude: null,
    name: `${customer.firstName} ${customer.lastName}`,
    province_code: null,
  };

  return {
    id: orderId,
    name: orderName,
    admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
    email: customer.email,
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
    contact_email: customer.email,
    source_name: "web",
    total_line_items_price: priceStr,
    total_outstanding: "0.00",
    fulfillment_status: null,
    shipping_address: shipAddr,
    billing_address: shipAddr,
    customer: {
      id: 9_000_000 + (orderId % 100_000),
      email: customer.email,
      first_name: customer.firstName,
      last_name: customer.lastName,
      phone: customer.phone,
      tags: "",
    },
    line_items: [
      {
        id: orderId * 10,
        variant_id: product.variantId,
        product_id: product.productId,
        title: product.title,
        name: product.variantTitle ? `${product.title} - ${product.variantTitle}` : product.title,
        quantity: 1,
        sku: product.sku,
        vendor: "IM8",
        requires_shipping: true,
        taxable: false,
        gift_card: false,
        price: priceStr,
        price_set: money(priceStr),
        total_discount: "0.00",
        total_discount_set: money("0.00"),
        variant_title: product.variantTitle || null,
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
    browser_ip: makeBrowserIp(seed),
    client_details: null,
  };
}

// ─── GET — return available locations + products for the UI ──────────────────

export async function OPTIONS(req: NextRequest) {
  if (!isAuthorized(req)) {
    return new NextResponse(null, {
      status: 401,
      headers: buildCorsHeaders(req.headers.get("origin")),
    });
  }
  return new NextResponse(null, {
    status: 204,
    headers: buildCorsHeaders(req.headers.get("origin")),
  });
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return jsonWithCors({ error: "Unauthorized" }, { status: 401 }, req.headers.get("origin"));
  }
  try {
    const [locations, products] = await Promise.all([
      fetchShopifyLocations(),
      fetchShopifyProducts(),
    ]);
    return jsonWithCors(
      { locations, products, supportedMarkets: SUPPORTED_MARKET_CODES },
      { status: 200 },
      req.headers.get("origin")
    );
  } catch (err) {
    console.error("[MassTest] GET error:", err);
    return jsonWithCors(
      { error: "Failed to fetch Shopify data", message: String(err) },
      { status: 500 },
      req.headers.get("origin")
    );
  }
}

// ─── POST — dispatch mass test orders ────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return jsonWithCors({ error: "Unauthorized" }, { status: 401 }, req.headers.get("origin"));
  }
  try {
    const body = await req.json();
    const {
      count = 10,
      // distribution: { locationId: weight } — weights are proportions (will be normalised)
      distribution = {} as Record<string, number>,
      // optional fixed productSku or variantId to use for all orders
      sku,
      testRunId: providedRunId,
    } = body;

    if (typeof count !== "number" || count < 1 || count > 500) {
      return jsonWithCors(
        { error: "count must be 1–500" },
        { status: 400 },
        req.headers.get("origin")
      );
    }

    // Fetch live data
    const [locations, products, nextOrderNumber] = await Promise.all([
      fetchShopifyLocations(),
      fetchShopifyProducts(),
      fetchNextShopifyStyleOrderNumber(),
    ]);

    if (locations.length === 0) {
      return jsonWithCors(
        { error: "No active Shopify locations found" },
        { status: 500 },
        req.headers.get("origin")
      );
    }
    if (products.length === 0) {
      return jsonWithCors(
        { error: "No active Shopify products with SKUs found" },
        { status: 500 },
        req.headers.get("origin")
      );
    }

    const testRunId =
      providedRunId ||
      `TR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // Build location→weight map (default: equal weight across all active locations)
    const activeLocationIds = locations.map((l) => l.id);
    const weights: Record<string, number> = {};
    if (Object.keys(distribution).length === 0) {
      // Equal distribution across all locations
      activeLocationIds.forEach((id) => {
        weights[id] = 1;
      });
    } else {
      // Only use locations that exist in Shopify
      Object.entries(distribution).forEach(([id, w]) => {
        if (activeLocationIds.includes(id) && typeof w === "number" && w > 0) weights[id] = w;
      });
      if (Object.keys(weights).length === 0) {
        activeLocationIds.forEach((id) => {
          weights[id] = 1;
        });
      }
    }

    // Distribute count across locations (proportional)
    const locIds = Object.keys(weights);
    const total = Object.values(weights).reduce((s, w) => s + w, 0);
    const allocated: number[] = locIds.map((id) => Math.floor(count * (weights[id] / total)));
    let remaining = count - allocated.reduce((s, n) => s + n, 0);
    const fracs = locIds.map((id, i) => ({ i, f: count * (weights[id] / total) - allocated[i] }));
    fracs.sort((a, b) => b.f - a.f);
    for (let k = 0; k < remaining; k++) allocated[fracs[k % fracs.length].i]++;

    // Flat list of [locationId, ...] repeated by allocation
    const locationSlots: string[] = [];
    locIds.forEach((id, i) => {
      for (let j = 0; j < allocated[i]; j++) locationSlots.push(id);
    });
    // Shuffle
    for (let i = locationSlots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [locationSlots[i], locationSlots[j]] = [locationSlots[j], locationSlots[i]];
    }

    // Resolve which product/variant to use (fixed sku or rotate through available)
    const resolveProduct = (idx: number): TestProduct => {
      if (sku) {
        const found = products.find((p) => p.sku === sku);
        if (found) return found;
      }
      return products[idx % products.length];
    };

    const baseId = 9_900_000_000_000 + (Date.now() % 1_000_000_000);
    const orders: {
      id: number;
      name: string;
      locationId: string;
      locationName: string;
      country: string;
      country_code: string;
      sku: string;
    }[] = [];
    const inngestEvents: object[] = [];

    const runSeedBase = parseInt(testRunId.replace(/\W/g, "").slice(0, 8), 36) || Date.now();

    locationSlots.forEach((locationId, idx) => {
      const location = locations.find((l) => l.id === locationId) ?? locations[0];

      // Belt-and-suspenders: skip if this location's market is somehow unsupported
      if (!SUPPORTED_MARKET_CODES.includes(location.country_code)) {
        console.warn(
          `[MassTest] Skipping location ${location.name} — unsupported market: ${location.country_code}`
        );
        return;
      }

      const orderId = baseId + idx;
      const seq = String(idx + 1).padStart(3, "0");
      const orderName = `IM8-${nextOrderNumber + idx}`;
      const product = resolveProduct(idx);
      const seed = runSeedBase + idx;

      const orderJson = buildSyntheticOrder({
        orderId,
        orderName,
        location,
        product,
        testRunId,
        seed,
      });

      orders.push({
        id: orderId,
        name: orderName,
        locationId,
        locationName: location.name,
        country: location.country,
        country_code: location.country_code,
        sku: product.sku,
      });

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

    // Inngest accepts max 512 events per send call
    const BATCH = 512;
    for (let i = 0; i < inngestEvents.length; i += BATCH) {
      await inngest.send(inngestEvents.slice(i, i + BATCH) as any);
    }

    console.log(`[MassTest] Dispatched ${orders.length} orders for run ${testRunId}`);

    return jsonWithCors(
      {
        ok: true,
        testRunId,
        count: orders.length,
        orders,
      },
      { status: 200 },
      req.headers.get("origin")
    );
  } catch (err) {
    console.error("[MassTest] POST error:", err);
    return jsonWithCors(
      { error: "Failed to dispatch mass test", message: String(err) },
      { status: 500 },
      req.headers.get("origin")
    );
  }
}
