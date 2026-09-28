import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.resolve(
  process.env.MIGRATION_DIRECTORY || path.join(root, "db", "migrations")
);
const contractEvidenceDirectory = path.resolve(
  process.env.CONTRACT_EVIDENCE_DIRECTORY || path.join(root, "db", "contracts")
);
const migrationPattern = /^(\d{6})_([a-z0-9]+(?:_[a-z0-9]+)*)\.(up|down)\.sql$/;
const destructivePatterns = [
  /\bDROP\s+(?:TABLE|TYPE|SCHEMA|SEQUENCE|DOMAIN|EXTENSION)\b/i,
  /\bTRUNCATE(?:\s+TABLE)?\b/i,
  /\bALTER\s+TABLE\b[\s\S]*?\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i,
  /\bDROP\s+OWNED\b/i,
];
const replaceableDropPattern =
  /\bDROP\s+(MATERIALIZED\s+VIEW|VIEW|FUNCTION|PROCEDURE|TRIGGER|POLICY|INDEX)\s+(?:IF\s+EXISTS\s+)?((?:"?[a-z_][a-z0-9_$]*"?\.)?"?[a-z_][a-z0-9_$]*"?)/gi;
const contractMarker = "migrate:contract";
const requiredContractEvidence = [
  "Application references removed",
  "Cross-repository and integration search completed",
  "Database dependencies checked",
  "Query telemetry observation window completed",
  "Active and rollback revisions verified",
  "Backup or point-in-time recovery verified",
  "Schema owner approval recorded",
];
const requiredContractMetadata = [
  ["Observation window", /^Observation window:\s+\S.+$/im],
  ["Rollback window ended", /^Rollback window ended:\s+\d{4}-\d{2}-\d{2}\s*$/im],
  ["Approved by", /^Approved by:\s+\S.+$/im],
  ["Approved on", /^Approved on:\s+\d{4}-\d{2}-\d{2}\s*$/im],
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUnreplacedObjectDrop(sql) {
  replaceableDropPattern.lastIndex = 0;
  for (const match of sql.matchAll(replaceableDropPattern)) {
    const objectType = match[1].replace(/\s+/g, "\\s+");
    const objectName = escapeRegExp(match[2]);
    const replacementPattern = new RegExp(
      `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?${objectType}\\s+${objectName}\\b`,
      "i"
    );
    if (!replacementPattern.test(sql)) return true;
  }
  return false;
}

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
  const executableSql = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .replace(/'(?:''|[^'])*'/g, "''");
  const isDestructive =
    destructivePatterns.some((pattern) => pattern.test(executableSql)) ||
    hasUnreplacedObjectDrop(executableSql);

  if (direction === "up" && isDestructive) {
    if (!sql.includes(contractMarker)) {
      errors.push(`${file}: destructive SQL requires a "-- ${contractMarker}" marker`);
    }

    const evidenceFile = path.join(contractEvidenceDirectory, `${key}.md`);
    let evidence;
    try {
      evidence = await readFile(evidenceFile, "utf8");
    } catch {
      errors.push(
        `${file}: destructive SQL requires contract evidence at ${path.relative(root, evidenceFile)}`
      );
    }

    if (evidence) {
      for (const item of requiredContractEvidence) {
        if (!evidence.includes(`- [x] ${item}`)) {
          errors.push(`${path.basename(evidenceFile)}: incomplete evidence: ${item}`);
        }
      }
      for (const [label, pattern] of requiredContractMetadata) {
        if (!pattern.test(evidence)) {
          errors.push(`${path.basename(evidenceFile)}: missing or invalid ${label}`);
        }
      }
    }
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
