/** These two constraints only restrict provider labels. Replacing the existing
 * ('gps','dynamics') set with its strict superset preserves every existing row and
 * every active/rollback reader. Keep this deliberately narrow; all other DROP
 * CONSTRAINT statements still require contract evidence. Migrations run in a transaction.
 */
export function isLedgerProviderExpansion(sql) {
  const normalized = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "").trim();
  const match = /^ALTER\s+TABLE\s+public\.(fulfillment_actions|fulfillment_action_aliases)\s+DROP\s+CONSTRAINT\s+([a-z_]+);\s*ALTER\s+TABLE\s+public\.\1\s+ADD\s+CONSTRAINT\s+\2\s+CHECK\s*\(provider\s+IN\s*\(\s*'gps'\s*,\s*'dynamics'\s*,\s*'shopify'\s*\)\s*\)\s*;$/i.exec(normalized);
  return Boolean(match && match[2].toLowerCase() === `${match[1].toLowerCase()}_provider_check`);
}
