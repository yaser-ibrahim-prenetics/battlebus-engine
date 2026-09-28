import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "db", "migrations");
const migrationPattern = /^(\d{6})_([a-z0-9]+(?:_[a-z0-9]+)*)\.(up|down)\.sql$/;
const destructivePattern =
  /\b(?:DROP\s+(?:TABLE|TYPE|SCHEMA)|TRUNCATE\s+TABLE|ALTER\s+TABLE\b[\s\S]*?\bDROP\s+COLUMN)\b/i;
const allowDestructiveMarker = "migrate:allow-destructive";

const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql"));
const migrations = new Map();
const errors = [];

for (const file of files) {
  const match = migrationPattern.exec(file);
  if (!match) {
    errors.push(
      `${file}: expected 000001_reason_for_change.up.sql or 000001_reason_for_change.down.sql`
    );
    continue;
  }

  const [, version, title, direction] = match;
  const key = `${version}_${title}`;
  const entry = migrations.get(key) || { version: Number(version), title };
  if (entry[direction]) errors.push(`${file}: duplicate ${direction} migration for ${key}`);
  entry[direction] = file;
  migrations.set(key, entry);

  const sql = await readFile(path.join(migrationDirectory, file), "utf8");
  if (!sql.trim()) errors.push(`${file}: migration is empty`);
  if (direction === "up" && destructivePattern.test(sql) && !sql.includes(allowDestructiveMarker)) {
    errors.push(
      `${file}: destructive SQL requires a "-- ${allowDestructiveMarker}: <justification>" marker`
    );
  }
}

const ordered = [...migrations.values()].sort((left, right) => left.version - right.version);
const seenVersions = new Map();

for (const migration of ordered) {
  const existing = seenVersions.get(migration.version);
  if (existing && existing !== migration.title) {
    errors.push(
      `version ${String(migration.version).padStart(6, "0")} is used by both ${existing} and ${migration.title}`
    );
  }
  seenVersions.set(migration.version, migration.title);

  if (!migration.up) errors.push(`${migration.title}: missing .up.sql migration`);
  if (!migration.down) errors.push(`${migration.title}: missing .down.sql migration`);
}

for (let index = 0; index < ordered.length; index += 1) {
  const expected = index + 1;
  if (ordered[index]?.version !== expected) {
    errors.push(
      `migration sequence must be contiguous: expected ${String(expected).padStart(6, "0")}`
    );
    break;
  }
}

if (errors.length > 0) {
  console.error(`Migration validation failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`Validated ${ordered.length} paired migrations in ${migrationDirectory}`);
