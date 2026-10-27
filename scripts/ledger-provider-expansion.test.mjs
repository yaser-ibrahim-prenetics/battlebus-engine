import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLedgerProviderExpansion } from './ledger-provider-expansion.mjs';
const safe = `ALTER TABLE public.fulfillment_actions DROP CONSTRAINT fulfillment_actions_provider_check;
ALTER TABLE public.fulfillment_actions ADD CONSTRAINT fulfillment_actions_provider_check CHECK (provider IN ('gps', 'dynamics', 'shopify'));`;
test('only accepts complete, additive provider constraint replacements', () => {
  assert.equal(isLedgerProviderExpansion(safe), true);
  assert.equal(isLedgerProviderExpansion(safe.replaceAll('fulfillment_actions', 'fulfillment_action_aliases')), true);
  for (const unsafe of [safe + ' DROP TABLE public.orders;', safe.split(';')[0]+';',
    safe.replace("'gps', ", ''), safe.replace("'shopify'", "'other'"),
    safe.replaceAll('provider_check', 'foreign_key'), safe.replaceAll('fulfillment_actions', 'orders'),
    safe.replace('CHECK (provider IN', 'CHECK (true OR provider IN')]) {
    assert.equal(isLedgerProviderExpansion(unsafe), false, unsafe);
  }
});
