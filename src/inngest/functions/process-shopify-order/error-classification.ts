export function isInventoryIssueError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("out of stock") ||
    m.includes("inventory insufficient") ||
    m.includes("cannot be reserved") ||
    (m.includes("item number") && m.includes("does not exist")) ||
    m.includes("库存不足") ||
    m.includes("未维护新品") ||
    m.includes("sku有误") ||
    m.includes("未通过审核")
  );
}

export function isNonRetryableOrderError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return (
    // Inventory / master-data conditions that won't be fixed by immediate retries
    m.includes("out of stock") ||
    m.includes("inventory insufficient") ||
    m.includes("cannot be reserved") ||
    (m.includes("item number") && m.includes("does not exist")) ||
    m.includes("sku有误") ||
    m.includes("未维护新品") ||
    m.includes("未通过审核") ||
    // Warehouse/configuration issues
    m.includes("unknown warehouse") ||
    m.includes("unsupported warehouse") ||
    m.includes("unsupported virtual warehouse") ||
    m.includes("not fully configured in battle hub") ||
    // Malformed line payloads / missing SKU should fail fast (not retried)
    m.includes("item or category must be specified") ||
    m.includes("missing sku/itemnumber") ||
    m.includes("missing d365 itemnumber") ||
    // D365 number sequence exhausted requires manual fix in D365.
    isD365NumberSequenceExceededError(m)
  );
}

export function inferInventoryErrorType(message: string): string {
  const m = String(message || "").toLowerCase();
  if (m.includes("item number") && m.includes("does not exist")) {
    return "d365_item_not_found";
  }
  if (m.includes("cannot be reserved") || m.includes("inventory insufficient")) {
    return "inventory_insufficient";
  }
  if (m.includes("未维护新品")) {
    return "unmaintained_product";
  }
  if (m.includes("sku有误") || m.includes("未通过审核")) {
    return "unmaintained_product";
  }
  return "out_of_stock";
}

export function isServiceSkuItemNumber(itemNumber?: string | null): boolean {
  const sku = String(itemNumber || "").toUpperCase();
  return sku.startsWith("IM8-SER-") || sku.startsWith("PRE-SER-");
}

export function isD365ItemNotFoundError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return m.includes("item number") && m.includes("does not exist");
}

export function isD365NumberSequenceExceededError(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return m.includes("number sequence") && m.includes("has been exceeded");
}
