import { NonRetriableError } from "inngest";
import type { OosRecoveryReplayMarker } from "./events";
import {
  claimOosRecoveryMutation,
  isCurrentOosRecoveryAttempt,
  releaseOosRecoveryMutation,
  type OosRecoveryAttemptScope,
  type OosRetryContext,
} from "@/lib/services/oos-recovery/outcomes";

export class RejectedOosRecoveryAttemptError extends NonRetriableError {}

export function validateOosRecoveryReplayAttempt(
  isReplay: boolean,
  marker: OosRecoveryReplayMarker,
  context: OosRetryContext | null
): string | null {
  if (!isReplay) return null;
  const attemptToken = marker.oosRecoveryAttemptToken?.trim() || null;
  if (!context || !attemptToken || context.attemptToken !== attemptToken) {
    throw new RejectedOosRecoveryAttemptError(
      "Targeted OOS replay is stale or missing its attempt token"
    );
  }
  return attemptToken;
}

export function requireOosRecoveryAttemptToken(attemptToken: string | null): string {
  if (!attemptToken) {
    throw new RejectedOosRecoveryAttemptError("Targeted OOS replay is missing its attempt token");
  }
  return attemptToken;
}

export function requireAppliedOosRecoveryOutcome(outcome: { dependencies: number }): void {
  if (outcome.dependencies < 1) {
    throw new RejectedOosRecoveryAttemptError(
      "Targeted OOS replay outcome rejected a stale attempt token"
    );
  }
}

export async function requireCurrentOosRecoveryAttempt(params: {
  shopifyStore: string;
  orderId: string;
  attemptToken: string;
  expectedContext: OosRecoveryAttemptScope;
}): Promise<void> {
  if (!(await isCurrentOosRecoveryAttempt(params))) {
    throw new RejectedOosRecoveryAttemptError(
      "Targeted OOS replay no longer owns the current recovery attempt"
    );
  }
}

export function createOosRecoveryAttemptGuard(params: {
  active: boolean;
  shopifyStore: string;
  orderId: string;
  leaseOwner: string;
  leaseSeconds: number;
  getAttemptToken: () => string | null;
  getContext: () => OosRetryContext | null;
}) {
  const requireAttemptToken = (): string =>
    requireOosRecoveryAttemptToken(params.getAttemptToken());
  const requireContext = (): OosRetryContext => {
    const context = params.getContext();
    if (!context) {
      throw new RejectedOosRecoveryAttemptError(
        "Targeted OOS replay is missing its dependency context"
      );
    }
    return context;
  };
  const runWithMutationLease = async <T>(execute: () => Promise<T>): Promise<T> => {
    if (!params.active) return execute();
    const lease = await claimOosRecoveryMutation({
      shopifyStore: params.shopifyStore,
      orderId: params.orderId,
      attemptToken: requireAttemptToken(),
      expectedContext: requireContext(),
      leaseOwner: params.leaseOwner,
      leaseSeconds: params.leaseSeconds,
    });
    if (!lease) {
      throw new RejectedOosRecoveryAttemptError(
        "Targeted OOS replay could not claim the current provider mutation"
      );
    }
    let result: T | undefined;
    let executionError: unknown;
    try {
      result = await execute();
    } catch (error) {
      executionError = error;
    }
    if (!(await releaseOosRecoveryMutation(lease))) {
      throw new RejectedOosRecoveryAttemptError(
        "Targeted OOS replay lost its provider mutation lease"
      );
    }
    if (executionError) throw executionError;
    return result as T;
  };
  return { requireAttemptToken, requireContext, runWithMutationLease };
}

export function isRejectedOosRecoveryAttempt(error: unknown): boolean {
  return error instanceof RejectedOosRecoveryAttemptError;
}
