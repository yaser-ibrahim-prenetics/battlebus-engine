import { describe, expect, it } from "vitest";
import {
  isLoopRefundWebhookGloballyDisabled,
  resolveLoopReturnsEnabled,
  resolveLoopWebhookVerifyDisabled,
} from "../loop-integration";

/** Minimal env fixture (cast for unit tests). */
function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe("loop-integration env", () => {
  it("enable only when ENABLE_LOOP_RETURNS is true-like (unless globally disabled)", () => {
    expect(resolveLoopReturnsEnabled(env({ ENABLE_LOOP_RETURNS: "true", LOOP_WEBHOOK_KEY: "k" }))).toBe(
      true
    );

    expect(resolveLoopReturnsEnabled(env({ ENABLE_LOOP_RETURNS: "1" }))).toBe(true);

    expect(resolveLoopReturnsEnabled(env({ LOOP_WEBHOOK_KEY: "k" }))).toBe(false);

    expect(resolveLoopReturnsEnabled(env({ ENABLE_LOOP_RETURNS: "false", LOOP_WEBHOOK_KEY: "k" }))).toBe(
      false
    );

    expect(
      resolveLoopReturnsEnabled(
        env({ ENABLE_LOOP_RETURN_REFUND_WEBHOOK: "false", ENABLE_LOOP_RETURNS: "true" })
      )
    ).toBe(false);

    expect(isLoopRefundWebhookGloballyDisabled(env({ ENABLE_LOOP_RETURN_REFUND_WEBHOOK: "false" }))).toBe(
      true
    );
  });

  it("parses DISABLE_LOOP_WEBHOOK_VERIFICATION", () => {
    expect(resolveLoopWebhookVerifyDisabled(env({ DISABLE_LOOP_WEBHOOK_VERIFICATION: "true" }))).toBe(
      true
    );

    expect(resolveLoopWebhookVerifyDisabled(env({}))).toBe(false);
  });
});
