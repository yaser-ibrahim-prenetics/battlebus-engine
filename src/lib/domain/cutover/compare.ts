import { outputSchema, domains, type BusinessOutput } from "./contracts";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry)).join(",") + "}";
}

function ordered<T extends { key: string }>(rows: T[]): T[] {
  if (new Set(rows.map((row) => row.key)).size !== rows.length) {
    throw new Error("Duplicate business identity in captured output");
  }
  return [...rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export function normalizeOutput(value: unknown): BusinessOutput {
  const result = outputSchema.parse(value);
  return {
    financial: ordered(result.financial),
    orders: ordered(result.orders).map((order) => ({ ...order, lines: ordered(order.lines) })),
    fulfillment: ordered(result.fulfillment),
    inventory: ordered(result.inventory),
  };
}

/** No rounding tolerance, dropped rows, or ignored financial fields. */
export function compareOutputs(left: unknown, right: unknown) {
  const spock = normalizeOutput(left);
  const battleBus = normalizeOutput(right);
  const differences: string[] = [];
  for (const domain of domains) {
    if (canonicalJson(spock[domain]) !== canonicalJson(battleBus[domain])) differences.push(domain);
  }
  return { matched: differences.length === 0, differences, spock, battleBus };
}

