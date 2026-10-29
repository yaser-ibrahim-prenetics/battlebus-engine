#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const inventoryPath = "config/gcp-secret-env-names.txt";
const bindingsPath = "config/gcp-secret-bindings.txt";
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
  ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY", "LOOP_WEBHOOK_KEY"].includes(name);

const discovered = new Set();
for (const file of sourceFiles) {
  const contents = readFileSync(file, "utf8");
  const candidates = [
    ...contents.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g),
    // Google's Kafka JWT algorithm label is a protocol constant, not a secret name.
    // Keep process.env references above checked even if they use this name.
    ...[...contents.matchAll(/["'`]([A-Z][A-Z0-9_]{2,})["'`]/g)].filter(
      (match) => match[1] !== "GOOG_OAUTH2_TOKEN"
    ),
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

const bindingNames = new Set();
for (const rawLine of readFileSync(bindingsPath, "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^([A-Z][A-Z0-9_]*)=([a-z0-9-]+):([1-9][0-9]*)$/);
  if (!match) {
    console.error(`Invalid pinned GCP secret binding: ${line}`);
    process.exit(1);
  }
  const envName = match[1];
  if (!inventory.has(envName) || bindingNames.has(envName)) {
    console.error(`Pinned GCP secret binding is missing from inventory or duplicated: ${envName}`);
    process.exit(1);
  }
  bindingNames.add(envName);
}

console.log(`Validated ${discovered.size} credential environment names in ${inventoryPath}`);
console.log(`Validated ${bindingNames.size} pinned GCP secret bindings in ${bindingsPath}`);
