import { createHash, randomUUID } from "node:crypto";
import {
  replayCaseSchema,
  type ReplayAdapter,
  type ReplayCase,
} from "@/lib/domain/cutover/contracts";
import { canonicalJson, compareOutputs } from "@/lib/domain/cutover/compare";

export type ReplayEvidence = {
  id: string;
  caseId: string;
  workflowId: string;
  mode: ReplayCase["mode"];
  provenance: ReplayCase["provenance"];
  sourceReference: string;
  capturedAt: string;
  inputHash: string;
  spockRevision: string;
  busRevision: string;
  status: "matched" | "mismatch" | "error";
  differences: string[];
  spockHash: string | null;
  busHash: string | null;
  startedAt: string;
  completedAt: string;
};
export const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

async function execute(adapter: ReplayAdapter, input: ReplayCase, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.execute(freeze(structuredClone(input)), controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Replay deadline exceeded"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Adapters are injected: this coordinator imports no live provider or queue clients. */
export async function replayPair(
  raw: unknown,
  adapters: { spock: ReplayAdapter; battleBus: ReplayAdapter },
  persist: (evidence: ReplayEvidence) => Promise<void>,
  timeoutMs = 30_000
): Promise<ReplayEvidence> {
  const input = replayCaseSchema.parse(raw);
  for (const [system, adapter] of Object.entries(adapters)) {
    if (
      adapter.isolation !== "capture-only" ||
      adapter.system !== (system === "spock" ? "spock" : "battle-bus") ||
      !/^[a-f0-9]{40}$/.test(adapter.revision)
    ) {
      throw new Error("Replay requires capture-only adapters with immutable git revisions");
    }
  }
  const evidence: ReplayEvidence = {
    id: randomUUID(),
    caseId: input.caseId,
    workflowId: input.workflowId,
    mode: input.mode,
    provenance: input.provenance,
    sourceReference: input.sourceReference,
    capturedAt: input.capturedAt,
    inputHash: hash({ payload: input.payload, context: input.context }),
    spockRevision: adapters.spock.revision,
    busRevision: adapters.battleBus.revision,
    status: "error",
    differences: [],
    spockHash: null,
    busHash: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  try {
    if (!Object.values(adapters).every((adapter) => adapter.workflows.includes(input.workflowId))) {
      throw new Error("Unsupported workflow");
    }
    const [spock, bus] = await Promise.all([
      execute(adapters.spock, input, timeoutMs),
      execute(adapters.battleBus, input, timeoutMs),
    ]);
    const compared = compareOutputs(spock, bus);
    evidence.status = compared.matched ? "matched" : "mismatch";
    evidence.differences = compared.differences;
    evidence.spockHash = hash(compared.spock);
    evidence.busHash = hash(compared.battleBus);
  } catch {
    // Do not persist exception bodies: provider errors may contain customer payloads.
    evidence.differences = ["adapter_error_or_incomplete_output"];
  }
  evidence.completedAt = new Date().toISOString();
  await persist(evidence);
  return evidence;
}
