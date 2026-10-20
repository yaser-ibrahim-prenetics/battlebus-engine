import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { replayPair } from "../../src/lib/services/cutover/replay";
import { persistReplayEvidence } from "../../src/lib/services/cutover/evidence";
import { closeDatabase } from "../../src/lib/db/database";
import type { ReplayAdapter } from "../../src/lib/domain/cutover/contracts";

// Run only in an approved network-isolated worker, with captured provider reads.
// Adapter paths are trusted executable code, not user-supplied API input.
async function main() {
  const [cases, spockPath, busPath] = process.argv.slice(2);
  if (!cases || !spockPath || !busPath || process.env.CUTOVER_ISOLATED_WORKER !== "true") {
    throw new Error(
      "Usage (isolated worker only): tsx scripts/cutover/replay.ts cases.jsonl spock-adapter.mjs bus-adapter.mjs"
    );
  }
  const load = async (path: string): Promise<ReplayAdapter> =>
    (await import(pathToFileURL(resolve(path)).href)).default;
  const adapters = { spock: await load(spockPath), battleBus: await load(busPath) };
  const lines = createInterface({ input: createReadStream(resolve(cases)), crlfDelay: Infinity });
  let count = 0;
  let failed = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 5 * 1024 * 1024) throw new Error("Case exceeds size limit");
    const result = await replayPair(JSON.parse(line), adapters, persistReplayEvidence);
    count++;
    if (result.status !== "matched") failed++;
    // Never emit source references, payloads, context or provider error bodies.
    console.log(
      JSON.stringify({
        evidenceId: result.id,
        status: result.status,
        differences: result.differences,
      })
    );
  }
  console.log(JSON.stringify({ cases: count, failed }));
  if (!count || failed) process.exitCode = 1;
}
main()
  .catch(() => {
    console.error(
      "Replay failed; inspect isolated worker diagnostics without exposing customer payloads."
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
