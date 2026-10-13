import crypto from "crypto";
import { config } from "../../config";

function normalizeShopifyShopDomain(domain: string | null | undefined): string {
  return (domain || "").toLowerCase().trim();
}

export interface ShopifyAdminApiCredentials {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
}

/**
 * Admin API token + host for REST/GraphQL calls. When `shopDomain` is set (full myshopify
 * hostname from Hub or webhooks), selects PROD vs TEST credentials the same way as webhook HMAC.
 * When omitted, uses the active store from SHOPIFY_STORE_MODE (`config.shopify.im8`).
 */
export function resolveShopifyAdminCredentials(
  shopDomain: string | null | undefined
): ShopifyAdminApiCredentials {
  const d = normalizeShopifyShopDomain(shopDomain);
  const prodD = normalizeShopifyShopDomain(config.shopify.production.shopDomain);
  const testD = normalizeShopifyShopDomain(config.shopify.test.shopDomain);

  let bucket: "production" | "test" | "active" = "active";
  if (prodD && testD && prodD === testD && d === prodD) {
    bucket = config.shopify.storeMode === "production" ? "production" : "test";
  } else if (prodD && d === prodD) {
    bucket = "production";
  } else if (testD && d === testD) {
    bucket = "test";
  }

  const src =
    bucket === "production"
      ? config.shopify.production
      : bucket === "test"
        ? config.shopify.test
        : config.shopify.im8;

  return {
    shopDomain: src.shopDomain,
    accessToken: src.accessToken,
    apiVersion: src.apiVersion,
  };
}

/** Safe token fingerprint for logs (never log full Admin API tokens). */
export function maskShopifyAccessToken(token: string | null | undefined): string {
  const t = String(token || "");
  if (!t) return "(empty)";
  if (t.length <= 12) return `(${t.length} chars)`;
  return `${t.slice(0, 8)}…${t.slice(-4)} (${t.length} chars)`;
}

/**
 * Which env bucket was used for Admin REST/GraphQL credentials (for debugging 401s).
 */
export function shopifyAdminApiCredentialSource(shopDomain: string | null | undefined): string {
  const d = normalizeShopifyShopDomain(shopDomain);
  const prodD = normalizeShopifyShopDomain(config.shopify.production.shopDomain);
  const testD = normalizeShopifyShopDomain(config.shopify.test.shopDomain);
  if (prodD && testD && prodD === testD && d === prodD) {
    return `duplicate SHOPIFY_*_SHOP_DOMAIN → SHOPIFY_${config.shopify.storeMode === "production" ? "PROD" : "TEST"}_* (Admin token)`;
  }
  if (prodD && d === prodD) return "SHOPIFY_PROD_ACCESS_TOKEN + SHOPIFY_PROD_SHOP_DOMAIN";
  if (testD && d === testD) return "SHOPIFY_TEST_ACCESS_TOKEN + SHOPIFY_TEST_SHOP_DOMAIN";
  return `active store SHOPIFY_STORE_MODE=${config.shopify.storeMode} → config.shopify.im8 (${config.shopify.im8.shopDomain})`;
}

/**
 * Pick the webhook signing secret for the store that sent the webhook.
 * Shopify signs with the secret shown in that shop's admin (per custom app / subscription).
 * This must follow `x-shopify-shop-domain`, not `SHOPIFY_STORE_MODE`, so production
 * webhooks still verify when the deployment defaults to test API credentials for other calls.
 */
export function resolveShopifyWebhookSecret(shopDomain: string | null | undefined): string {
  const d = normalizeShopifyShopDomain(shopDomain);
  const prodD = normalizeShopifyShopDomain(config.shopify.production.shopDomain);
  const testD = normalizeShopifyShopDomain(config.shopify.test.shopDomain);

  // Same hostname in PROD and TEST env (misconfiguration) — use SHOPIFY_STORE_MODE
  if (prodD && testD && prodD === testD && d === prodD) {
    return config.shopify.storeMode === "production"
      ? config.shopify.production.webhookSecret
      : config.shopify.test.webhookSecret;
  }
  if (prodD && d === prodD) {
    return config.shopify.production.webhookSecret;
  }
  if (testD && d === testD) {
    return config.shopify.test.webhookSecret;
  }
  return config.shopify.im8.webhookSecret;
}

/** For logs only — which credential bucket was used for webhook HMAC. */
export function shopifyWebhookSecretSource(shopDomain: string | null | undefined): string {
  const d = normalizeShopifyShopDomain(shopDomain);
  const prodD = normalizeShopifyShopDomain(config.shopify.production.shopDomain);
  const testD = normalizeShopifyShopDomain(config.shopify.test.shopDomain);
  if (prodD && testD && prodD === testD && d === prodD) {
    return `duplicate SHOPIFY_*_SHOP_DOMAIN → SHOPIFY_${config.shopify.storeMode === "production" ? "PROD" : "TEST"}_WEBHOOK_SECRET`;
  }
  if (prodD && d === prodD) return "SHOPIFY_PROD_WEBHOOK_SECRET";
  if (testD && d === testD) return "SHOPIFY_TEST_WEBHOOK_SECRET";
  return "active-store (SHOPIFY_STORE_MODE; set SHOPIFY_TEST_SHOP_DOMAIN to match test store hostname)";
}

/**
 * Verify Shopify Webhook Signature
 * @param shopDomain - `x-shopify-shop-domain`; used to select PROD vs TEST webhook secret
 */
export function verifyWebhookSignature(
  body: string,
  hmacHeader: string,
  shopDomain?: string | null
): boolean {
  const secret = resolveShopifyWebhookSecret(shopDomain);
  if (!secret) return false;
  const hash = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

