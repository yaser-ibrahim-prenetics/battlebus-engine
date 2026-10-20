import { z } from "zod";

const key = z.string().min(1).max(250);
const quantity = z.number().finite();
const money = z.string().regex(/^-?\d+(\.\d{1,6})?$/);
export const domains = ["financial", "orders", "fulfillment", "inventory"] as const;

// Provider IDs must be mapped to stable business identities at the adapter boundary.
// Strict schemas prevent accidentally comparing empty or incomplete output objects.
export const outputSchema = z
  .object({
    financial: z.array(
      z
        .object({
          key,
          currency: z.string().regex(/^[A-Z]{3}$/),
          amount: money,
          kind: z.enum(["charge", "refund", "gift_card", "prepayment", "tax", "shipping"]),
          paymentReference: z.string().nullable(),
        })
        .strict()
    ),
    orders: z.array(
      z
        .object({
          key,
          status: key,
          warehouse: z.string().nullable(),
          associatedOrder: z.string().nullable(),
          lines: z.array(z.object({ key, sku: key, quantity, amount: money }).strict()),
        })
        .strict()
    ),
    fulfillment: z.array(
      z
        .object({
          key,
          orderKey: key,
          sku: key,
          quantity,
          status: key,
          warehouse: key,
          trackingReference: z.string().nullable(),
        })
        .strict()
    ),
    inventory: z.array(z.object({ key, sku: key, location: key, available: quantity }).strict()),
  })
  .strict();
export type BusinessOutput = z.infer<typeof outputSchema>;

export const replayCaseSchema = z
  .object({
    caseId: key,
    workflowId: key,
    mode: z.enum(["contract", "historical", "shadow", "recovery"]),
    provenance: z.enum(["synthetic", "production"]),
    sourceReference: key,
    capturedAt: z.iso.datetime(),
    payload: z.json(),
    context: z.json(),
  })
  .strict();
export type ReplayCase = z.infer<typeof replayCaseSchema>;

export interface ReplayAdapter {
  system: "spock" | "battle-bus";
  revision: string;
  isolation: "capture-only";
  workflows: readonly string[];
  execute(input: Readonly<ReplayCase>, signal: AbortSignal): Promise<BusinessOutput>;
}
