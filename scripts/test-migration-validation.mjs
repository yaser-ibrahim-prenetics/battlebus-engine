import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "scripts", "validate-migrations.mjs");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "battle-bus-migration-validator-"));
const migrationDirectory = path.join(temporaryRoot, "migrations");
const contractDirectory = path.join(temporaryRoot, "contracts");

await mkdir(migrationDirectory);
await mkdir(contractDirectory);

function validate() {
  return spawnSync(process.execPath, [validator], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MIGRATION_DIRECTORY: migrationDirectory,
      CONTRACT_EVIDENCE_DIRECTORY: contractDirectory,
    },
  });
}

try {
  await writeFile(
    path.join(migrationDirectory, "000001_create_widget.up.sql"),
    "BEGIN;\nCREATE TABLE public.widget (id uuid PRIMARY KEY);\nCOMMIT;\n"
  );
  await writeFile(
    path.join(migrationDirectory, "000001_create_widget.down.sql"),
    "BEGIN;\nDROP TABLE public.widget;\nCOMMIT;\n"
  );

  let result = validate();
  assert.equal(result.status, 0, result.stderr);

  await writeFile(
    path.join(migrationDirectory, "000002_replace_widget_trigger.up.sql"),
    "BEGIN;\nDROP TRIGGER IF EXISTS widget_updated ON public.widget;\nCREATE TRIGGER widget_updated BEFORE UPDATE ON public.widget EXECUTE FUNCTION public.touch_widget();\nCOMMIT;\n"
  );
  await writeFile(
    path.join(migrationDirectory, "000002_replace_widget_trigger.down.sql"),
    "BEGIN;\nDROP TRIGGER IF EXISTS widget_updated ON public.widget;\nCOMMIT;\n"
  );

  result = validate();
  assert.equal(result.status, 0, result.stderr);

  await writeFile(
    path.join(migrationDirectory, "000003_remove_widget.up.sql"),
    "BEGIN;\nDROP TABLE public.widget;\nCOMMIT;\n"
  );
  await writeFile(
    path.join(migrationDirectory, "000003_remove_widget.down.sql"),
    "BEGIN;\nCREATE TABLE public.widget (id uuid PRIMARY KEY);\nCOMMIT;\n"
  );

  result = validate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /migrate:contract/);
  assert.match(result.stderr, /contract evidence/);

  await writeFile(
    path.join(migrationDirectory, "000003_remove_widget.up.sql"),
    "BEGIN;\n-- migrate:contract\nDROP TABLE public.widget;\nCOMMIT;\n"
  );
  await writeFile(
    path.join(contractDirectory, "000003_remove_widget.md"),
    "# Remove widget\n\n- [x] Application references removed\n"
  );

  result = validate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete evidence/);

  await writeFile(
    path.join(contractDirectory, "000003_remove_widget.md"),
    `# Remove widget

Observation window: 2026-09-01 through 2026-09-28
Rollback window ended: 2026-09-28
Approved by: schema-owner@example.com
Approved on: 2026-09-28

- [x] Application references removed
- [x] Cross-repository and integration search completed
- [x] Database dependencies checked
- [x] Query telemetry observation window completed
- [x] Active and rollback revisions verified
- [x] Backup or point-in-time recovery verified
- [x] Schema owner approval recorded
`
  );

  result = validate();
  assert.equal(result.status, 0, result.stderr);
  console.log("Migration contract validation tests passed.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
