import { describe, expect, it } from "vitest";
import { oosOutboxRetryDelaySeconds } from "../outbox";

describe("OOS outbox retry policy", () => {
  it("uses bounded exponential backoff", () => {
    expect(oosOutboxRetryDelaySeconds(1)).toBe(30);
    expect(oosOutboxRetryDelaySeconds(2)).toBe(60);
    expect(oosOutboxRetryDelaySeconds(20)).toBe(21_600);
  });
});
