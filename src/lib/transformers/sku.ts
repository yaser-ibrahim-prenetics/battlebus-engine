// ============================================================================
// SKU TRANSFORMERS
// ============================================================================
// Ported from spock-store src/component/inventory.ts

import skuMappings from "../mappings/dynamics-sku.json";

// ============================================================================
// SKU Mapping Types
// ============================================================================

export interface OrderLine {
  itemNumber: string;
  quantity: number;
}

export interface SkuMappings {
  refill: Record<string, string>;
  reward: Record<string, string>;
  merge: Record<string, string>;
}

// ============================================================================
// SKU Mapping Functions
// ============================================================================

const mappings = skuMappings as SkuMappings;

/**
 * Get the merge mapping (Shopify SKU -> D365 SKU)
 * Used for SKUs that need to be transformed before sending to D365
 */
export function getShopifyToDynamicsMapping(): Record<string, string> {
  return mappings.merge;
}

/**
 * Get the reverse merge mapping (D365 SKU -> Shopify SKU)
 */
export function getDynamicsToShopifyMapping(): Record<string, string> {
  return Object.entries(mappings.merge).reduce<Record<string, string>>(
    (result, [key, value]) => {
      result[value] = key;
      return result;
    },
    {}
  );
}

/**
 * Get refill SKU mapping
 * Maps original SKU to refill variant
 */
export function getRefillMapping(): Record<string, string> {
  return mappings.refill;
}

/**
 * Get reward SKU mapping
 * Maps reward tier to SKU
 */
export function getRewardMapping(): Record<string, string> {
  return mappings.reward;
}

/**
 * Map a Shopify SKU to D365 SKU
 * Applies refill mapping first, then merge mapping if exists, otherwise returns original
 */
export function mapShopifySkuToDynamics(shopifySku: string): string {
  // Check refill mapping first (e.g., IM8-FG-000010 -> IM8-FG-000035)
  const refillMapping = getRefillMapping();
  if (refillMapping[shopifySku]) {
    console.log(`[SKU] Refill mapping: ${shopifySku} -> ${refillMapping[shopifySku]}`);
    return refillMapping[shopifySku];
  }
  
  // Then check merge mapping
  const mergeMapping = getShopifyToDynamicsMapping();
  if (mergeMapping[shopifySku]) {
    console.log(`[SKU] Merge mapping: ${shopifySku} -> ${mergeMapping[shopifySku]}`);
    return mergeMapping[shopifySku];
  }
  
  return shopifySku;
}

/**
 * Map a D365 SKU back to Shopify SKU
 * Applies reverse merge mapping if exists
 */
export function mapDynamicsSkuToShopify(
  dynamicsSku: string,
  originalShopifySku?: string
): string {
  const mergeMapping = getShopifyToDynamicsMapping();
  
  // If we have the original Shopify SKU and it maps to this D365 SKU, use it
  if (originalShopifySku && mergeMapping[originalShopifySku] === dynamicsSku) {
    return originalShopifySku;
  }
  
  // Otherwise try reverse lookup
  const reverseMapping = getDynamicsToShopifyMapping();
  return reverseMapping[dynamicsSku] || dynamicsSku;
}

/**
 * Create a line transformer that applies SKU mapping
 * Ported from spock-store createShopifyToDynamicsOrderLineTransformer
 */
export function createShopifyToDynamicsLineTransformer() {
  return <L extends OrderLine>(line: L): L => {
    const mapped = mapShopifySkuToDynamics(line.itemNumber);
    if (mapped !== line.itemNumber) {
      console.log(`[SKU] Mapped ${line.itemNumber} -> ${mapped}`);
      return {
        ...line,
        itemNumber: mapped,
      };
    }
    return line;
  };
}

/**
 * Map a single order line SKU
 */
export function mapToSku<L extends OrderLine>(
  skuMapping: Record<string, string>
) {
  return (line: L): L => {
    const mapped = skuMapping[line.itemNumber];
    if (mapped) {
      console.log(`[SKU] Mapped ${line.itemNumber} -> ${mapped}`);
      return {
        ...line,
        itemNumber: mapped,
      };
    }
    return line;
  };
}

// ============================================================================
// GPS Order Item Helpers
// ============================================================================

export interface GpsOrderItem {
  sku: string;
  quantity: number;
}

/**
 * Merge duplicate SKU lines for GPS orders
 * GPS doesn't like duplicate SKUs, so we combine quantities
 * Ported from spock-store mergeGPSDuplicateSKUOrderLines
 */
export function mergeGpsDuplicateSkuLines(
  lines: Array<{ itemNumber: string; quantity: number }>
): GpsOrderItem[] {
  const merged: Record<string, GpsOrderItem> = {};

  for (const line of lines) {
    if (merged[line.itemNumber]) {
      console.log(
        `[SKU] Found duplicate SKU ${line.itemNumber}, merging quantities`
      );
      merged[line.itemNumber].quantity += line.quantity || 0;
    } else {
      merged[line.itemNumber] = {
        sku: line.itemNumber,
        quantity: line.quantity || 0,
      };
    }
  }

  const result = Object.values(merged);
  console.log(`[SKU] Merged lines: ${JSON.stringify(result)}`);
  return result;
}

// ============================================================================
// Service SKU Detection
// ============================================================================

const SERVICE_SKU_PREFIXES = ["IM8-SER-", "PRE-SER-"];

/**
 * Check if a SKU is a service SKU (shipping, tax, refund)
 * Service SKUs should not be sent to warehouse
 */
export function isServiceSku(sku: string): boolean {
  return SERVICE_SKU_PREFIXES.some((prefix) => sku.startsWith(prefix));
}

/**
 * Filter out service SKUs from order lines
 */
export function filterServiceSkus<L extends OrderLine>(lines: L[]): L[] {
  return lines.filter((line) => !isServiceSku(line.itemNumber));
}

// ============================================================================
// Dummy SKU Detection
// ============================================================================

const DUMMY_SKU_PATTERNS = ["DUMMY", "TEST", "SAMPLE"];

/**
 * Check if a SKU is a dummy/test SKU
 */
export function isDummySku(sku: string): boolean {
  const upperSku = sku.toUpperCase();
  return DUMMY_SKU_PATTERNS.some((pattern) => upperSku.includes(pattern));
}

/**
 * Filter out dummy SKUs from order lines
 */
export function filterDummySkus<L extends OrderLine>(lines: L[]): L[] {
  return lines.filter((line) => !isDummySku(line.itemNumber));
}

export function isWelcomeKitSku(lineItems: Array<{ sku?: string | null }>): boolean {
  if (!lineItems || lineItems.length === 0) return false;
  const weekKitPattern = /^IM8-WK-.+/i; // Case-insensitive
  
  return lineItems.some(item => {
    if (!item.sku) return false;
    return weekKitPattern.test(item.sku);
  });
}
