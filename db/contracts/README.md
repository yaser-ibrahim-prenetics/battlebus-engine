# Contract migration evidence

Destructive production migrations are contract migrations. They may remove an
obsolete table, column, constraint, view, function, trigger, policy, index, or
other schema object only after the object is proven unused.

Keep the evidence in this directory with the same version and title as the
migration. For example:

```text
db/migrations/000005_remove_legacy_order_columns.up.sql
db/contracts/000005_remove_legacy_order_columns.md
```

The up migration must contain this marker:

```sql
-- migrate:contract
```

Copy this template into the evidence file and replace every value with real
evidence. The validator accepts only checked items and complete metadata.

```markdown
# Remove legacy order columns

Observation window: 2026-09-01 through 2026-09-28
Rollback window ended: 2026-09-28
Approved by: schema-owner@example.com
Approved on: 2026-09-28

- [x] Application references removed
- [x] Cross-repository and integration search completed
- [x] Database dependencies checked
- [x] Query telemetry observation window completed
- [x] Active and rollback revisions verified
- [x] Backup or point-in-time recovery verified
- [x] Schema owner approval recorded
```

The evidence must cover active application revisions, rollback-capable
revisions, Battle Hub and other consumers, reporting and scheduled jobs,
database dependencies, and a representative business observation window.
Production automation never runs destructive down migrations.
