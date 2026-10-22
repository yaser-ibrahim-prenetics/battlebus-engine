import assert from 'node:assert/strict'
import test from 'node:test'
import { trafficAllocation } from './traffic-allocation.mjs'

test('captures serving split, not a newer ready candidate', () => {
  assert.equal(trafficAllocation({ status: {
    latestReadyRevisionName: 'service-unused',
    traffic: [
      { revisionName: 'service-a', percent: 80 },
      { revisionName: 'service-b', percent: 20 },
      { revisionName: 'service-unused', tag: 'candidate' },
    ],
  } }), 'service-a=80,service-b=20')
})
test('coalesces weighted entries for the same revision', () => {
  assert.equal(trafficAllocation({ status: { traffic: [
    { revisionName: 'service-a', percent: 30, tag: 'old' },
    { revisionName: 'service-a', percent: 70 },
  ] } }), 'service-a=100')
})
test('rejects missing, partial, or unresolved allocations', () => {
  for (const traffic of [[], [{ revisionName: 'service-a', percent: 50 }],
    [{ latestRevision: true, percent: 100 }],
    [{ revisionName: 'service-a', percent: 100.5 }]]) {
    assert.throws(() => trafficAllocation({ status: { traffic } }))
  }
})
