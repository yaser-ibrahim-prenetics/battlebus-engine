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
| GPS US/UK | Both authenticated inventory probes passed using development AWS parameters | Actual PR probe; no GPS secrets or runtime bindings in GCP |

## Corrections and rollout prerequisites

The original Shopify readiness probe rejected the configured hostname because Shopify returns a different canonical hostname. The probe now accepts an explicitly pinned immutable shop ID and rejects any different identity even if its hostname matches. The deployment pins the verified test-store ID. Changing environments requires reviewing that pin; it is not auto-discovered or silently replaced.

The deployed Bus remains in `SHOPIFY_STORE_MODE=test`, `DRY_RUN_MODE=true`, with D365/GPS writes disabled. It currently has no D365 or GPS environment bindings. The owner approved secret-scoped access, and its runtime identity now has verified accessor grants on the five existing Hub D365 secrets. Therefore, successful D365 probes using Hub credentials **do not prove Bus runtime connectivity**.

Approved version-1 references included in the proposed deployment workflow:

- `battle-hub-d365-base-url`
- `battle-hub-d365-client-id`
- `battle-hub-d365-client-secret`
- `battle-hub-d365-tenant-id`
- `battle-hub-d365-data-area-id`

On 28 October, the owner approved and we applied `roles/secretmanager.secretAccessor` separately on those five secrets to `battle-bus-runtime@battle-bus-509406.iam.gserviceaccount.com`. Each resulting policy was checked for the intended binding. No project-wide secret access was granted and no secret values were exposed. The PR now includes the pinned references; attachment occurs only after a separately authorized merge/deployment. Existing write switches stay disabled.

## GPS configuration discovery

Spock `develop` loads GPS settings from `src/resource/api.json` through `API.gps`. Its GPS client reads a shared `gps.baseUrl` and warehouse-specific `authentication.appKey` / `authentication.appSecret`. The Kubernetes manifest mounts `spock-store-service-api.json` into the runtime configuration path.

Read-only AWS console inspection confirmed account `672278963259`, role `ap-southeast-1-prod-admin`, region `ap-southeast-1`. Parameter Store contains these references:

| Purpose | Existing AWS parameter names |
| --- | --- |
| US endpoint and authentication | `/secrets/GPS_BASEURL`, `/secrets/GPS_APP_KEY`, `/secrets/GPS_APP_SECRET` |
| UK endpoint and app key | `/secrets/GPS_UK_BASEURL`, `/secrets/GPS_UK_APP_KEY` |
| Warehouse configuration | `/secrets/GPS_LOCATION_ID`, `/secrets/GPS_UK_LOCATION_ID`, `/secrets/GPS_UK_WAREHOUSE_CODE` |

These are **production account metadata**, not verified test-environment credentials. The GPS-name search did not show a separate UK app-secret parameter. Do not assume the US secret is shared: the deployed template mapping still needs verification. Parameter values were not revealed, downloaded or copied into GCP; no GPS provider requests were made. The connected AWS API account is development and was not used to infer production settings.

### Approved development verification

The owner selected **development AWS** for GPS verification. STS confirmed account `729553012309` and role `ap-southeast-1-dev-admin`; all parameter reads used `ap-southeast-1`. The development inventory includes separate US and UK signing secrets, resolving the UK reference question for the selected environment.

| Battle Bus setting | Development Parameter Store reference | Verified version |
| --- | --- | --- |
| `GPS_BASE_URL` | `/secrets/GPS_BASEURL` | 1 |
| `GPS_API_KEY` | `/secrets/GPS_APP_KEY` | 1 |
| `GPS_API_SECRET` | `/secrets/GPS_APP_SECRET` | 1 |
| `GPS_WAREHOUSE_CODE` | `/secrets/GPS_WAREHOUSE_CODE` | 1 |
| `GPS_UK_BASE_URL` | `/secrets/GPS_UK_BASEURL` | 1 |
| `GPS_UK_API_KEY` | `/secrets/GPS_UK_APP_KEY` | 1 |
| `GPS_UK_API_SECRET` | `/secrets/GPS_UK_APP_SECRET` | 2 |
| `GPS_UK_WAREHOUSE_CODE` | `/secrets/GPS_UK_WAREHOUSE_CODE` | 3 |

Values were resolved only in process memory and passed to a child process running the PR's actual probe. No plaintext credential files, provider records, raw errors or secret values were printed. No values were copied to GCP.

The original probe failed for both regions because its legacy inventory helper used a different signing algorithm and speculative endpoint paths. The corrected probe reuses the main GPS client's Spock-derived signing function and its `integratedInventory/pageOpen` endpoint. It requests page 1 with size 1 for the configured warehouse, requires a successful response with a records array, uses HTTPS without redirects, and applies a 10-second timeout. It performs a real read even when business writes are in dry-run mode.

US and UK authenticated reads passed in 573 ms and 390 ms respectively. Nine regression tests verify regional credentials/signatures, bounded requests, failure handling and URL protections. The four Shopify identity tests, full lint gate and production build also passed. This proves access with development-sourced credentials, not independent proof of the provider account's sandbox isolation or business-data parity.

Runtime provisioning remains separate: GPS Secret Manager copies, scoped runtime grants and pinned deployment bindings have not been created. No GPS writes, merge or deployment were performed. Do not enable writes merely to test connectivity.

These checks establish credential/environment and schema access, not historical business parity or successful execution of PR #22 on Cloud Run. The PR remains draft pending GPS runtime provisioning and separately authorized deployment verification.
