#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const inventoryPath = "config/gcp-secret-env-names.txt";
const inventory = new Set(
  readFileSync(inventoryPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
);

const sourceFiles = execFileSync("git", ["ls-files", "src", "scripts"], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));

const isCredentialName = (name) =>
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|API_KEY)(?:_|$)/.test(name) ||
  (/^SLACK_.+_CHANNEL$/.test(name) && !name.startsWith("SLACK_TEST_")) ||
  [
    "INNGEST_EVENT_KEY",
    "INNGEST_SIGNING_KEY",
    "LOOP_WEBHOOK_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ].includes(name);

const discovered = new Set();
for (const file of sourceFiles) {
  const contents = readFileSync(file, "utf8");
  const candidates = [
    ...contents.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g),
    ...contents.matchAll(/["'`]([A-Z][A-Z0-9_]{2,})["'`]/g),
  ];
  for (const match of candidates) {
    if (isCredentialName(match[1])) discovered.add(match[1]);
  }
}

const missing = [...discovered].filter((name) => !inventory.has(name)).sort();
if (missing.length > 0) {
  console.error("Credential-like environment names missing from the GCP secret inventory:");
  for (const name of missing) console.error(`  ${name}`);
  process.exit(1);
}

console.log(`Validated ${discovered.size} credential environment names in ${inventoryPath}`);
