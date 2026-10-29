import { describe, expect, it } from "vitest";
import {
  requireAppliedOosRecoveryOutcome,
  validateOosRecoveryReplayAttempt,
} from "../../oos-replay";
import type { OosRetryContext } from "@/lib/services/oos-recovery/outcomes";

const context: OosRetryContext = {
  provider: "d365",
  warehouse: "U001",
  blockedItems: [{ orderLineId: "line-1", providerSku: "SKU-1" }],
  manualReview: false,
  attemptToken: "attempt-current",
};

describe("targeted OOS replay correlation", () => {
  it("requires the event-carried token to match the current database attempt", () => {
    expect(
      validateOosRecoveryReplayAttempt(
        true,
        { oosRecoveryReplay: true, oosRecoveryAttemptToken: "attempt-current" },
        context
      )
    ).toBe("attempt-current");
    expect(() =>
      validateOosRecoveryReplayAttempt(true, { oosRecoveryReplay: true }, context)
    ).toThrow("stale or missing");
    expect(() =>
      validateOosRecoveryReplayAttempt(
        true,
        { oosRecoveryReplay: true, oosRecoveryAttemptToken: "attempt-stale" },
        context
      )
    ).toThrow("stale or missing");
  });

  it("rejects zero-row outcomes before a resolved event can be emitted", () => {
    expect(() => requireAppliedOosRecoveryOutcome({ dependencies: 0 })).toThrow(
      "stale attempt token"
    );
    expect(() => requireAppliedOosRecoveryOutcome({ dependencies: 1 })).not.toThrow();
  });
});
