import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("records the exact promoted revision only after Inngest sync succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "inngest-sync-test-"));
  try {
    const executable = (name, content) => {
      const path = join(dir, name);
      writeFileSync(path, content, { mode: 0o700 });
      return path;
    };
    executable("curl", '#!/bin/sh\nprintf \'{"modified":true,"message":"ok"}\\n\'\n');
    executable("gcloud", '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TEST_LOG"\n');
    const result = spawnSync("bash", ["scripts/deploy/sync-inngest.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEST_LOG: join(dir, "calls"),
        CLOUD_RUN_URL: "https://battle-bus.example.test",
        GCP_PROJECT_ID: "battle-bus-test",
        GCP_REGION: "asia-east1",
        CLOUD_RUN_SERVICE: "battle-bus",
        CANDIDATE_REVISION: "battle-bus-abc12345-100-1",
      },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = readFileSync(join(dir, "calls"), "utf8");
    assert(calls.includes("run services update battle-bus"));
    assert(calls.includes("--update-labels=inngest-synced-revision=battle-bus-abc12345-100-1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
