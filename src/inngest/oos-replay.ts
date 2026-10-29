import { NonRetriableError } from "inngest";
import type { OosRecoveryReplayMarker } from "./events";
import { isInventoryUnavailableError } from "@/lib/services/oos-recovery/inventory-failure";
import {
  claimOosRecoveryMutation,
  isCurrentOosRecoveryAttempt,
  releaseOosRecoveryMutation,
  renewOosRecoveryMutation,
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
  const runWithMutationLease = async <T>(
    operationKey: string,
    execute: () => Promise<T>
  ): Promise<T> => {
    if (!params.active) return execute();
    const lease = await claimOosRecoveryMutation({
      shopifyStore: params.shopifyStore,
      orderId: params.orderId,
      attemptToken: requireAttemptToken(),
      expectedContext: requireContext(),
      operationKey,
      leaseOwner: params.leaseOwner,
      leaseSeconds: params.leaseSeconds,
    });
    if (!lease) {
      throw new RejectedOosRecoveryAttemptError(
        "Targeted OOS replay could not claim the current provider mutation"
      );
    }
    const heartbeatIntervalMs = Math.max(1_000, Math.floor((params.leaseSeconds * 1_000) / 3));
    const heartbeatRetryMs = Math.max(250, Math.min(1_000, heartbeatIntervalMs));
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatInFlight: Promise<void> | null = null;
    let heartbeatStopped = false;
    let leaseLost = false;
    const scheduleHeartbeat = (delayMs: number): void => {
      heartbeatTimer = setTimeout(() => {
        let retryDelay = heartbeatIntervalMs;
        heartbeatInFlight = renewOosRecoveryMutation(lease, params.leaseSeconds)
          .then((renewed) => {
            if (!renewed) leaseLost = true;
          })
          .catch(() => {
            retryDelay = heartbeatRetryMs;
          })
          .finally(() => {
            heartbeatInFlight = null;
            if (!heartbeatStopped && !leaseLost) scheduleHeartbeat(retryDelay);
          });
      }, delayMs);
      if (typeof heartbeatTimer === "object") heartbeatTimer.unref();
    };
    scheduleHeartbeat(heartbeatIntervalMs);
    let result: T | undefined;
    let executionError: unknown;
    try {
      result = await execute();
    } catch (error) {
      executionError = error;
    } finally {
      heartbeatStopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (heartbeatInFlight) await heartbeatInFlight;
    }
    let released = false;
    try {
      released = await releaseOosRecoveryMutation(
        lease,
        executionError
          ? isInventoryUnavailableError(executionError)
            ? "rejected"
            : "uncertain"
          : "accepted"
      );
    } catch {
      // An uncertain release must not allow the workflow to repeat a provider mutation.
    }
    if (leaseLost || !released) {
      throw new RejectedOosRecoveryAttemptError(
        "Targeted OOS replay lost its provider mutation lease"
      );
    }
    if (executionError) {
      if (
        executionError instanceof RejectedOosRecoveryAttemptError ||
        isInventoryUnavailableError(executionError)
      ) {
        throw executionError;
      }
      throw new RejectedOosRecoveryAttemptError(
        "Targeted OOS replay has an uncertain provider mutation outcome"
      );
    }
    return result as T;
  };
  return { requireAttemptToken, requireContext, runWithMutationLease };
}

export function isRejectedOosRecoveryAttempt(error: unknown): boolean {
  return error instanceof RejectedOosRecoveryAttemptError;
}
