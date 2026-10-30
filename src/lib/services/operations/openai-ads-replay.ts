import { z } from "zod";

import { getDatabasePool } from "@/lib/db/database";
import {
  createOpenAiAdsReplayRequestSQL,
  finishOpenAiAdsReplayRequestSQL,
  lockOpenAiAdsConversionSQL,
  readOpenAiAdsReplayRequestSQL,
  replayOpenAiAdsConversionSQL,
} from "@/lib/sql/operations/openai-ads";
import { fingerprint } from "@/lib/services/fulfillment-actions/identity";

export const openAiAdsReplayRequestSchema = z
  .object({
    requestId: z.uuid(),
    reason: z.string().trim().min(10).max(1000),
    actorId: z.string().trim().min(1).max(100),
    actorEmail: z.email().max(254),
    parameters: z
      .object({
        operation: z.literal("replay_openai_ads"),
        eventId: z.string().regex(/^bb_order_created_[a-f0-9]{40}$/),
      })
      .strict(),
  })
  .strict();

type ReplayRequestRow = {
  id: string;
  request_hash: string;
  event_id: string;
  status: "pending" | "succeeded" | "rejected";
  error_code: string | null;
};

type ConversionRow = {
  event_id: string;
  status: string;
  replay_count: number;
};

export type OpenAiAdsReplayResult = {
  requestId: string;
  eventId: string;
  status: "succeeded" | "rejected";
  errorCode: string | null;
  replayed: boolean;
};

export async function reserveOpenAiAdsReplayRequest(
  input: unknown
): Promise<OpenAiAdsReplayResult> {
  const request = openAiAdsReplayRequestSchema.parse(input);
  const requestHash = fingerprint(request);
  const pool = await getDatabasePool();
  if (!pool) throw new Error("PostgreSQL is required for OpenAI Ads replay");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(createOpenAiAdsReplayRequestSQL, [
      request.requestId,
      requestHash,
      request.parameters.eventId,
      request.actorId,
      request.actorEmail,
      request.reason,
    ]);
    const receipt = (
      await client.query<ReplayRequestRow>(readOpenAiAdsReplayRequestSQL, [request.requestId])
    ).rows[0];
    if (!receipt || receipt.request_hash !== requestHash) {
      throw new Error("OpenAI Ads replay request ID conflicts with an existing command");
    }
    if (receipt.status !== "pending") {
      await client.query("COMMIT");
      return {
        requestId: receipt.id,
        eventId: receipt.event_id,
        status: receipt.status,
        errorCode: receipt.error_code,
        replayed: receipt.status === "succeeded",
      };
    }

    const conversion = (
      await client.query<ConversionRow>(lockOpenAiAdsConversionSQL, [request.parameters.eventId])
    ).rows[0];
    let status: "succeeded" | "rejected" = "rejected";
    let errorCode: string | null = null;
    if (!conversion) {
      errorCode = "conversion_missing";
    } else if (!["permanent_failure", "skipped"].includes(conversion.status)) {
      errorCode = "conversion_not_replayable";
    } else if (Number(conversion.replay_count) >= 100) {
      errorCode = "replay_limit_reached";
    } else {
      const replayed = await client.query(replayOpenAiAdsConversionSQL, [conversion.event_id]);
      if (replayed.rowCount !== 1) throw new Error("OpenAI Ads replay lost its row lock");
      status = "succeeded";
    }

    const finished = await client.query(finishOpenAiAdsReplayRequestSQL, [
      request.requestId,
      status,
      errorCode,
    ]);
    if (finished.rowCount !== 1) throw new Error("OpenAI Ads replay audit could not be saved");
    await client.query("COMMIT");
    return {
      requestId: request.requestId,
      eventId: request.parameters.eventId,
      status,
      errorCode,
      replayed: status === "succeeded",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
