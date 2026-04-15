/**
 * Verify Shopify Admin API credentials from env (no secrets printed).
 *
 * Usage:
 *   npx tsx scripts/verify-shopify-admin-token.ts [--prod-only | --test-only] [--order <orderId>] [--api-version YYYY-MM]
 *   npx tsx scripts/verify-shopify-admin-token.ts --probe-order-versions --order <orderId> [--prod-only | --test-only]
 *
 * --order: after shop.json, GET /orders/{id}.json (needs read_orders scope).
 * --api-version: override SHOPIFY_*_API_VERSION / SHOPIFY_API_VERSION for this run.
 * --probe-order-versions: only GET /orders/{id}.json for several API versions (scope 403 is usually the same on all).
 *
 * Loads .env then .env.local via dotenv (same precedence as Next.js).
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Same precedence as Next.js: .env then .env.local (local overrides).
loadEnv({ path: resolve(root, ".env") });
loadEnv({ path: resolve(root, ".env.local"), override: true });

function mask(s: string): string {
  if (!s) return "(empty)";
  if (s.length <= 12) return `(${s.length} chars)`;
  return `${s.slice(0, 8)}…${s.slice(-4)} (${s.length} chars)`;
}

async function pingShop(
  label: string,
  shopDomain: string | undefined,
  token: string | undefined,
  apiVersion: string
): Promise<void> {
  const domain = (shopDomain || "").trim();
  const tok = (token || "").trim();
  console.log(`\n--- ${label} ---`);
  console.log(`shopDomain: ${domain || "(missing)"}`);
  console.log(`token: ${mask(tok)}`);
  console.log(`apiVersion: ${apiVersion}`);

  if (!domain || !tok) {
    console.log("SKIP: missing shop domain or token");
    return;
  }

  const url = `https://${domain}/admin/api/${apiVersion}/shop.json`;
  console.log(`GET ${url}`);

  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": tok,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    console.log(`HTTP ${res.status}`);
    console.log(text.slice(0, 500));
    return;
  }

  try {
    const data = JSON.parse(text) as { shop?: { name?: string; myshopify_domain?: string; id?: number } };
    const sh = data.shop;
    console.log(`HTTP ${res.status} OK`);
    console.log(
      `shop: ${sh?.name ?? "?"} | domain: ${sh?.myshopify_domain ?? "?"} | id: ${sh?.id ?? "?"}`
    );
  } catch {
    console.log(`HTTP ${res.status} (non-JSON body)`);
    console.log(text.slice(0, 200));
  }
}

async function pingOrder(
  label: string,
  orderId: string,
  shopDomain: string | undefined,
  token: string | undefined,
  apiVersion: string
): Promise<void> {
  const domain = (shopDomain || "").trim();
  const tok = (token || "").trim();
  console.log(`\n--- ${label} (order ${orderId}) ---`);
  if (!domain || !tok) {
    console.log("SKIP: missing shop domain or token");
    return;
  }
  const url = `https://${domain}/admin/api/${apiVersion}/orders/${orderId}.json`;
  console.log(`GET ${url}`);
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": tok,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`HTTP ${res.status}`);
    console.log(text.slice(0, 600));
    return;
  }
  try {
    const data = JSON.parse(text) as { order?: { name?: string; id?: number } };
    const o = data.order;
    console.log(`HTTP ${res.status} OK`);
    console.log(`order: ${o?.name ?? "?"} | id: ${o?.id ?? "?"}`);
  } catch {
    console.log(`HTTP ${res.status} (non-JSON body)`);
    console.log(text.slice(0, 200));
  }
}

function parseOrderId(argv: string[]): string | undefined {
  const idx = argv.indexOf("--order");
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith("-")) {
    return argv[idx + 1].trim();
  }
  for (const a of argv) {
    if (/^\d+$/.test(a)) return a;
  }
  return undefined;
}

function parseFlagArg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const val = argv[i + 1];
  if (!val || val.startsWith("-")) return undefined;
  return val.trim();
}

/** Versions to try when diagnosing order 403 (legacy REST uses same path; there is no pre-scope "legacy" orders API). */
const DEFAULT_ORDER_API_VERSIONS = ["2024-04", "2024-07", "2024-10", "2025-01", "2025-04", "unstable"];

async function probeOrderAcrossVersions(
  orderId: string,
  useTestBucket: boolean,
  versions: string[]
): Promise<void> {
  const domain = useTestBucket
    ? process.env.SHOPIFY_TEST_SHOP_DOMAIN
    : process.env.SHOPIFY_PROD_SHOP_DOMAIN;
  const token = useTestBucket
    ? process.env.SHOPIFY_TEST_ACCESS_TOKEN
    : process.env.SHOPIFY_PROD_ACCESS_TOKEN;
  const label = useTestBucket ? "TEST (SHOPIFY_TEST_*)" : "PRODUCTION (SHOPIFY_PROD_*)";
  console.log(`\n=== Probe GET /orders/{id}.json — ${label} ===`);
  console.log(
    "If every version returns 403 read_orders, enable read_orders on the custom app and reinstall — API version will not fix it.\n"
  );
  for (const v of versions) {
    await pingOrder(`PROBE ${v}`, orderId, domain, token, v);
  }
}

const args = process.argv.slice(2);
const prodOnly = args.includes("--prod-only");
const testOnly = args.includes("--test-only");
const orderId = parseOrderId(args);
const apiVersionCli = parseFlagArg(args, "--api-version");

const ver =
  process.env.SHOPIFY_API_VERSION || process.env.SHOPIFY_PROD_API_VERSION || "2024-07";

async function main() {
  if (args.includes("--probe-order-versions")) {
    if (!orderId) {
      console.error("Add --order <shopifyOrderId>");
      process.exit(1);
    }
    console.log("SHOPIFY_STORE_MODE=", process.env.SHOPIFY_STORE_MODE ?? "(unset)");
    if (testOnly) {
      await probeOrderAcrossVersions(orderId, true, DEFAULT_ORDER_API_VERSIONS);
    } else if (prodOnly) {
      await probeOrderAcrossVersions(orderId, false, DEFAULT_ORDER_API_VERSIONS);
    } else {
      await probeOrderAcrossVersions(orderId, false, DEFAULT_ORDER_API_VERSIONS);
      await probeOrderAcrossVersions(orderId, true, DEFAULT_ORDER_API_VERSIONS);
    }
    return;
  }

  console.log("SHOPIFY_STORE_MODE=", process.env.SHOPIFY_STORE_MODE ?? "(unset)");
  console.log("NODE_ENV=", process.env.NODE_ENV ?? "(unset)");
  if (orderId) {
    console.log("orderId (read_orders check)=", orderId);
  }
  if (apiVersionCli) {
    console.log("apiVersion (CLI override)=", apiVersionCli);
  }

  if (!testOnly) {
    const prodVer = apiVersionCli || process.env.SHOPIFY_PROD_API_VERSION || ver;
    await pingShop(
      "PRODUCTION (SHOPIFY_PROD_*)",
      process.env.SHOPIFY_PROD_SHOP_DOMAIN,
      process.env.SHOPIFY_PROD_ACCESS_TOKEN,
      prodVer
    );
    if (orderId) {
      await pingOrder(
        "PRODUCTION (SHOPIFY_PROD_*)",
        orderId,
        process.env.SHOPIFY_PROD_SHOP_DOMAIN,
        process.env.SHOPIFY_PROD_ACCESS_TOKEN,
        prodVer
      );
    }
  }

  if (!prodOnly) {
    const testVer = apiVersionCli || process.env.SHOPIFY_TEST_API_VERSION || ver;
    await pingShop(
      "TEST (SHOPIFY_TEST_*)",
      process.env.SHOPIFY_TEST_SHOP_DOMAIN,
      process.env.SHOPIFY_TEST_ACCESS_TOKEN,
      testVer
    );
    if (orderId) {
      await pingOrder(
        "TEST (SHOPIFY_TEST_*)",
        orderId,
        process.env.SHOPIFY_TEST_SHOP_DOMAIN,
        process.env.SHOPIFY_TEST_ACCESS_TOKEN,
        testVer
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
