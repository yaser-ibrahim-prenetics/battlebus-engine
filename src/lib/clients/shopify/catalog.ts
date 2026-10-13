import { buildShopifyUrl, getShopifyHeaders } from "./request";

/**
 * Resolve latest SKU values by Shopify variant IDs via Admin GraphQL.
 * Returns a map keyed by numeric variant ID (legacyResourceId).
 */
export async function getVariantSkusByVariantIds(
  variantIds: Array<number | string>
): Promise<Record<string, string>> {
  const normalizedIds = Array.from(
    new Set(
      variantIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.trunc(id))
    )
  );

  if (normalizedIds.length === 0) return {};

  const url = buildShopifyUrl(`/graphql.json`);
  const result: Record<string, string> = {};
  const chunkSize = 100;
  const MAX_CONCURRENT = 3;

  const chunks: number[][] = [];
  for (let i = 0; i < normalizedIds.length; i += chunkSize) {
    chunks.push(normalizedIds.slice(i, i + chunkSize));
  }

  async function fetchChunk(chunk: number[]): Promise<void> {
    const gqlIds = chunk.map((id) => `gid://shopify/ProductVariant/${id}`);
    const response = await fetch(url, {
      method: "POST",
      headers: getShopifyHeaders(),
      body: JSON.stringify({
        query: `
          query VariantSkus($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                legacyResourceId
                sku
              }
            }
          }
        `,
        variables: { ids: gqlIds },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch variant SKUs: ${response.status} - ${error}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      throw new Error(
        `Failed to fetch variant SKUs: ${payload.errors
          .map((e: any) => e?.message || "Unknown GraphQL error")
          .join("; ")}`
      );
    }

    const nodes = Array.isArray(payload?.data?.nodes) ? payload.data.nodes : [];
    for (const node of nodes) {
      if (!node) continue;
      const sku = typeof node.sku === "string" ? node.sku.trim() : "";
      if (!sku) continue;
      const legacyId = node.legacyResourceId != null ? String(node.legacyResourceId) : "";
      if (legacyId) {
        result[legacyId] = sku;
        continue;
      }
      const gid = typeof node.id === "string" ? node.id : "";
      const fallbackId = gid.split("/").pop() || "";
      if (fallbackId) result[fallbackId] = sku;
    }
  }

  // Bounded concurrency: run up to MAX_CONCURRENT chunks at once
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
    await Promise.all(chunks.slice(i, i + MAX_CONCURRENT).map(fetchChunk));
  }

  return result;
}

/**
 * Get inventory levels per location for an inventory item
 * Returns location-wise breakdown of inventory
 */
export async function getInventoryLevelsByLocation(inventoryItemId: number): Promise<
  Array<{
    location_id: string;
    location_name: string;
    available: number;
    reserved: number;
    committed: number;
  }>
> {
  const url = buildShopifyUrl(`/inventory_levels.json?inventory_item_ids=${inventoryItemId}`);

  const response = await fetch(url, {
    method: "GET",
    headers: getShopifyHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get inventory levels: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const inventoryLevels = data.inventory_levels || [];

  // Also fetch location details to get location names
  const locationIds = inventoryLevels.map((level: any) => level.location_id);
  const locationsMap = new Map<string, string>();

  if (locationIds.length > 0) {
    try {
      const locationsUrl = buildShopifyUrl(`/locations.json?ids=${locationIds.join(",")}`);
      const locationsResponse = await fetch(locationsUrl, {
        method: "GET",
        headers: getShopifyHeaders(),
      });

      if (locationsResponse.ok) {
        const locationsData = await locationsResponse.json();
        const locations = locationsData.locations || [];
        for (const location of locations) {
          locationsMap.set(String(location.id), location.name);
        }
      }
    } catch (error) {
      // If location fetch fails, continue without location names
    }
  }

  return inventoryLevels.map((level: any) => ({
    location_id: String(level.location_id),
    location_name: locationsMap.get(String(level.location_id)) || null,
    available: level.available || 0,
    reserved: 0, // Shopify doesn't provide reserved in inventory_levels endpoint
    committed: 0, // Shopify doesn't provide committed in inventory_levels endpoint
  }));
}

/**
 * Get all locations from Shopify
 * Returns all active locations with their details
 */
export async function getAllLocations(): Promise<
  Array<{
    id: string;
    name: string;
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    country?: string;
    zip?: string;
    phone?: string;
    active: boolean;
    fulfillment_service_id?: string;
  }>
> {
  const url = buildShopifyUrl(`/locations.json`);

  const response = await fetch(url, {
    method: "GET",
    headers: getShopifyHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get locations: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const locations = data.locations || [];

  return locations.map((loc: any) => ({
    id: String(loc.id),
    name: loc.name,
    address1: loc.address1 || null,
    address2: loc.address2 || null,
    city: loc.city || null,
    province: loc.province || null,
    country: loc.country || null,
    zip: loc.zip || null,
    phone: loc.phone || null,
    active: loc.active !== false,
    fulfillment_service_id: loc.fulfillment_service_id ? String(loc.fulfillment_service_id) : null,
  }));
}

