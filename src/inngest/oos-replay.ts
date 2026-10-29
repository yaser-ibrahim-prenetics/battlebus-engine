import { NonRetriableError } from "inngest";
import type { OosRecoveryReplayMarker } from "./events";
import {
  isCurrentOosRecoveryAttempt,
  type OosRecoveryAttemptScope,
  type OosRetryContext,
} from "@/lib/services/oos-recovery/outcomes";

export function validateOosRecoveryReplayAttempt(
  isReplay: boolean,
  marker: OosRecoveryReplayMarker,
  context: OosRetryContext | null
): string | null {
  if (!isReplay) return null;
  const attemptToken = marker.oosRecoveryAttemptToken?.trim() || null;
  if (!context || !attemptToken || context.attemptToken !== attemptToken) {
    throw new NonRetriableError("Targeted OOS replay is stale or missing its attempt token");
  }
  return attemptToken;
}

export function requireOosRecoveryAttemptToken(attemptToken: string | null): string {
  if (!attemptToken) {
    throw new NonRetriableError("Targeted OOS replay is missing its attempt token");
  }
  return attemptToken;
}

export function requireAppliedOosRecoveryOutcome(outcome: { dependencies: number }): void {
  if (outcome.dependencies < 1) {
    throw new NonRetriableError("Targeted OOS replay outcome rejected a stale attempt token");
  }
}

export async function requireCurrentOosRecoveryAttempt(params: {
  shopifyStore: string;
  orderId: string;
  attemptToken: string;
  expectedContext: OosRecoveryAttemptScope;
}): Promise<void> {
  if (!(await isCurrentOosRecoveryAttempt(params))) {
    throw new NonRetriableError("Targeted OOS replay no longer owns the current recovery attempt");
  }
}

export function isRejectedOosRecoveryAttempt(error: unknown): boolean {
  return (
    error instanceof NonRetriableError &&
    String(error.message || "").startsWith("Targeted OOS replay")
  );
}
