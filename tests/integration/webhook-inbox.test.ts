import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createClaimWebhookInboxEntriesSQL } from "@/lib/sql/webhook-inbox/claim";
import {
  createFailWebhookInboxEntrySQL,
  createPublishWebhookInboxEntrySQL,
  createRequeueWebhookInboxDeadLetterSQL,
} from "@/lib/sql/webhook-inbox/finish";
import { createDeleteRetainedWebhookInboxEntriesSQL } from "@/lib/sql/webhook-inbox/retention";

const connectionString = process.env.WEBHOOK_INBOX_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("webhook inbox PostgreSQL contract", () => {
  let pool: Pool;
  const sourcePrefix = "webhook-inbox-contract-";
  const claimSQL = createClaimWebhookInboxEntriesSQL("webhook_inbox");
  const publishSQL = createPublishWebhookInboxEntrySQL("webhook_inbox");
  const failSQL = createFailWebhookInboxEntrySQL("webhook_inbox");
  const requeueSQL = createRequeueWebhookInboxDeadLetterSQL("webhook_inbox");
  const retentionSQL = createDeleteRetainedWebhookInboxEntriesSQL("webhook_inbox");

  beforeAll(() => {
    pool = new Pool({ connectionString });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM public.webhook_inbox WHERE source LIKE $1", [`${sourcePrefix}%`]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function insertReceipt(options?: {
    status?: "received" | "published" | "failed";
    attempts?: number;
    leaseToken?: string | null;
    leaseExpiresAt?: Date | null;
    deadLetteredAt?: Date | null;
    publishedAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO public.webhook_inbox (
         id, source, topic, payload, events, status, attempts,
         lease_token, lease_expires_at, dead_lettered_at, published_at
       ) VALUES ($1, $2, 'orders/paid', '{}'::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        `${sourcePrefix}${id}`,
        JSON.stringify([{ id: `event-${id}`, name: "shopify/order.paid", data: { orderId: id } }]),
        options?.status ?? "received",
        options?.attempts ?? 0,
        options?.leaseToken ?? null,
        options?.leaseExpiresAt ?? null,
        options?.deadLetteredAt ?? null,
        options?.publishedAt ?? null,
      ]
    );
    return id;
  }

  async function claim(limit = 10, leaseSeconds = 120, maxAttempts = 3, id?: string) {
    return pool.query<{
      id: string;
      attempts: number;
      lease_token: string;
    }>(claimSQL, [limit, leaseSeconds, maxAttempts, id ?? null]);
  }

  it("gives concurrent workers disjoint leased receipts", async () => {
    const firstId = await insertReceipt();
    const secondId = await insertReceipt();

    const [first, second] = await Promise.all([claim(1), claim(1)]);
    const ids = [...first.rows, ...second.rows].map((row) => row.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([firstId, secondId]));
    expect(first.rows[0].lease_token).not.toBe(second.rows[0].lease_token);
  });

  it("acknowledges only the exact active lease token", async () => {
    const id = await insertReceipt();
    const entry = (await claim(1, 120, 3, id)).rows[0];

    const stale = await pool.query(publishSQL, [id, randomUUID(), [entry.id]]);
    expect(stale.rowCount).toBe(0);

    const saved = await pool.query(publishSQL, [id, entry.lease_token, [entry.id]]);
    expect(saved.rowCount).toBe(1);
    const state = await pool.query<{
      status: string;
      lease_token: string | null;
      event_ids: string[];
    }>("SELECT status,lease_token,event_ids FROM public.webhook_inbox WHERE id=$1", [id]);
    expect(state.rows[0]).toEqual({
      status: "published",
      lease_token: null,
      event_ids: [entry.id],
    });
  });

  it("backs off failures, dead-letters the attempt limit, and permits audited replay", async () => {
    const id = await insertReceipt();
    const first = (await claim(1, 120, 2, id)).rows[0];
    const retryable = await pool.query<{ dead_lettered_at: Date | null }>(failSQL, [
      id,
      first.lease_token,
      "delivery_error:http_503",
      2,
      600,
      false,
    ]);
    expect(retryable.rows[0].dead_lettered_at).toBeNull();
    expect((await claim(1, 120, 2, id)).rows).toHaveLength(0);

    await pool.query(
      "UPDATE public.webhook_inbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
      [id]
    );
    const second = (await claim(1, 120, 2, id)).rows[0];
    const terminal = await pool.query<{ dead_lettered_at: Date | null }>(failSQL, [
      id,
      second.lease_token,
      "delivery_error:http_503",
      2,
      600,
      false,
    ]);
    expect(terminal.rows[0].dead_lettered_at).toBeInstanceOf(Date);
    expect((await claim(1, 120, 2, id)).rows).toHaveLength(0);

    const replayed = await pool.query<{ replay_count: number }>(requeueSQL, [id]);
    expect(replayed.rows[0].replay_count).toBe(1);
    const replayClaim = (await claim(1, 120, 2, id)).rows[0];
    expect(replayClaim.attempts).toBe(1);
  });

  it("recovers expired leases and dead-letters exhausted crashed attempts", async () => {
    const recoverableId = await insertReceipt({
      attempts: 1,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const exhaustedId = await insertReceipt({
      attempts: 3,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });

    const recovered = await claim(10, 120, 3);
    expect(recovered.rows.map((row) => row.id)).toContain(recoverableId);
    expect(recovered.rows.find((row) => row.id === recoverableId)?.attempts).toBe(2);
    expect(recovered.rows.map((row) => row.id)).not.toContain(exhaustedId);

    const exhausted = await pool.query<{
      status: string;
      dead_lettered_at: Date | null;
      lease_token: string | null;
    }>("SELECT status,dead_lettered_at,lease_token FROM public.webhook_inbox WHERE id=$1", [
      exhaustedId,
    ]);
    expect(exhausted.rows[0].status).toBe("failed");
    expect(exhausted.rows[0].dead_lettered_at).toBeInstanceOf(Date);
    expect(exhausted.rows[0].lease_token).toBeNull();
  });

  it("deletes only bounded, expired published receipts", async () => {
    const publishedIds = await Promise.all(
      Array.from({ length: 3 }, () =>
        insertReceipt({
          status: "published",
          publishedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        })
      )
    );
    const activeId = await insertReceipt();
    const deadLetterId = await insertReceipt({
      status: "failed",
      attempts: 3,
      deadLetteredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    const deleted = await pool.query<{ id: string }>(retentionSQL, [30, 2]);
    expect(deleted.rows).toHaveLength(2);
    expect(publishedIds).toEqual(expect.arrayContaining(deleted.rows.map((row) => row.id)));

    const retained = await pool.query<{ id: string }>(
      "SELECT id FROM public.webhook_inbox WHERE id = ANY($1::uuid[])",
      [[activeId, deadLetterId]]
    );
    expect(new Set(retained.rows.map((row) => row.id))).toEqual(new Set([activeId, deadLetterId]));
  });
});
