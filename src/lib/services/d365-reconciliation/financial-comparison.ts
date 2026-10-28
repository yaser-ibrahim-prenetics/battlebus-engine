export interface FinancialLine {
  company: string;
  item: string;
  currency: string;
  quantity: number;
  amountCents: number;
}
export interface FinancialDifference {
  company: string;
  item: string;
  currency: string;
  expectedQuantity: number;
  actualQuantity: number;
  expectedCents: number;
  actualCents: number;
  issue: "quantity" | "amount" | "quantity_and_amount";
}
/** Company is part of the key: equal global totals cannot hide wrong-entity routing. */
export function compareFinancialLines(
  expected: FinancialLine[],
  actual: FinancialLine[]
): FinancialDifference[] {
  const aggregate = (lines: FinancialLine[]) => {
    const result = new Map<string, FinancialLine>();
    for (const line of lines) {
      if (
        !line.company ||
        !line.item ||
        !line.currency ||
        !Number.isFinite(line.quantity) ||
        !Number.isSafeInteger(line.amountCents)
      )
        throw new Error("Incomplete financial evidence");
      const key = JSON.stringify([
        line.company.toUpperCase(),
        line.item,
        line.currency.toUpperCase(),
      ]);
      const previous = result.get(key);
      result.set(key, {
        ...line,
        quantity: (previous?.quantity ?? 0) + line.quantity,
        amountCents: (previous?.amountCents ?? 0) + line.amountCents,
      });
    }
    return result;
  };
  const left = aggregate(expected),
    right = aggregate(actual);
  const differences: FinancialDifference[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key),
      b = right.get(key),
      source = a ?? b!;
    const quantity = Math.abs((a?.quantity ?? 0) - (b?.quantity ?? 0)) > 0.000001;
    const amount = (a?.amountCents ?? 0) !== (b?.amountCents ?? 0);
    if (quantity || amount)
      differences.push({
        company: source.company,
        item: source.item,
        currency: source.currency,
        expectedQuantity: a?.quantity ?? 0,
        actualQuantity: b?.quantity ?? 0,
        expectedCents: a?.amountCents ?? 0,
        actualCents: b?.amountCents ?? 0,
        issue: quantity && amount ? "quantity_and_amount" : quantity ? "quantity" : "amount",
      });
  }
  return differences;
}
