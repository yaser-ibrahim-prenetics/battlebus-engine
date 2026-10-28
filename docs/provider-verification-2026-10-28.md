# GCP provider verification — 28 October 2026

Read-only verification performed after renewing Google Cloud authentication. No orders, payments, inventory, fulfillments, business data, workflow events or deployed service configuration were changed.

| Check | Observed result | Scope |
| --- | --- | --- |
| Bus liveness | HTTP 200, revision `battle-bus-0ee6c0ea-40629249133-1` | Currently deployed main |
| Bus database readiness | HTTP 200 | Cloud SQL connection |
| Authenticated Bus readiness | HTTP 200, dry run true | Cloud SQL connectivity; other dependencies are configuration-only in deployed main |
| Bus-to-Hub integration | HTTP 200; authenticated callback and location mappings reachable; `writes=false` | Existing Bus runtime identity, live IAP path |
| Hub native health | `battle_hub`, data API ready, row security enforced | Authenticated Cloud Run endpoint |
| Shopify identity | Shop ID `69493719272`; configured host `testing-im8store.myshopify.com`; canonical host `im8health.myshopify.com`; primary host `testing.im8health.com` | Existing test-store credential version 1, actual PR probe |
| Inngest | Authenticated read succeeded | Existing Bus signing-key reference |
| D365 U001 and H007 | Company-scoped header and all selected reconciliation schemas readable | Existing **Hub** credentials against `https://p-uat.sandbox.operations.dynamics.com` |
| GPS US/UK | Not verified: no credential references configured | No GPS secrets found in this GCP project |

## Corrections and rollout prerequisites

The original Shopify readiness probe rejected the configured hostname because Shopify returns a different canonical hostname. The probe now accepts an explicitly pinned immutable shop ID and rejects any different identity even if its hostname matches. The deployment pins the verified test-store ID. Changing environments requires reviewing that pin; it is not auto-discovered or silently replaced.

The deployed Bus remains in `SHOPIFY_STORE_MODE=test`, `DRY_RUN_MODE=true`, with D365/GPS writes disabled. It currently has no D365 or GPS environment bindings. Its runtime identity has no accessor grant on the five existing Hub D365 secrets. Therefore, successful D365 probes using Hub credentials **do not prove Bus runtime connectivity**.

Proposed version-1 references, pending explicit access approval before adding them to the deployment workflow:

- `battle-hub-d365-base-url`
- `battle-hub-d365-client-id`
- `battle-hub-d365-client-secret`
- `battle-hub-d365-tenant-id`
- `battle-hub-d365-data-area-id`

Before deployment, explicitly approve and grant `roles/secretmanager.secretAccessor` on those five secrets only to `battle-bus-runtime@battle-bus-509406.iam.gserviceaccount.com`. Do not grant project-wide secret access. After access approval, add the references to the existing deployment pipeline; attachment would occur only after a separately authorized merge/deployment. Automatic approval review blocked publishing the proposed secret bindings before that approval, so they are not included in the workflow. Existing write switches stay disabled.

GPS verification requires approved US/UK endpoint and credential references or an approved protected configuration file. Do not paste credential values into PRs or chat. Do not enable GPS writes merely to test connectivity.

These checks establish credential/environment and schema access, not historical business parity or successful execution of PR #22 on Cloud Run. The PR remains draft until runtime access and missing-provider verification are resolved.
