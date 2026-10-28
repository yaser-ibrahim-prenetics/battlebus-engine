async function get(path: string) {
  const token = process.env.INNGEST_SIGNING_KEY;
  if (!token) throw new Error("Inngest signing key unavailable");
  const response = await fetch(`https://api.inngest.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Inngest health HTTP ${response.status}`);
  return response.json();
}
export async function probeInngest() {
  const response = await get("/events?limit=1");
  if (!Array.isArray(response.data)) throw new Error("Incomplete Inngest health response");
  return { connectivity: "verified" as const };
}
export async function readWorkflowStatus(runId: string) {
  const response = await get(`/runs/${encodeURIComponent(runId)}`);
  if (response.data?.run_id !== runId || typeof response.data.status !== "string")
    throw new Error("Incomplete Inngest run evidence");
  return response.data.status as string;
}
