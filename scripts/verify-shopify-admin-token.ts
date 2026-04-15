/**
 * Verify Shopify Admin API credentials from env (no secrets printed).
 * Usage: npx tsx scripts/verify-shopify-admin-token.ts [--prod-only | --test-only]
 *
 * Loads .env.local then .env via dotenv (same as local dev).
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

const args = process.argv.slice(2);
const prodOnly = args.includes("--prod-only");
const testOnly = args.includes("--test-only");

const ver =
  process.env.SHOPIFY_API_VERSION || process.env.SHOPIFY_PROD_API_VERSION || "2024-07";

async function main() {
  console.log("SHOPIFY_STORE_MODE=", process.env.SHOPIFY_STORE_MODE ?? "(unset)");
  console.log("NODE_ENV=", process.env.NODE_ENV ?? "(unset)");

  if (!testOnly) {
    await pingShop(
      "PRODUCTION (SHOPIFY_PROD_*)",
      process.env.SHOPIFY_PROD_SHOP_DOMAIN,
      process.env.SHOPIFY_PROD_ACCESS_TOKEN,
      process.env.SHOPIFY_PROD_API_VERSION || ver
    );
  }

  if (!prodOnly) {
    await pingShop(
      "TEST (SHOPIFY_TEST_*)",
      process.env.SHOPIFY_TEST_SHOP_DOMAIN,
      process.env.SHOPIFY_TEST_ACCESS_TOKEN,
      process.env.SHOPIFY_TEST_API_VERSION || ver
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
