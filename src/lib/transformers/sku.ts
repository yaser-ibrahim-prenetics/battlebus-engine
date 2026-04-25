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

export interface BundleComponent {
  sku: string;
  quantity: number;
}

export interface SkuMappings {
  refill: Record<string, string>;
  reward: Record<string, string>;
  merge: Record<string, string>;
  bundles: Record<string, BundleComponent[]>;
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
 * Single-hop **merge** mapping for sales order / GPS / D365 line flows.
 * Matches spock-store `mapToSku(TO_DYNAMICS_SKU.merge)` in
 * `createShopifyToDynamicsOrderLineTransformer`: one read from the merge
 * table only — no `refill` (that table is for subscription/Loop paths in spock,
 * not applied on Dynamics order lines there).
 */
export function mapShopifySkuToDynamicsForOrderLine(shopifySku: string): string {
  const merge = getShopifyToDynamicsMapping();
  const key = (shopifySku || "").trim();
  const mapped = merge[key];
  return mapped && mapped !== key ? mapped : key;
}

/**
 * Get the reverse merge mapping (D365 SKU -> Shopify SKU)
 */
export function getDynamicsToShopifyMapping(): Record<string, string> {
  return Object.entries(mappings.merge).reduce<Record<string, string>>((result, [key, value]) => {
    result[value] = key;
    return result;
  }, {});
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
 * Map a Shopify SKU through **refill** then **merge** (loop) until stable.
 * Use for code paths that need the full storefront→physical-style resolution.
 * For **SalesOrderLines** and GPS product lines, use
 * `mapShopifySkuToDynamicsForOrderLine` instead to match spock-store Dynamics
 * behavior (merge table only, one hop).
 */
export function mapShopifySkuToDynamics(shopifySku: string): string {
  const refillMapping = getRefillMapping();
  const mergeMapping = getShopifyToDynamicsMapping();

  // Some SKUs require chained remaps (e.g. A -> B -> C). Resolve until stable.
  let current = shopifySku;
  const seen = new Set<string>([current]);

  while (true) {
    const refillMapped = refillMapping[current];
    if (refillMapped && refillMapped !== current) {
      console.log(`[SKU] Refill mapping: ${current} -> ${refillMapped}`);
      current = refillMapped;
      if (seen.has(current)) return current;
      seen.add(current);
      continue;
    }

    const mergeMapped = mergeMapping[current];
    if (mergeMapped && mergeMapped !== current) {
      console.log(`[SKU] Merge mapping: ${current} -> ${mergeMapped}`);
      current = mergeMapped;
      if (seen.has(current)) return current;
      seen.add(current);
      continue;
    }

    return current;
  }
}

/**
 * Map a D365 SKU back to Shopify SKU
 * Applies reverse merge mapping if exists
 */
export function mapDynamicsSkuToShopify(dynamicsSku: string, originalShopifySku?: string): string {
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
 * Create a line transformer that applies merge-only mapping (spock-store parity).
 * Ported from spock-store createShopifyToDynamicsOrderLineTransformer (mapToSku(merge))
 */
export function createShopifyToDynamicsLineTransformer() {
  return <L extends OrderLine>(line: L): L => {
    const mapped = mapShopifySkuToDynamicsForOrderLine(line.itemNumber);
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
export function mapToSku<L extends OrderLine>(skuMapping: Record<string, string>) {
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
      console.log(`[SKU] Found duplicate SKU ${line.itemNumber}, merging quantities`);
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

/**
 * Check if a SKU is a dummy/test SKU
 * Dummy SKUs match the pattern: IM8-FG-G* (third part starts with G)
 */
export function isDummySku(sku: string): boolean {
  const upperSku = (sku || "").toUpperCase();
  // Check if SKU matches pattern IM8-FG-G* (third part starts with G)
  return /^IM8-FG-G/.test(upperSku);
}

/**
 * Filter out dummy SKUs from order lines
 */
export function filterDummySkus<L extends OrderLine>(lines: L[]): L[] {
  return lines.filter((line) => !isDummySku(line.itemNumber));
}

// ============================================================================
// Bundle / Kit Explosion
// ============================================================================

let runtimeBundles: Record<string, BundleComponent[]> | null = null;

/**
 * Load bundle config from env override (JSON) or fall back to mapping file.
 * Env format: BUNDLE_SKU_OVERRIDES = '{"BUNDLE-SKU":[{"sku":"A","quantity":1},{"sku":"B","quantity":2}]}'
 */
function loadBundleConfig(): Record<string, BundleComponent[]> {
  if (runtimeBundles) return runtimeBundles;

  const base: Record<string, BundleComponent[]> = { ...(mappings.bundles || {}) };

  const envOverride = typeof process !== "undefined" ? process.env.BUNDLE_SKU_OVERRIDES : undefined;
  if (envOverride) {
    try {
      const parsed = JSON.parse(envOverride) as Record<string, BundleComponent[]>;
      Object.assign(base, parsed);
    } catch {
      console.warn("[SKU] Failed to parse BUNDLE_SKU_OVERRIDES env — ignoring");
    }
  }

  runtimeBundles = base;
  return base;
}

/** Reset the cached bundle config (for tests). */
export function resetBundleCache(): void {
  runtimeBundles = null;
}

/**
 * Check whether a SKU is a bundle / kit that needs to be exploded
 * into its component SKUs before sending to the warehouse.
 */
export function isBundleSku(sku: string): boolean {
  const bundles = loadBundleConfig();
  return sku in bundles;
}

/**
 * Get the component SKUs for a bundle. Returns undefined if SKU is not a bundle.
 */
export function getBundleComponents(sku: string): BundleComponent[] | undefined {
  const bundles = loadBundleConfig();
  return bundles[sku];
}

/**
 * Explode bundle / kit line items into their component SKUs.
 *
 * For each line that is a known bundle:
 *   - Remove the bundle line
 *   - Insert one line per component, quantity = lineQty * componentQty
 *
 * Non-bundle lines pass through unchanged.
 */
export function explodeBundleLines<L extends OrderLine>(lines: L[]): L[] {
  const exploded: L[] = [];

  for (const line of lines) {
    const components = getBundleComponents(line.itemNumber);
    if (!components || components.length === 0) {
      exploded.push(line);
      continue;
    }

    console.log(
      `[SKU] Exploding bundle ${line.itemNumber} (qty ${line.quantity}) into ${components.length} components`
    );

    for (const comp of components) {
      exploded.push({
        ...line,
        itemNumber: comp.sku,
        quantity: line.quantity * comp.quantity,
      } as L);
    }
  }

  return exploded;
}
