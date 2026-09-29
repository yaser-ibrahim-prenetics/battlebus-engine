import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapPath = path.join(root, "scripts", "bootstrap-hub-database.sh");
const migrationPath = path.join(
  root,
  "db",
  "migrations",
  "000008_bind_battle_hub_iam_database_user.up.sql"
);
const databaseUser = "battle-hub-runtime@battle-bus-509406.iam";

const migration = await readFile(migrationPath, "utf8");
assert.match(migration, new RegExp(databaseUser.replaceAll(".", "\\.")));

for (const [name, value] of [
  ["GCP_PROJECT_ID", "unexpected-project"],
  ["HUB_RUNTIME_SERVICE_ACCOUNT", "unexpected@example.iam.gserviceaccount.com"],
  ["HUB_DB_USER", "unexpected@example.iam"],
]) {
  const result = spawnSync("bash", [bootstrapPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, [name]: value },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${name} is pinned`));
}

console.log("Battle Hub database identity validation tests passed.");
