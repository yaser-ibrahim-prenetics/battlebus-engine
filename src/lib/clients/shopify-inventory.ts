import crypto from "crypto";

import { config } from "@/lib/config";
import { shopifyAdminGraphql } from "./shopify";

export type ShopifyInventoryItem = {
  inventoryItemId: string;
  sku: string;
  activeAtLocation?: boolean;
  availableQuantity?: number;
};

type UserError = { code?: string; field?: string[]; message: string };

function quotedSearchValue(value: string): string {
  return value.replace(/([\\"])/g, "\\$1");
}

class ShopifyInventoryUserError extends Error {
  constructor(
    operation: string,
    readonly userErrors: UserError[]
  ) {
    super(`${operation} failed: ${userErrors.map((error) => error.message).join("; ")}`);
  }
}

function assertNoUserErrors(operation: string, errors: UserError[] | undefined): void {
  if (!errors?.length) return;
  throw new ShopifyInventoryUserError(operation, errors);
}

function isStaleQuantityError(error: unknown): boolean {
  return (
    error instanceof ShopifyInventoryUserError &&
    error.userErrors.some((item) => item.code === "CHANGE_FROM_QUANTITY_STALE")
  );
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

async function findInventoryItemsBySkuAtLocation(
  sku: string,
  locationId: string
): Promise<ShopifyInventoryItem[]> {
  const query = `
    query InventoryItemsBySkuAtLocation($query: String!, $locationId: ID!) {
      productVariants(first: 100, query: $query) {
        nodes {
          sku
          inventoryItem {
            id
            inventoryLevel(locationId: $locationId) {
              isActive
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }
  `;
  const payload = await shopifyAdminGraphql<{
    data?: {
      productVariants?: {
        nodes?: Array<{
          sku?: string | null;
          inventoryItem?: {
            id?: string | null;
            inventoryLevel?: {
              isActive?: boolean;
              quantities?: Array<{ name: string; quantity?: number | null }>;
            } | null;
          } | null;
        }>;
      };
    };
  }>(
    query,
    {
      query: `sku:\"${quotedSearchValue(sku)}\"`,
      locationId: shopifyGid("Location", locationId),
    },
    { apiVersion: inventoryApiVersion }
  );

  return (payload.data?.productVariants?.nodes || [])
    .filter((node) => node.sku === sku && Boolean(node.inventoryItem?.id))
    .map((node) => {
      const level = node.inventoryItem?.inventoryLevel;
      const available = level?.quantities?.find((quantity) => quantity.name === "available");
      return {
        sku,
        inventoryItemId: String(node.inventoryItem?.id),
        activeAtLocation: level?.isActive === true,
        availableQuantity: Number(available?.quantity ?? 0),
      };
    });
}

async function getInventoryItemAtLocation(
  inventoryItemId: string,
  locationId: string
): Promise<ShopifyInventoryItem> {
  const query = `
    query InventoryItemAtLocation($id: ID!, $locationId: ID!) {
      inventoryItem(id: $id) {
        id
        sku
        inventoryLevel(locationId: $locationId) {
          isActive
          quantities(names: ["available"]) { name quantity }
        }
      }
    }
  `;
  const payload = await shopifyAdminGraphql<{
    data?: {
      inventoryItem?: {
        id: string;
        sku?: string | null;
        inventoryLevel?: {
          isActive?: boolean;
          quantities?: Array<{ name: string; quantity?: number | null }>;
        } | null;
      } | null;
    };
  }>(
    query,
    {
      id: shopifyGid("InventoryItem", inventoryItemId),
      locationId: shopifyGid("Location", locationId),
    },
    { apiVersion: inventoryApiVersion }
  );
  const item = payload.data?.inventoryItem;
  if (!item) throw new Error(`Inventory item ${inventoryItemId} was not found in Shopify`);
  const available = item.inventoryLevel?.quantities?.find(
    (quantity) => quantity.name === "available"
  );
  return {
    sku: String(item.sku || ""),
    inventoryItemId: item.id,
    activeAtLocation: item.inventoryLevel?.isActive === true,
    availableQuantity: Number(available?.quantity ?? 0),
  };
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
  quantities: Array<{
    inventoryItemId: string;
    quantity: number;
    changeFromQuantity: number;
  }>;
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
    ...(modern
      ? { changeFromQuantity: Math.trunc(quantity.changeFromQuantity) }
      : { compareQuantity: Math.trunc(quantity.changeFromQuantity) }),
  }));
  const input: Record<string, unknown> = {
    name: "available",
    reason: "correction",
    referenceDocumentUri: params.referenceDocumentUri,
    quantities,
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
  for (let attempt = 1; attempt <= 3; attempt++) {
    const items = await findInventoryItemsBySkuAtLocation(params.sku, params.locationId);
    if (items.length === 0) throw new Error(`SKU ${params.sku} was not found in Shopify`);
    await Promise.all(
      items
        .filter((item) => !item.activeAtLocation)
        .map((item) => activateInventoryAtLocation(item.inventoryItemId, params.locationId))
    );
    try {
      await setInventoryQuantities({
        locationId: params.locationId,
        referenceDocumentUri: params.referenceDocumentUri,
        quantities: items.map((item) => ({
          inventoryItemId: item.inventoryItemId,
          quantity: params.quantity,
          changeFromQuantity: item.availableQuantity ?? 0,
        })),
      });
      return { updated: items.length, inventoryItemIds: items.map((item) => item.inventoryItemId) };
    } catch (error) {
      if (!isStaleQuantityError(error) || attempt === 3) throw error;
    }
  }
  throw new Error(`Could not reconcile Shopify inventory for SKU ${params.sku}`);
}

export async function setInventoryItemAtLocation(params: {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  referenceDocumentUri: string;
}): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const item = await getInventoryItemAtLocation(params.inventoryItemId, params.locationId);
    if (!item.activeAtLocation) {
      await activateInventoryAtLocation(item.inventoryItemId, params.locationId);
    }
    try {
      await setInventoryQuantities({
        locationId: params.locationId,
        referenceDocumentUri: params.referenceDocumentUri,
        quantities: [
          {
            inventoryItemId: item.inventoryItemId,
            quantity: params.quantity,
            changeFromQuantity: item.availableQuantity ?? 0,
          },
        ],
      });
      return;
    } catch (error) {
      if (!isStaleQuantityError(error) || attempt === 3) throw error;
    }
  }
}
