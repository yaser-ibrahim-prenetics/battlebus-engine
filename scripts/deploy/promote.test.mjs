import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function exercise({ smokeFails = false, promotionFails = false, hookFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-test-'))
  try {
    const executable = (name, content) => {
      const path = join(dir, name)
      writeFileSync(path, content, { mode: 0o700 })
      return path
    }
    executable('sleep', '#!/bin/sh\nexit 0\n')
    executable('gcloud', `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_LOG"
case "$*" in
  *"--to-revisions=service-new=100"*) exit "${promotionFails ? 1 : 0}" ;;
esac
`)
    const smoke = executable('smoke', `#!/bin/sh
test "$SMOKE_TARGET" = production || exit 2
echo smoke >> "$TEST_LOG"
exit ${smokeFails ? 1 : 0}
`)
    const hook = executable('hook', `#!/bin/sh
echo hook >> "$TEST_LOG"
exit ${hookFails ? 1 : 0}
`)
    const result = spawnSync('bash', ['scripts/deploy/promote.sh', smoke], {
      encoding: 'utf8', env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`,
        TEST_LOG: join(dir, 'calls'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        GCP_PROJECT_ID: 'test', GCP_REGION: 'test', CLOUD_RUN_SERVICE: 'service',
        CANDIDATE_REVISION: 'service-new', PREVIOUS_TRAFFIC: 'service-old=80,service-older=20',
        POST_PROMOTION_HOOK: hook,
      },
    })
    return { status: result.status, calls: readFileSync(join(dir, 'calls'), 'utf8'), output: result.stdout + result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('healthy production requires three samples and does not roll back', () => {
  const result = exercise()
  assert.equal(result.status, 0, result.output)
  assert.equal(result.calls.split('\n').filter(line => line === 'smoke').length, 3)
  assert(!result.calls.includes('--to-revisions=service-old='))
  assert(result.calls.includes('hook'))
})
test('failed smoke checks restore exact split and keep the job failed', () => {
  const result = exercise({ smokeFails: true })
  assert.notEqual(result.status, 0)
  assert(result.calls.includes('--to-revisions=service-old=80,service-older=20'))
  assert(!result.calls.includes('hook'))
})
test('partial promotion failure also triggers rollback', () => {
  const result = exercise({ promotionFails: true })
  assert.notEqual(result.status, 0)
  assert(result.calls.includes('--to-revisions=service-old=80,service-older=20'))
  assert(!result.calls.includes('smoke'))
})
test('registration failure after successful smoke checks triggers rollback', () => {
  const result = exercise({ hookFails: true })
  assert.notEqual(result.status, 0)
  assert(result.calls.includes('--to-revisions=service-old=80,service-older=20'))
})
