import { config } from "../../config";

const SHOPIFY_API_VERSION = config.shopify.im8.apiVersion;

export function getShopifyHeaders(): Record<string, string> {
  return {
    "X-Shopify-Access-Token": config.shopify.im8.accessToken,
    "Content-Type": "application/json",
  };
}

export function buildShopifyUrl(endpoint: string): string {
  return `https://${config.shopify.im8.shopDomain}/admin/api/${SHOPIFY_API_VERSION}${endpoint}`;
}

export async function shopifyAdminGraphql<T = any>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(buildShopifyUrl("/graphql.json"), {
    method: "POST",
    headers: getShopifyHeaders(),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Shopify GraphQL request failed: ${response.status} - ${error}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const message = payload.errors
      .map((error: any) => error?.message || "Unknown GraphQL error")
      .join("; ");
    throw new Error(`Shopify GraphQL request failed: ${message}`);
  }

  return payload as T;
}
