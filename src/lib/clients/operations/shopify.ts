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
  if (!response.data?.shop?.id || response.data.shop.myshopifyDomain?.toLowerCase() !== expected)
    throw new Error("Shopify environment identity mismatch");
  return { shopDomain: expected, identity: "verified" as const };
}
