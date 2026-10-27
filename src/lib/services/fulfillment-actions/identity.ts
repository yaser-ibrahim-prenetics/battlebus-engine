import { createHash } from "node:crypto";

export interface ActionIdentity {
  provider: "gps" | "dynamics";
  scope: string;
  sourceOrderId: string;
  sourceLineIds: string[];
  action: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function actionKeys(identity: ActionIdentity): string[] {
  const parts = [identity.provider, identity.scope, identity.sourceOrderId, identity.action];
  if (parts.some(p => !p?.trim()) || !identity.sourceLineIds.length ||
      identity.sourceLineIds.some(p => !p?.trim()) ||
      new Set(identity.sourceLineIds).size !== identity.sourceLineIds.length) {
    throw new Error("Fulfillment action requires a scope, order, action and unique line identities");
  }
  return identity.sourceLineIds.map(line => fingerprint([...parts, line]));
}
