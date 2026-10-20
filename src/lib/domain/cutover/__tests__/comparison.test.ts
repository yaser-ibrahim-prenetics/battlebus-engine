import { describe, expect, it } from "vitest";
import { compareOutputs } from "../compare";
import { evaluateCutover, REQUIRED_MODES, type EvidenceSummary } from "../gate";
import { evaluateSlo } from "../slo";

const empty = () => ({ financial: [], orders: [], fulfillment: [], inventory: [] });
describe("cutover comparison", () => {
  it("requires all output domains", () => {
    expect(() => compareOutputs({}, empty())).toThrow();
  });
  it("compares money and payment references exactly", () => {
    const left = {
      ...empty(),
      financial: [
        {
          key: "payment",
          currency: "GBP",
          amount: "9.99",
          kind: "charge",
          paymentReference: "shopify:123",
        },
      ],
    };
    const right = structuredClone(left);
    right.financial[0].paymentReference = "different";
    expect(compareOutputs(left, right).differences).toEqual(["financial"]);
    right.financial[0] = { ...left.financial[0], amount: "10.00" };
    expect(compareOutputs(left, right).matched).toBe(false);
  });
  it("normalizes order, never drops duplicate identities", () => {
    const rows = ["a", "b"].map((key) => ({ key, sku: key, location: "UK", available: 4 }));
    expect(
      compareOutputs(
        { ...empty(), inventory: rows },
        { ...empty(), inventory: [...rows].reverse() }
      ).matched
    ).toBe(true);
    expect(() => compareOutputs({ ...empty(), inventory: [rows[0], rows[0]] }, empty())).toThrow();
  });
});

const now = Date.parse("2026-10-20T00:00:00Z");
const evidence = (): EvidenceSummary[] =>
  REQUIRED_MODES.map((mode) => ({
    workflow_id: "shopify:orders/paid",
    mode,
    samples: 100,
    failures: 0,
    production_samples: 100,
    shadow_days: 7,
    latest_at: new Date(now).toISOString(),
  }));
describe("cutover gate", () => {
  const ids = ["shopify:orders/paid"];
  it("fails closed for missing workflows or empty scope", () => {
    expect(evaluateCutover(ids, [], now).ready).toBe(false);
    expect(evaluateCutover([], [], now).ready).toBe(false);
    expect(evaluateCutover([...ids, "missing"], evidence(), now).ready).toBe(false);
  });
  it("requires every evidence mode and real production observations", () => {
    expect(evaluateCutover(ids, evidence(), now).ready).toBe(true);
    for (const mode of REQUIRED_MODES) {
      expect(
        evaluateCutover(
          ids,
          evidence().filter((e) => e.mode !== mode),
          now
        ).ready
      ).toBe(false);
    }
    const rows = evidence();
    rows[1].production_samples = 0;
    expect(evaluateCutover(ids, rows, now).ready).toBe(false);
  });
  it("does not erase earlier failures and rejects stale evidence", () => {
    const rows = evidence();
    rows[0].failures = 1;
    expect(evaluateCutover(ids, rows, now).ready).toBe(false);
    expect(evaluateCutover(ids, evidence(), now + 25 * 3600000).ready).toBe(false);
    rows[0].latest_at = "not-a-date";
    expect(evaluateCutover(ids, rows, now).ready).toBe(false);
  });
  it("requires the shadow observation window", () => {
    const rows = evidence();
    rows[2].shadow_days = 6;
    expect(evaluateCutover(ids, rows, now).ready).toBe(false);
  });
});

it("SLOs fail closed for empty samples, failures and old backlog", () => {
  const row = {
    function_id: "order",
    completed: 100,
    failed: 0,
    latency_seconds: 20,
    backlog: 0,
    backlog_age_seconds: 0,
  };
  expect(evaluateSlo(row).ok).toBe(true);
  expect(evaluateSlo({ ...row, completed: 0 }).ok).toBe(false);
  expect(evaluateSlo({ ...row, failed: 2 }).ok).toBe(false);
  expect(evaluateSlo({ ...row, backlog_age_seconds: 3601 }).ok).toBe(false);
});
