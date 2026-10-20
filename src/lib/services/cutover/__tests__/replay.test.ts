import { describe, expect, it, vi } from "vitest";
import { replayPair } from "../replay";
import type { ReplayAdapter, ReplayCase } from "@/lib/domain/cutover/contracts";
const input: ReplayCase = {
  caseId: "case-1", workflowId: "shopify:orders/paid", mode: "contract",
  provenance: "synthetic", sourceReference: "fixture:case-1",
  capturedAt: "2026-10-20T00:00:00Z", payload: { order: 1 }, context: { inventory: 5 },
};
const empty = () => ({ financial: [], orders: [], fulfillment: [], inventory: [] });
function adapters() {
  const base = { revision: "a".repeat(40), isolation: "capture-only" as const,
    workflows: [input.workflowId], execute: vi.fn(async () => empty()) };
  return { spock: { ...base, system: "spock" as const },
    battleBus: { ...base, system: "battle-bus" as const } };
}
describe("paired replay", () => {
  it("passes identical immutable isolated inputs and persists the result", async () => {
    const pair = adapters();
    let first: unknown;
    pair.spock.execute = vi.fn(async (value?: unknown) => {
      first = value;
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen((value as ReplayCase).payload)).toBe(true);
      return empty();
    });
    pair.battleBus.execute = vi.fn(async (value?: unknown) => {
      expect(value).toEqual(first);
      expect(value).not.toBe(first);
      return empty();
    });
    const persist = vi.fn();
    expect((await replayPair(input, pair, persist)).status).toBe("matched");
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it("persists unsupported workflows and provider errors as errors without leaking text", async () => {
    const pair = adapters();
    pair.spock.workflows = [];
    const persist = vi.fn();
    expect((await replayPair(input, pair, persist)).status).toBe("error");
    expect(pair.spock.execute).not.toHaveBeenCalled();
    pair.spock.workflows = [input.workflowId];
    pair.spock.execute.mockRejectedValue(new Error("private customer details"));
    const result = await replayPair(input, pair, persist);
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("private customer");
  });
  it("bounds stalled reads and refuses unsafe adapters", async () => {
    const pair = adapters();
    pair.spock.execute = vi.fn(() => new Promise(() => {}));
    expect((await replayPair(input, pair, vi.fn(), 5)).status).toBe("error");
    await expect(replayPair(input, {
      ...pair, spock: { ...pair.spock, isolation: "live" } as unknown as ReplayAdapter,
    }, vi.fn())).rejects.toThrow("capture-only");
  });
  it("does not report success if durable persistence fails", async () => {
    await expect(replayPair(input, adapters(), async () => { throw new Error("db down"); }))
      .rejects.toThrow("db down");
  });
});
