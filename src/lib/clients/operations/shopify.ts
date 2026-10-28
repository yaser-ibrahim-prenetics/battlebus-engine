import { config } from "@/lib/config";
import { shopifyAdminGraphql, resolveShopifyAdminCredentials } from "@/lib/clients/shopify";
import { shopIdentityQuery } from "@/lib/queries/operations/shopify";
export async function probeShopifyEnvironment() {
  if (config.features.enabledShopifyOrderMock)
    throw new Error("Provider verification cannot use Shopify mocks");
  const expected = resolveShopifyAdminCredentials(
    config.shopify.im8.shopDomain
  ).shopDomain.toLowerCase();
  const response = await shopifyAdminGraphql<{
    data?: { shop?: { id?: string; myshopifyDomain?: string } };
  }>(
    shopIdentityQuery,
    {},
    { shopDomain: expected, apiVersion: config.reconciliation.shopifyApiVersion }
  );
  const shop = response.data?.shop;
  const pin = config.reconciliation.expectedShopId;
  const expectedId = pin && /^\d+$/.test(pin) ? `gid://shopify/Shop/${pin}` : pin;
  if (
    !shop?.id ||
    !/^gid:\/\/shopify\/Shop\/\d+$/.test(shop.id) ||
    !shop.myshopifyDomain ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop.myshopifyDomain)
  )
    throw new Error("Shopify environment identity is incomplete");
  // A renamed hostname can differ from Shopify's canonical hostname. A configured
  // immutable shop ID is authoritative; never let a hostname match override it.
  if (expectedId ? shop.id !== expectedId : shop.myshopifyDomain.toLowerCase() !== expected)
    throw new Error("Shopify environment identity mismatch");
  return {
    shopDomain: expected,
    canonicalShopDomain: shop.myshopifyDomain.toLowerCase(),
    shopId: shop.id,
    identity: "verified" as const,
    matchedBy: expectedId ? "shop_id" : "hostname",
  };
}
