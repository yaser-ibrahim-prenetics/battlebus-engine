import assert from "node:assert/strict";
import test from "node:test";

import {
  servingRevisionForActivation,
  verifyWebhookInboxActivation,
} from "./webhook-inbox-activation.mjs";

const compatibleRevision = {
  metadata: { name: "battle-bus-serving" },
  spec: {
    containers: [{ env: [{ name: "WEBHOOK_INBOX_DURABLE_DELIVERY_ENABLED", value: "false" }] }],
  },
};

test("uses the 100%-serving revision instead of a failed latest candidate", () => {
  const service = {
    metadata: { labels: { "inngest-synced-revision": "battle-bus-serving" } },
    spec: { template: { metadata: { name: "battle-bus-failed-candidate" } } },
    status: {
      latestReadyRevisionName: "battle-bus-failed-candidate",
      traffic: [
        { revisionName: "battle-bus-serving", percent: 100 },
        { revisionName: "battle-bus-failed-candidate", tag: "candidate" },
      ],
    },
  };

  assert.equal(servingRevisionForActivation(service), "battle-bus-serving");
  assert.equal(verifyWebhookInboxActivation(service, compatibleRevision), "battle-bus-serving");
});

test("rejects mixed traffic, missing compatibility evidence, and stale sync markers", () => {
  assert.throws(() =>
    servingRevisionForActivation({
      status: {
        traffic: [
          { revisionName: "battle-bus-a", percent: 50 },
          { revisionName: "battle-bus-b", percent: 50 },
        ],
      },
    })
  );
  const service = {
    metadata: { labels: { "inngest-synced-revision": "battle-bus-old" } },
    status: { traffic: [{ revisionName: "battle-bus-serving", percent: 100 }] },
  };
  assert.throws(() => verifyWebhookInboxActivation(service, compatibleRevision));
  assert.throws(() =>
    verifyWebhookInboxActivation(
      { ...service, metadata: { labels: { "inngest-synced-revision": "battle-bus-serving" } } },
      { metadata: { name: "battle-bus-serving" }, spec: { containers: [{ env: [] }] } }
    )
  );
});
