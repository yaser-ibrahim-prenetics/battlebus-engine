// ============================================================================
// RESULT UTILITIES
// ============================================================================
// Type-safe result pattern for error handling

export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E; message?: string };

export function success<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function failure<E>(error: E, message?: string): Result<never, E> {
  return { success: false, error, message };
}

export function isSuccess<T, E>(result: Result<T, E>): result is { success: true; data: T } {
  return result.success === true;
}

export function isFailure<T, E>(result: Result<T, E>): result is { success: false; error: E } {
  return result.success === false;
}

