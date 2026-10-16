import { shopifyAdminGraphql } from "./request";

export type ShopifyInventoryItem = {
  inventoryItemId: string;
  sku: string;
};

type UserError = { field?: string[]; message: string };

function quotedSearchValue(value: string): string {
  return value.replace(/([\\"])/g, "\\$1");
}

function assertNoUserErrors(operation: string, errors: UserError[] | undefined): void {
  if (!errors?.length) return;
  throw new Error(`${operation} failed: ${errors.map((error) => error.message).join("; ")}`);
}

function gid(kind: "InventoryItem" | "Location", value: string): string {
  return value.startsWith("gid://shopify/") ? value : `gid://shopify/${kind}/${value}`;
}

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
  }>(query, { query: `sku:\"${quotedSearchValue(sku)}\"` });

  return (payload.data?.productVariants?.nodes || [])
    .filter((node) => node.sku === sku && Boolean(node.inventoryItem?.id))
    .map((node) => ({ sku, inventoryItemId: String(node.inventoryItem?.id) }));
}

export async function activateInventoryAtLocation(
  inventoryItemId: string,
  locationId: string
): Promise<void> {
  const mutation = `
    mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
        userErrors { field message }
      }
    }
  `;
  const payload = await shopifyAdminGraphql<{
    data?: { inventoryActivate?: { userErrors?: UserError[] } };
  }>(mutation, {
    inventoryItemId: gid("InventoryItem", inventoryItemId),
    locationId: gid("Location", locationId),
  });
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
  const mutation = `
    mutation SetInventoryQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message }
      }
    }
  `;
  const payload = await shopifyAdminGraphql<{
    data?: { inventorySetQuantities?: { userErrors?: UserError[] } };
  }>(mutation, {
    input: {
      name: "available",
      reason: "correction",
      referenceDocumentUri: params.referenceDocumentUri,
      quantities: params.quantities.map((quantity) => ({
        inventoryItemId: gid("InventoryItem", quantity.inventoryItemId),
        locationId: gid("Location", params.locationId),
        quantity: Math.max(0, Math.trunc(quantity.quantity)),
      })),
    },
  });
  assertNoUserErrors(
    "inventorySetQuantities",
    payload.data?.inventorySetQuantities?.userErrors
  );
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
