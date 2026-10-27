import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('migration wrapper uses the mounted socket and never logs connection failures', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-wrapper-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'migrate');
  const script = join(dir, 'wrapper.sh');
  const capture = join(dir, 'arguments');
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_CAPTURE"\nif [ "${TEST_FAIL:-}" = true ]; then echo "$DATABASE_URL" >&2; exit 2; fi\necho "24/u applied"\n', { mode: 0o755 });
  writeFileSync(script, readFileSync(new URL('../cloud-run-migrate.sh', import.meta.url), 'utf8').replace('/usr/local/bin/migrate', binary));
  const env = {
    ...process.env,
    DATABASE_URL: 'postgres://synthetic:private-value@127.0.0.1:5432/battle_platform?sslmode=require',
    MIGRATION_RELEASE_SHA: 'synthetic-release', DATABASE_URL_SECRET_VERSION: '2',
    CLOUD_SQL_INSTANCE_CONNECTION_NAME: 'test-project:asia-east1:test-db', TEST_CAPTURE: capture,
  };
  const run = (extra = {}, args = []) => spawnSync('sh', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.match(readFileSync(capture, 'utf8'), /postgres:\/\/synthetic:private-value@\/battle_platform\?host=\/cloudsql\/test-project:asia-east1:test-db&sslmode=disable/);
  assert.equal(run({}, ['version']).status, 0);
  assert.equal(readFileSync(capture, 'utf8').trim().split('\n').at(-1), 'version');
  const failure = run({ TEST_FAIL: 'true' });
  assert.equal(failure.status, 2);
  assert.doesNotMatch(failure.stdout + failure.stderr, /private-value|postgres:\/\//);
  assert.equal(run({}, ['down']).status, 1);
  assert.equal(run({ CLOUD_SQL_INSTANCE_CONNECTION_NAME: '../invalid' }).status, 1);
});
