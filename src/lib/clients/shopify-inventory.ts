import crypto from "crypto";

import { config } from "@/lib/config";
import { shopifyAdminGraphql } from "./shopify";

export type ShopifyInventoryItem = {
  inventoryItemId: string;
  sku: string;
};

type UserError = { code?: string; field?: string[]; message: string };

function quotedSearchValue(value: string): string {
  return value.replace(/([\\"])/g, "\\$1");
}

function assertNoUserErrors(operation: string, errors: UserError[] | undefined): void {
  if (!errors?.length) return;
  throw new Error(`${operation} failed: ${errors.map((error) => error.message).join("; ")}`);
}

export function shopifyGid(kind: "InventoryItem" | "Location", value: string): string {
  return value.startsWith("gid://shopify/") ? value : `gid://shopify/${kind}/${value}`;
}

function usesModernInventoryContract(apiVersion: string): boolean {
  const match = apiVersion.match(/^(\d{4})-(\d{2})$/);
  if (!match) return true;
  return Number(match[1]) * 100 + Number(match[2]) >= 202604;
}

function idempotencyKey(parts: unknown[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

const inventoryApiVersion = config.inventory.shopifyApiVersion;

export async function findInventoryItemsBySku(sku: string): Promise<ShopifyInventoryItem[]> {
  const query = `
    query InventoryItemsBySku($query: String!) {
      productVariants(first: 100, query: $query) {
        nodes {
          sku
          inventoryItem { id }
        }
      }
    }
  `;
  const payload = await shopifyAdminGraphql<{
    data?: {
      productVariants?: {
        nodes?: Array<{ sku?: string | null; inventoryItem?: { id?: string | null } | null }>;
      };
    };
  }>(query, { query: `sku:\"${quotedSearchValue(sku)}\"` }, { apiVersion: inventoryApiVersion });

  return (payload.data?.productVariants?.nodes || [])
    .filter((node) => node.sku === sku && Boolean(node.inventoryItem?.id))
    .map((node) => ({ sku, inventoryItemId: String(node.inventoryItem?.id) }));
}

export async function activateInventoryAtLocation(
  inventoryItemId: string,
  locationId: string
): Promise<void> {
  if (config.features.dryRunMode) {
    console.log(
      `[ShopifyInventory] DRY RUN - Would activate ${inventoryItemId} at ${locationId}`
    );
    return;
  }

  const modern = usesModernInventoryContract(inventoryApiVersion);
  const mutation = modern
    ? `
      mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId)
          @idempotent(key: $idempotencyKey) {
          userErrors { code field message }
        }
      }
    `
    : `
      mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
          userErrors { code field message }
        }
      }
    `;
  const normalizedInventoryItemId = shopifyGid("InventoryItem", inventoryItemId);
  const normalizedLocationId = shopifyGid("Location", locationId);
  const variables: Record<string, unknown> = {
    inventoryItemId: normalizedInventoryItemId,
    locationId: normalizedLocationId,
  };
  if (modern) {
    variables.idempotencyKey = idempotencyKey([
      "inventoryActivate",
      normalizedInventoryItemId,
      normalizedLocationId,
    ]);
  }
  const payload = await shopifyAdminGraphql<{
    data?: { inventoryActivate?: { userErrors?: UserError[] } };
  }>(mutation, variables, { apiVersion: inventoryApiVersion });
  const errors = payload.data?.inventoryActivate?.userErrors || [];
  const alreadyActive = errors.every((error) => /already (active|stocked)/i.test(error.message));
  if (errors.length > 0 && !alreadyActive) assertNoUserErrors("inventoryActivate", errors);
}

export async function setInventoryQuantities(params: {
  locationId: string;
  quantities: Array<{ inventoryItemId: string; quantity: number }>;
  referenceDocumentUri: string;
}): Promise<void> {
  if (params.quantities.length === 0) return;
  if (config.features.dryRunMode) {
    console.log(
      `[ShopifyInventory] DRY RUN - Would set ${params.quantities.length} inventory item(s) at ${params.locationId}`
    );
    return;
  }

  const modern = usesModernInventoryContract(inventoryApiVersion);
  const mutation = modern
    ? `
      mutation SetInventoryQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          userErrors { code field message }
        }
      }
    `
    : `
      mutation SetInventoryQuantities($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { code field message }
        }
      }
    `;
  const locationId = shopifyGid("Location", params.locationId);
  const quantities = params.quantities.map((quantity) => ({
    inventoryItemId: shopifyGid("InventoryItem", quantity.inventoryItemId),
    locationId,
    quantity: Math.max(0, Math.trunc(quantity.quantity)),
    ...(modern ? { changeFromQuantity: null } : { compareQuantity: null }),
  }));
  const input: Record<string, unknown> = {
    name: "available",
    reason: "correction",
    referenceDocumentUri: params.referenceDocumentUri,
    quantities,
    ...(!modern ? { ignoreCompareQuantity: true } : {}),
  };
  const variables: Record<string, unknown> = { input };
  if (modern) {
    variables.idempotencyKey = idempotencyKey([
      "inventorySetQuantities",
      params.referenceDocumentUri,
      quantities,
    ]);
  }
  const payload = await shopifyAdminGraphql<{
    data?: { inventorySetQuantities?: { userErrors?: UserError[] } };
  }>(mutation, variables, { apiVersion: inventoryApiVersion });
  assertNoUserErrors("inventorySetQuantities", payload.data?.inventorySetQuantities?.userErrors);
}

export async function setSkuInventoryAtLocation(params: {
  sku: string;
  locationId: string;
  quantity: number;
  referenceDocumentUri: string;
}): Promise<{ updated: number; inventoryItemIds: string[] }> {
  const items = await findInventoryItemsBySku(params.sku);
  if (items.length === 0) throw new Error(`SKU ${params.sku} was not found in Shopify`);

  await Promise.all(
    items.map((item) => activateInventoryAtLocation(item.inventoryItemId, params.locationId))
  );
  await setInventoryQuantities({
    locationId: params.locationId,
    referenceDocumentUri: params.referenceDocumentUri,
    quantities: items.map((item) => ({
      inventoryItemId: item.inventoryItemId,
      quantity: params.quantity,
    })),
  });
  return { updated: items.length, inventoryItemIds: items.map((item) => item.inventoryItemId) };
}
