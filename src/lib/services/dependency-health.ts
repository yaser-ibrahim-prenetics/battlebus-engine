import { getReadinessReport, type ReadinessDependency } from "./readiness";
import { dependencyProbes } from "@/lib/clients/dependency-probes";
import { config } from "@/lib/config";

export type DependencyHealth = Omit<ReadinessDependency, "status" | "check"> & {
  status: ReadinessDependency["status"] | "unverified";
  check: ReadinessDependency["check"] | "authenticated_read";
};
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Probe timeout")), 6000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Share in-flight probes and briefly cache results to avoid turning polling into provider load.
let pending: Promise<Awaited<ReturnType<typeof collect>>> | undefined;
let cached: { expires: number; value: Awaited<ReturnType<typeof collect>> } | undefined;
async function collect() {
  const readiness = await bounded(getReadinessReport());
  const dependencies: DependencyHealth[] = await Promise.all(
    readiness.dependencies.map(async (dependency) => {
      if (
        !dependency.required ||
        dependency.status !== "ready" ||
        dependency.check === "connectivity" ||
        dependency.check === "schema-and-privileges"
      )
        return dependency;
      const probe = dependencyProbes[dependency.name];
      if (!probe) return { ...dependency, status: "unverified" as const };
      const start = Date.now();
      try {
        await bounded(probe());
        return {
          ...dependency,
          check: "authenticated_read" as const,
          latencyMs: Date.now() - start,
        };
      } catch {
        return {
          ...dependency,
          status: "unavailable" as const,
          check: "authenticated_read" as const,
          latencyMs: Date.now() - start,
        };
      }
    })
  );
  // These enabled paths do not yet have authenticated probes. Configuration cannot prove health.
  for (const [name, required] of [
    ["stord", config.features.enableStordSync],
    ["openai_ads", config.openAiAds.enabled],
    ["loop", config.loop.enabled],
  ] as const) {
    dependencies.push({
      name,
      required,
      status: required ? "unverified" : "disabled",
      check: "configuration",
    });
  }
  return {
    ...readiness,
    dependencies,
    ok:
      readiness.ok &&
      !config.features.dryRunMode &&
      dependencies.every((d) => !d.required || d.status === "ready"),
    simulated: config.features.dryRunMode,
  };
}

export async function getDependencyHealth() {
  if (cached && cached.expires > Date.now()) return cached.value;
  pending ??= collect()
    .then((value) => {
      cached = { value, expires: Date.now() + 30000 };
      return value;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
