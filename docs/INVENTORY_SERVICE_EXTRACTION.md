# Inventory service extraction

Inventory processing now lives in the private repository `yaser-ibrahim-prenetics/inventory-service` and the `im8-inventory-service` Inngest app. Battle Bus retains webhook ingress, durable publishing, order/backorder processing, and the Hub-facing event API.

## Compatibility

- Existing inventory event names and payloads are preserved. The shared contract is `config/inventory-service-contract.json`; the inventory repository verifies that its registered consumers match it.
- `/api/inventory/sync` and `/api/inventory/list` forward to `INVENTORY_SERVICE_URL` with the Secret Manager-backed `INVENTORY_SERVICE_API_KEY`. Incoming callers continue authenticating with the existing Battle Bus key. No automatic local fallback is permitted.
- Keep both apps in the same Inngest environment. Hub realtime channels remain `inventory:sync:{syncId}`.
- `INVENTORY_SERVICE_EVENTS_ENABLED=true` allows inventory webhook publishing independently of Battle Bus's former inventory-write flag. Keep it false until the stock sync activation; the initial staging release preserves disabled stock writes.
- `ENABLE_INVENTORY_RUNS` no longer registers inventory functions in Battle Bus. The service owns that switch now.

## Safe rollout

The extraction release is based on deployed commit `90e05586a053bb16542ea9f6bcb8c5c90545e4c8`, intentionally excluding unrelated changes waiting on main. Record both image digests and the existing traffic allocation before rollout. Deploy inventory initially with consumers disabled, verify its authenticated Hub callback and database readiness, deploy this Battle Bus change and sync its Inngest registration, then enable inventory consumers and sync the new app. Existing inventory workers were disabled in staging; if they are ever active during a future migration, drain them first.

Verify `inventory/integration.probe` sent through Battle Bus completes in inventory-service. The probe performs read-only checks of database access and Hub integration, including confirming inventory cannot update order rows.

## Rollback

Disable inventory consumers and sync its app before restoring the captured Battle Bus traffic allocation and syncing Battle Bus. This prevents two apps consuming the same inventory events. Additive database grants do not need destructive rollback. Old Inngest histories/checkpoints remain with the original app.

## Remaining boundaries

The first extraction retains the shared Cloud SQL read models and existing Hub callbacks. Inventory has its own runtime identity and table-scoped permissions. Narrowing copied provider adapters and moving projections to a separate schema are follow-up work, not prerequisites for independent deployment. Existing stock-write and schedule flags remain disabled in the staging deployment.
