# GPS / XLWMS environment variables

Battle Bus uses **environment variables** for GPS credentials. Spock Store stores the same values in the Kubernetes secret **`api.json`** under `gps.warehouse`.

## Quick copy: Battle Bus ↔ Spock Store

| Battle Bus env var      | Spock Store `api.json` path                                  | Notes                                                                             |
| ----------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `GPS_BASE_URL`          | `gps.baseUrl`                                                | Typically `https://api.xlwms.com`                                                 |
| `GPS_API_KEY`           | `gps.warehouse["GPS Warehouse"].authentication.appKey`       | **US** outbound / JFK                                                             |
| `GPS_API_SECRET`        | `gps.warehouse["GPS Warehouse"].authentication.appSecret`    | **US**                                                                            |
| `GPS_WAREHOUSE_CODE`    | `gps.warehouse["GPS Warehouse"].code`                        | Optional; default `JFK01W`                                                        |
| `GPS_UK_API_KEY`        | `gps.warehouse["GPS UK Warehouse"].authentication.appKey`    | **UK**                                                                            |
| `GPS_UK_API_SECRET`     | `gps.warehouse["GPS UK Warehouse"].authentication.appSecret` | **UK**                                                                            |
| `GPS_UK_BASE_URL`       | _(optional)_                                                 | Defaults to `GPS_BASE_URL`                                                        |
| `GPS_UK_WAREHOUSE_CODE` | `gps.warehouse["GPS UK Warehouse"].code`                     | Optional; default in code is `LHR` — **must match your live secret / GPS portal** |

### Same key for US and UK?

Spock has **two** `authentication` blocks. They may contain the **same** `appKey`/`appSecret` or **different** ones — only your production `api.json` secret knows.

- If both warehouses use the **same** pair in Spock: set `GPS_API_KEY` / `GPS_API_SECRET` to that pair; you can **omit** `GPS_UK_*` and UK will **fall back** to the US vars (see `inngest/src/lib/clients/gps.ts` → `getApiCredentials`).
- If they **differ**: set **both** `GPS_*` and `GPS_UK_*`. If US fails but UK works, your US env vars likely **do not** match the `"GPS Warehouse"` block in the secret.

## Local development

1. Copy the example file:

   ```bash
   cd inngest
   cp .env.example .env.local
   ```

2. Paste values from Spock’s `api.json` (or from your secrets manager) into `.env.local`.

3. Set `ENABLE_GPS_SYNC=true` when you want real GPS calls (never commit `.env.local`).

## Vercel / production

Set the same variables in the **Battle Bus** project: **Settings → Environment Variables** (Production + Preview as needed). See also `hub/docs/VERCEL_ENV_SETUP.md`.

**Hub (optional):** If you use `hub/api/gps/proxy.ts`, set `GPS_BASE_URL`, `GPS_API_KEY`, `GPS_API_SECRET` on the Hub project too; UK proxy reads `GPS_UK_*` with fallback to US.

## Validation

With `ENABLE_GPS_SYNC=true`, Battle Bus validates on load (see `inngest/src/lib/config.ts`): `GPS_BASE_URL`, `GPS_API_KEY`, and `GPS_API_SECRET` are required. If you set `GPS_UK_API_KEY`, you must set `GPS_UK_API_SECRET`.

## Warehouse codes

Static defaults also live in `inngest/src/lib/mappings/warehouse-config.json` (`gpsCode`). Env overrides (`GPS_WAREHOUSE_CODE`, `GPS_UK_WAREHOUSE_CODE`) must stay in sync with what XLWMS expects for your tenant. If Spock’s secret uses a different UK code than this repo’s JSON, prefer the **secret / portal** value in env vars.
