/**
 * Build-time contract test: every Inngest event that gets EMITTED somewhere
 * in the codebase (`inngest.send(...)`, `step.sendEvent(...)`, or the
 * `publishWebhookEvents(...)` wrapper used by the webhook routes) must be
 * consumed by at least one REGISTERED Inngest function — i.e. it must
 * appear as an `event:` trigger (or `cancelOn` event) on a
 * `inngest.createFunction(...)` call that is actually wired into
 * `src/inngest/functions/index.ts`'s exported `functions` array (including
 * the `inventoryFunctions` sub-array, which is only registered at runtime
 * when `config.features.enableInventoryRuns` is true — for this contract we
 * treat it as registered regardless of that flag, since the static
 * event-name contract shouldn't depend on runtime config).
 *
 * This is pure static analysis over the `.ts` source text (no ts-morph / no
 * TypeScript compiler API, no live Inngest server) — deliberately simple
 * regex/string scanning per the project's existing "build-time contract
 * test" conventions. It runs as an ordinary Vitest test via `npm run test`.
 *
 * KNOWN LIMITATION: event names built dynamically (e.g.
 * `name: someVariable` or a template literal that isn't a plain string) are
 * NOT statically checked — the extraction only picks up plain string/
 * template literal `name: "..."` values. Known call sites with dynamic
 * names today: `src/app/api/inngest/rerun/route.ts` (manual replay with an
 * operator-supplied event name), `src/app/api/events/send/route.ts`
 * (generic event relay), `src/inngest/functions/drain-pending-actions.ts`
 * and `src/inngest/functions/drain-webhook-inbox.ts` (re-emit whatever was
 * queued). Those are intentionally out of scope for this contract.
 *
 * KNOWN PRE-EXISTING GAPS (tracked, not fixed here): these events are
 * emitted today but have no registered Inngest consumer. Confirmed via
 * `git stash` that this predates this contract test and today's webhook/auth
 * work — not a regression introduced alongside it. Allowlisted so the
 * contract test can start enforcing going forward without blocking on an
 * unrelated fix; remove an entry here once its consumer is wired up (or the
 * emit site is removed).
 *   - "gps/fulfilment.received"   (src/app/api/webhooks/gps/route.ts)   — real-time GPS
 *     push notification; no function consumes it today (order status appears to be
 *     synced only via the separate `cron-gps-sync` polling function instead).
 *   - "stord/fulfilment.received" (src/app/api/webhooks/stord/route.ts) — same gap
 *     for the Stord warehouse push webhook.
 *   - "backorder/resolved"        (src/inngest/functions/process-backorder.ts) —
 *     emitted as a terminal/notification event; no function subscribes to it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "../../src");
const INDEX_FILE = join(SRC_ROOT, "inngest/functions/index.ts");

/** A plain event-name string, e.g. "shopify/order.paid" or "backorder/created". */
const EVENT_NAME_RE = /^[a-z][a-z0-9_-]*\/[a-zA-Z0-9_.-]+$/;

/** Anchors that mark a file as a genuine event-emission call site. */
const SEND_ANCHORS = ["inngest.send(", "step.sendEvent(", "publishWebhookEvents("];

/**
 * Known pre-existing emitted-but-unconsumed events — see the KNOWN
 * PRE-EXISTING GAPS block in the file header comment above for why each of
 * these is here instead of having a registered consumer.
 */
const ALLOWLISTED_UNREGISTERED_EVENTS = new Set<string>([
  "gps/fulfilment.received",
  "stord/fulfilment.received",
  "backorder/resolved",
]);

function isCheckableSourceFile(path: string): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/[\\/]__tests__[\\/]/.test(path)) return false;
  if (/\.test\.tsx?$/.test(path)) return false;
  return true;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (isCheckableSourceFile(full)) {
      out.push(full);
    }
  }
  return out;
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/** Extracts the contents of the first balanced `[ ... ]` starting at `openIndex` (which must be `[`). */
function extractBalancedBracket(content: string, openIndex: number): string | null {
  if (content[openIndex] !== "[") return null;
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
    if (content[i] === "[") depth++;
    else if (content[i] === "]") {
      depth--;
      if (depth === 0) return content.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** Extracts every top-level bare identifier from an array-literal body (ignores `...spread`, comments, strings). */
function identifiersInArrayLiteral(body: string): string[] {
  // Strip line comments so commented-out identifiers don't count.
  const noComments = body.replace(/\/\/.*$/gm, "");
  const idents: string[] = [];
  const re = /(^|[\s,\[])([A-Za-z_$][A-Za-z0-9_$]*)(?=\s*[,\]])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    idents.push(m[2]);
  }
  return idents;
}

// ---------------------------------------------------------------------------
// 1. Build the set of REGISTERED event names.
// ---------------------------------------------------------------------------

function extractEventsFromTriggerLikeBlocks(content: string, keyName: "triggers" | "cancelOn"): string[] {
  const events: string[] = [];
  const keyRe = new RegExp(`${keyName}\\s*:\\s*\\[`, "g");
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(content))) {
    const openIndex = m.index + m[0].length - 1; // position of the "["
    const body = extractBalancedBracket(content, openIndex);
    if (body == null) continue;
    const eventRe = /event\s*:\s*(["'])((?:(?!\1).)*)\1/g;
    let em: RegExpExecArray | null;
    while ((em = eventRe.exec(body))) {
      events.push(em[2]);
    }
  }
  return events;
}

function buildRegisteredEvents(): { registeredEvents: Set<string>; registeredFunctionFiles: Set<string> } {
  const indexContent = readFileSync(INDEX_FILE, "utf8");

  // Map identifier -> relative file path, from either
  //   export { a, b } from "./some-file";
  // or a plain
  //   import { a, b } from "./some-file";
  // — the `functions` array below is built from the *imported* bindings, and
  // not every function imported into the array is also re-exported (e.g. a
  // function can be import-only and still be included in `functions`), so
  // both statement forms must be scanned.
  const identifierToFile = new Map<string, string>();
  const importOrExportFromRe = /(?:export|import)\s*\{([^}]*)\}\s*from\s*["'](\.\/[^"']+)["']/g;
  let efm: RegExpExecArray | null;
  while ((efm = importOrExportFromRe.exec(indexContent))) {
    const names = efm[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      identifierToFile.set(name, efm[2]);
    }
  }

  // `export const functions = [ ... ];` — top-level registered identifiers/spreads.
  const functionsDeclIdx = indexContent.indexOf("export const functions");
  expect(functionsDeclIdx, "Could not find `export const functions = [...]` in index.ts").toBeGreaterThan(-1);
  const functionsOpenBracket = indexContent.indexOf("[", functionsDeclIdx);
  const functionsBody = extractBalancedBracket(indexContent, functionsOpenBracket);
  expect(functionsBody, "Could not parse the `functions` array literal in index.ts").not.toBeNull();

  const topLevelIdents = identifiersInArrayLiteral(functionsBody as string);

  // Resolve any spread identifiers (e.g. `...inventoryFunctions`) by finding
  // their own `const <name> = ... [ ... ] ...` declaration and unioning every
  // array literal found in that declaration (covers `cond ? [a,b] : []`).
  const spreadRe = /\.\.\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const spreadNames = new Set<string>();
  let sm: RegExpExecArray | null;
  while ((sm = spreadRe.exec(functionsBody as string))) {
    spreadNames.add(sm[1]);
  }

  const allIdents = new Set(topLevelIdents.filter((n) => !spreadNames.has(n)));

  for (const spreadName of spreadNames) {
    const declRe = new RegExp(`const\\s+${spreadName}\\s*=`);
    const declMatch = declRe.exec(indexContent);
    if (!declMatch) continue;
    // Grab every array literal between this declaration and its terminating `;`.
    const declEnd = indexContent.indexOf(";", declMatch.index);
    const declSlice = indexContent.slice(declMatch.index, declEnd === -1 ? undefined : declEnd + 1);
    const bracketRe = /\[/g;
    let bm: RegExpExecArray | null;
    while ((bm = bracketRe.exec(declSlice))) {
      const body = extractBalancedBracket(declSlice, bm.index);
      if (body == null) continue;
      for (const ident of identifiersInArrayLiteral(body)) {
        allIdents.add(ident);
      }
    }
  }

  // Map each registered identifier to its source file; collect the unique file set.
  const registeredFunctionFiles = new Set<string>();
  for (const ident of allIdents) {
    const file = identifierToFile.get(ident);
    if (file) {
      registeredFunctionFiles.add(join(SRC_ROOT, "inngest/functions", file.replace(/^\.\//, "") + ".ts"));
    }
  }

  const registeredEvents = new Set<string>();
  for (const filePath of registeredFunctionFiles) {
    const content = readFileSync(filePath, "utf8");
    for (const ev of extractEventsFromTriggerLikeBlocks(content, "triggers")) {
      registeredEvents.add(ev);
    }
    for (const ev of extractEventsFromTriggerLikeBlocks(content, "cancelOn")) {
      registeredEvents.add(ev);
    }
  }

  return { registeredEvents, registeredFunctionFiles };
}

// ---------------------------------------------------------------------------
// 2. Build the list of EMITTED events (with file + line for a clear failure message).
// ---------------------------------------------------------------------------

type EmittedEvent = { event: string; file: string; line: number };

function buildEmittedEvents(): EmittedEvent[] {
  const emitted: EmittedEvent[] = [];
  const files = walk(SRC_ROOT);

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");
    const isSenderFile = SEND_ANCHORS.some((anchor) => content.includes(anchor));
    if (!isSenderFile) continue;

    const nameRe = /name\s*:\s*(["'`])([^"'`]*)\1/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(content))) {
      const candidate = m[2];
      if (!EVENT_NAME_RE.test(candidate)) continue; // skip non-event-shaped `name:` fields
      emitted.push({
        event: candidate,
        file: relative(join(__dirname, "../.."), filePath),
        line: lineNumberAt(content, m.index),
      });
    }
  }

  return emitted;
}

// ---------------------------------------------------------------------------
// 3. The contract test itself.
// ---------------------------------------------------------------------------

describe("Event consumer contract (build-time, static)", () => {
  const { registeredEvents } = buildRegisteredEvents();
  const emittedEvents = buildEmittedEvents();

  it("finds a non-trivial set of registered triggers and emitted events (sanity check)", () => {
    // Guards against the extraction silently matching nothing if the source
    // layout changes underneath this test's regexes.
    expect(registeredEvents.size).toBeGreaterThan(0);
    expect(emittedEvents.length).toBeGreaterThan(0);
  });

  it("every emitted event name has at least one registered consumer", () => {
    const unregistered = emittedEvents.filter(
      (e) => !registeredEvents.has(e.event) && !ALLOWLISTED_UNREGISTERED_EVENTS.has(e.event)
    );

    if (unregistered.length > 0) {
      const uniqueOffenders = new Map<string, EmittedEvent[]>();
      for (const e of unregistered) {
        const list = uniqueOffenders.get(e.event) ?? [];
        list.push(e);
        uniqueOffenders.set(e.event, list);
      }

      const lines = [...uniqueOffenders.entries()].map(([event, sites]) => {
        const locations = sites.map((s) => `${s.file}:${s.line}`).join(", ");
        return `  - "${event}" emitted at ${locations} — no registered trigger/cancelOn for this event name`;
      });

      throw new Error(
        `Found ${unregistered.length} emitted event occurrence(s) (${uniqueOffenders.size} distinct event name(s)) ` +
          `with no registered Inngest consumer in src/inngest/functions/index.ts:\n${lines.join("\n")}\n\n` +
          `Registered events known to the contract test: ${[...registeredEvents].sort().join(", ")}`
      );
    }

    expect(unregistered).toEqual([]);
  });
});
