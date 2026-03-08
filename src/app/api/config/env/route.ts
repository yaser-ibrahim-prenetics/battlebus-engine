// ============================================================================
// CONFIG ENV API — Battle Bus
// ============================================================================
// Reads and writes Vercel environment variables on behalf of Battle Hub.
// All config management is centralised here so credentials never live in Hub.
//
// Required env vars (set in Battle Bus / Inngest Vercel project):
//   VERCEL_API_TOKEN          — personal access token with project write access
//   VERCEL_TEAM_ID            — team ID (e.g. "team_xxx"); omit for personal accounts
//   VERCEL_HUB_PROJECT_ID     — Vercel project ID for Battle Hub
//   VERCEL_INNGEST_PROJECT_ID — Vercel project ID for Battle Bus / Inngest
//
// GET  ?project=hub|inngest          → list all env vars for that project
// POST { project, vars[] }           → upsert vars (creates or updates)
// DELETE ?project=hub|inngest&key=X  → delete a single var by key

import { NextRequest, NextResponse } from "next/server";

const VERCEL_API = "https://api.vercel.com";

function vercelToken() {
  return process.env.VERCEL_API_TOKEN || "";
}

function teamId() {
  return process.env.VERCEL_TEAM_ID || "";
}

function projectId(project: string): string {
  if (project === "hub") return process.env.VERCEL_HUB_PROJECT_ID || "";
  if (project === "inngest") return process.env.VERCEL_INNGEST_PROJECT_ID || "";
  return "";
}

function authHeaders() {
  return {
    Authorization: `Bearer ${vercelToken()}`,
    "Content-Type": "application/json",
  };
}

function teamQS(prefix: "?" | "&") {
  const tid = teamId();
  return tid ? `${prefix}teamId=${tid}` : "";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function listEnvs(pid: string): Promise<VercelEnvVar[]> {
  let all: VercelEnvVar[] = [];
  let page = 1;

  while (true) {
    const url = `${VERCEL_API}/v9/projects/${pid}/env?limit=100&page=${page}${teamQS("&")}`;
    const res = await fetch(url, { headers: authHeaders() });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(err.error?.message || res.statusText);
    }

    const data = (await res.json()) as { envs: VercelEnvVar[] };
    all = all.concat(data.envs || []);
    if (!data.envs || data.envs.length < 100) break;
    page++;
  }

  return all;
}

// ─── GET — list env vars ──────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const token = vercelToken();
  if (!token) {
    return NextResponse.json(
      { error: "VERCEL_API_TOKEN is not configured on Battle Bus" },
      { status: 500 }
    );
  }

  const project = request.nextUrl.searchParams.get("project") || "";
  const pid = projectId(project);

  if (!pid) {
    return NextResponse.json(
      {
        error: `Unknown project "${project}". Use "hub" or "inngest".`,
        hint: "Set VERCEL_HUB_PROJECT_ID and VERCEL_INNGEST_PROJECT_ID on Battle Bus",
      },
      { status: 400 }
    );
  }

  try {
    const envs = await listEnvs(pid);

    const simplified = envs.map(({ id, key, type, value, target }) => ({
      id,
      key,
      type,
      target,
      // Only expose values for plain (non-encrypted) vars
      value: type === "encrypted" ? "[secret]" : value || "",
    }));

    return NextResponse.json({ project, envs: simplified, count: simplified.length });
  } catch (err) {
    console.error("[config/env] GET error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch env vars",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

// ─── POST — upsert env vars ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const token = vercelToken();
  if (!token) {
    return NextResponse.json(
      { error: "VERCEL_API_TOKEN is not configured on Battle Bus" },
      { status: 500 }
    );
  }

  const body = await request.json().catch(() => null);
  const { project, vars } = body || {};

  if (!project || !Array.isArray(vars) || vars.length === 0) {
    return NextResponse.json({ error: "project and vars[] are required" }, { status: 400 });
  }

  const pid = projectId(project);
  if (!pid) {
    return NextResponse.json({ error: `Unknown project "${project}"` }, { status: 400 });
  }

  // Load existing vars once so we know which to PATCH vs POST
  let existingByKey = new Map<string, VercelEnvVar>();
  try {
    const existing = await listEnvs(pid);
    existingByKey = new Map(existing.map((e) => [e.key, e]));
  } catch {
    /* fall back to create-only */
  }

  const results: Array<{ key: string; status: "upserted" | "error"; message?: string }> = [];

  for (const v of vars as Array<{
    key: string;
    value: string;
    secret?: boolean;
    environments?: string[];
  }>) {
    const {
      key,
      value,
      secret = false,
      environments = ["production", "preview", "development"],
    } = v;

    if (!key || value === undefined) {
      results.push({ key: key || "?", status: "error", message: "key and value are required" });
      continue;
    }

    const type = secret ? "encrypted" : "plain";
    const payload = { key, value, type, target: environments };

    try {
      const existing = existingByKey.get(key);
      let res: Response;

      if (existing) {
        res = await fetch(`${VERCEL_API}/v9/projects/${pid}/env/${existing.id}${teamQS("?")}`, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch(`${VERCEL_API}/v9/projects/${pid}/env${teamQS("?")}`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify([payload]),
        });
      }

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        results.push({ key, status: "error", message: err.error?.message || res.statusText });
      } else {
        results.push({ key, status: "upserted" });
      }
    } catch (err) {
      results.push({
        key,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) => r.status === "upserted").length;
  const failed = results.filter((r) => r.status === "error").length;

  console.log(
    `[config/env] POST: ${succeeded} upserted, ${failed} failed for project "${project}"`
  );

  return NextResponse.json({ succeeded, failed, results });
}

// ─── DELETE — remove an env var by key ───────────────────────────────────────

export async function DELETE(request: NextRequest) {
  const token = vercelToken();
  if (!token) {
    return NextResponse.json(
      { error: "VERCEL_API_TOKEN is not configured on Battle Bus" },
      { status: 500 }
    );
  }

  const project = request.nextUrl.searchParams.get("project") || "";
  const key = request.nextUrl.searchParams.get("key") || "";

  if (!project || !key) {
    return NextResponse.json(
      { error: "project and key query params are required" },
      { status: 400 }
    );
  }

  const pid = projectId(project);
  if (!pid) {
    return NextResponse.json({ error: `Unknown project "${project}"` }, { status: 400 });
  }

  try {
    const envs = await listEnvs(pid);
    const found = envs.find((e) => e.key === key);

    if (!found) {
      return NextResponse.json(
        { error: `Env var "${key}" not found in project "${project}"` },
        { status: 404 }
      );
    }

    const res = await fetch(`${VERCEL_API}/v9/projects/${pid}/env/${found.id}${teamQS("?")}`, {
      method: "DELETE",
      headers: authHeaders(),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return NextResponse.json(
        { error: err.error?.message || res.statusText },
        { status: res.status }
      );
    }

    console.log(`[config/env] Deleted "${key}" from project "${project}"`);
    return NextResponse.json({ success: true, deleted: key });
  } catch (err) {
    console.error("[config/env] DELETE error:", err);
    return NextResponse.json(
      {
        error: "Failed to delete env var",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface VercelEnvVar {
  id: string;
  key: string;
  type: "plain" | "encrypted" | "secret" | "system";
  value?: string;
  target?: string[];
}
