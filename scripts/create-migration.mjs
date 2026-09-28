import { open, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const requestedName = process.argv.slice(2).join("_").toLowerCase();
const title = requestedName.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

if (!title) {
  console.error("Usage: npm run db:create -- reason_for_change");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "db", "migrations");
const files = await readdir(migrationDirectory);
const versions = files
  .map((file) => /^(\d{6})_/.exec(file)?.[1])
  .filter(Boolean)
  .map(Number);
const nextVersion = String(Math.max(0, ...versions) + 1).padStart(6, "0");
const base = `${nextVersion}_${title}`;

for (const direction of ["up", "down"]) {
  const destination = path.join(migrationDirectory, `${base}.${direction}.sql`);
  const handle = await open(destination, "wx");
  await handle.writeFile("BEGIN;\n\nCOMMIT;\n");
  await handle.close();
  console.log(path.relative(root, destination));
}
