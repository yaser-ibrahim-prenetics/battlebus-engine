import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Resolve actual serving revisions, never latestReadyRevisionName (which can
// be a failed release's zero-traffic candidate). Coalesce tagged duplicates.
export function trafficAllocation(service) {
  const weights = new Map()
  for (const entry of service.status?.traffic ?? []) {
    if (!entry.percent) continue
    assert.match(entry.revisionName ?? '', /^[a-z][a-z0-9-]+$/)
    assert(Number.isInteger(entry.percent) && entry.percent > 0 && entry.percent <= 100)
    weights.set(entry.revisionName, (weights.get(entry.revisionName) ?? 0) + entry.percent)
  }
  assert.equal([...weights.values()].reduce((sum, weight) => sum + weight, 0), 100,
    'Existing serving traffic must total 100%')
  return [...weights].sort(([a], [b]) => a.localeCompare(b))
    .map(([revision, weight]) => `${revision}=${weight}`).join(',')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(trafficAllocation(JSON.parse(readFileSync(process.argv[2], 'utf8'))))
}
