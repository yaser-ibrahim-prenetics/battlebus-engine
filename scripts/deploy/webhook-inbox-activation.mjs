import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { trafficAllocation } from "./traffic-allocation.mjs";

export function servingRevisionForActivation(service) {
  const allocation = trafficAllocation(service);
  assert(!allocation.includes(","), "Webhook inbox activation requires one serving revision");
  assert(allocation.endsWith("=100"), "Webhook inbox activation requires 100% serving traffic");
  return allocation.slice(0, -4);
}

export function verifyWebhookInboxActivation(service, revision) {
  const servingRevision = servingRevisionForActivation(service);
  assert.equal(revision.metadata?.name, servingRevision, "Revision evidence is not serving");
  const env = revision.spec?.containers?.[0]?.env ?? [];
  const flag = env.find((entry) => entry.name === "WEBHOOK_INBOX_DURABLE_DELIVERY_ENABLED")?.value;
  assert(
    ["false", "true"].includes(String(flag).toLowerCase()),
    `Serving revision ${servingRevision} is not lease-compatible`
  );
  const syncedRevision = service.metadata?.labels?.["inngest-synced-revision"];
  assert.equal(
    syncedRevision,
    servingRevision,
    `Serving revision ${servingRevision} has no successful Inngest sync marker`
  );
  return servingRevision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const service = JSON.parse(readFileSync(process.argv[3], "utf8"));
  if (mode === "serving") console.log(servingRevisionForActivation(service));
  else if (mode === "verify") {
    const revision = JSON.parse(readFileSync(process.argv[4], "utf8"));
    console.log(verifyWebhookInboxActivation(service, revision));
  } else throw new Error(`Unknown webhook inbox activation mode: ${mode}`);
}
