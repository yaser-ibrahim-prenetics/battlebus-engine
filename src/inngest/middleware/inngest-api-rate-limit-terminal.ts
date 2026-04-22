import { Middleware, NonRetriableError, type Inngest } from "inngest";

const MAX_ATTEMPTS = 5;
/** 0-based index of the last attempt that may still be retried by Inngest (0..3); at 4 we stop. */
const TERMINAL_FUNCTION_ATTEMPT_INDEX = MAX_ATTEMPTS - 1; // 0-based: 4 = 5th attempt, then no more retries

/**
 * Inngest Cloud / dev server can return e.g. "API endpoint rate limited. Retry after 166.326728ms".
 * Re-throw as NonRetriableError after MAX attempts so the run does not loop indefinitely.
 */
function isInngestApiRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("api endpoint rate limited")) return true;
  if (msg.includes("rate limited") && msg.includes("retry after")) return true;
  return false;
}

/**
 * @public — registered on the Inngest client; no need to import elsewhere.
 */
export class InngestApiRateLimitTerminalMiddleware extends Middleware.BaseMiddleware {
  readonly id = "battle-bus:inngest-api-rate-limit-terminal";

  constructor({ client }: { client: Inngest.Any }) {
    super({ client });
  }

  async wrapFunctionHandler(
    args: Middleware.WrapFunctionHandlerArgs
  ): Promise<unknown> {
    const { ctx, next } = args;
    try {
      return await next();
    } catch (err) {
      if (isInngestApiRateLimitError(err) && ctx.attempt >= TERMINAL_FUNCTION_ATTEMPT_INDEX) {
        const original = err instanceof Error ? err.message : String(err);
        throw new NonRetriableError(
          `Inngest API rate limit — terminal after ${MAX_ATTEMPTS} attempts: ${original}`,
          { cause: err }
        );
      }
      throw err;
    }
  }
}
