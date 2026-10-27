/** Read-only OData pagination. Never forward bearer tokens to a foreign nextLink. */
export async function* odataRows<T>(first: URL, token: string): AsyncGenerator<T> {
  let next: URL | null = first;
  const visited = new Set<string>();
  while (next) {
    if (
      next.protocol !== "https:" ||
      next.origin !== first.origin ||
      next.pathname !== first.pathname ||
      next.username ||
      next.password ||
      next.hash
    )
      throw new Error("Unsafe Dynamics OData continuation URL");
    if (visited.has(next.href) || visited.size >= 10000)
      throw new Error("Dynamics pagination repeated or exceeded page limit");
    visited.add(next.href);
    const response = await fetch(next, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Dynamics reconciliation HTTP ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page.value) || page.error)
      throw new Error("Incomplete Dynamics reconciliation page");
    for (const row of page.value) yield row as T;
    const link: unknown = page["@odata.nextLink"];
    if (link != null && (typeof link !== "string" || !link))
      throw new Error("Invalid Dynamics continuation link");
    next = typeof link === "string" ? new URL(link, next) : null;
  }
}
