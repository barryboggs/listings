# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # next dev — http://localhost:3000
npm run build    # next build (uses .next/)
npm run start    # serve production build
npm run lint     # next lint
```

There is no test framework configured. The project is plain JavaScript (no TypeScript), using Next.js 14 App Router with `jsconfig.json` mapping `@/*` to the repo root (e.g. `import { ... } from "@/lib/semrush-rich"`).

Required env vars (see `.env.example`):
- `JWT_SECRET` — random ≥32 chars. There is a hardcoded fallback in `lib/auth.js` and `middleware.js`; never rely on it in production.
- `SEMRUSH_API_KEY` — required for live mode. Without it the app runs in **demo mode** (seed data from `lib/data.js`). Pulled from the Semrush Subscription Info page. Uses `Authorization: Apikey` header. This is a **long-lived credential** — no rotation, no expiry, no refresh cycle. If it stops working, generate a new one on the Semrush side and update the env var.
- `POSTGRES_URL` / `DATABASE_URL` (any of the four Vercel Postgres vars) — optional. Without it `lib/db.js` falls back to in-memory storage seeded from `DEMO_USERS` and `ACTIVITY_LOG`.

To initialize Postgres tables (`lm_users`, `lm_activity`, `lm_shop_numbers`, `lm_oauth_tokens`, `lm_pending_pushes`, `lm_gbp_photo_pushes`, `lm_image_pushes`, `lm_integration_secrets`), an admin must POST `/api/db` once after deploying with the env var set. `CREATE TABLE IF NOT EXISTS` everywhere, so re-running is always safe.

`lm_oauth_tokens` currently only carries rows for `provider = 'google_bp'` — the Semrush deprecated OAuth flow was retired during the July 2026 API migration. The table remains because the GBP integration scaffold uses it, but no Semrush code paths touch it anymore.

## Migration note (July 2026)

The app used to run against the deprecated `/apis/v4-raw/listing-management/v1` API (OAuth Device Auth, 7-day access-token rotation, refresh-token single-use chain that repeatedly broke in production). Semrush confirmed that endpoint is deprecated and pointed us at `/apis/v4/local/v1` (Apikey auth, no rotation). The whole app now talks to only that API. Retired in the migration:

- `SEMRUSH_BEARER_TOKEN` env var + `SEMRUSH_REFRESH_TOKEN` + `SEMRUSH_CLIENT_ID` + `SEMRUSH_OAUTH_SCOPE`
- `/api/admin/semrush-tokens` (OAuth token admin surface)
- `/api/integrations/semrush-access-token` (token broker for external apps — those apps should now hold their own Apikey directly)
- `/api/admin/integration-broker-secret` (admin surface for the broker)
- `scripts/get-semrush-token.mjs`, `scripts/reauth-semrush.mjs`, and OAuth diagnostic scripts
- OAuth exports on `lib/semrush.js` (`getTokenStatus`, `refreshAccessToken`, `setTokens`, `getAccessToken`, `ensureTokensLoaded`, `initiateDeviceAuth`, `pollForToken`)

`lib/semrush.js` now contains **only pure utilities** (`detectBrand`, `splitUrl`, `joinUrl`, `BRAND_PATTERNS`) — no network, no auth, no state. All Semrush API calls go through `lib/semrush-rich.js`.

## Architecture

Next.js App Router app that acts as a **thin multi-tenant proxy over the Semrush Listing Management API**. One company-wide `SEMRUSH_API_KEY` (to avoid per-seat costs); the app's own JWT auth gates who can use it and which brands they can edit.

### Request flow

```
Browser → JWT cookie (auth-token) → middleware.js → API route → lib/semrush-rich.js → Semrush API
                                                  ↘ lib/db.js (activity log, users, shop numbers)
```

- `middleware.js` only gates `/dashboard/*` and `/login`. **API routes verify the JWT themselves** (`verifyToken(cookies.get("auth-token"))`) — never assume middleware ran.
- The Semrush Apikey lives in `process.env.SEMRUSH_API_KEY`, read on every call by `getRichApiKey()` inside `lib/semrush-rich.js`. It is **never** sent to the browser. Nothing is cached, nothing rotates — just a header on every fetch.
- Every state-changing route calls `logActivity(...)` from `lib/db.js` so the activity log captures user attribution.

### Demo-mode fallback (load-bearing)

Several routes ship demo data instead of failing:
- `GET /api/semrush/locations` returns `LOCATIONS` from `lib/data.js` if either no Apikey is set, or the Semrush call throws.
- `PUT /api/semrush/bulk-update` and `PUT /api/semrush/locations/[id]` return a fake success in demo mode.
- The header badge in `app/dashboard/layout.js` toggles between "API Live" / "Demo Mode" based on `getRichStatus()`.

Keep this fallback when adding new Semrush-touching routes — the UI assumes it.

### Permissions model

Encoded in the JWT payload, derived from `lib/auth.js` `DEMO_USERS` or the `lm_users` table:
- `role`: `admin` | `manager` | `editor` | `viewer` (see `ROLES` in `lib/data.js`).
- `brands`: array of brand IDs (e.g. `["carstar", "take5"]`) or `["*"]` for all.
- Routes filter locations with `user.brands.includes("*") || user.brands.includes(loc.brand)`.
- Admin/manager-only routes check `user.role` directly; admin-only routes (user CRUD, `/api/db`, `DELETE /api/activity`) reject everything else.

### Semrush API — key facts

Base URL: `https://api.semrush.com/apis/v4/local/v1`. Auth: `Authorization: Apikey <SEMRUSH_API_KEY>`. Field naming: snake_case (`business_name`, `phone_number`, `website_url`, `business_hours`, `special_hours`, `reopen_date`).

- **List**: `GET /locations?offset={n}&limit={<=50}`. Server hard-caps at 50 items/page; `getAllRichLocations()` paginates with a 250ms throttle.
- **Update**: `PATCH /locations/{id}?update_mask=field,field` — only fields in the mask are touched. **No bulk endpoint.** Every update is per-location.
- **Business hours** use `_hours`-suffixed day keys (`monday_hours`, `tuesday_hours`, ...) — the `richBusinessHoursToApp` / `appBusinessHoursToRich` helpers in `lib/semrush-rich.js` translate between this and the app's `{ monday: [...], ... }` shape.
- **Country field** is `country` (e.g. `"US"`), NOT `country_code`.

Rate limits aren't publicly documented for the rich API; a 250ms per-request throttle has run cleanly for months across bulk-image push and now bulk edits. `richFetch()` auto-retries 429s with 2s then 5s backoff.

### Canonical location ID

The app's `location.id` is the rich-API `location_id`. Every route that receives an ID (path segment, request body, DB row) uses this value. Old-API IDs are no longer used at rest — pre-migration DB rows still carry `semrush_location_id` (old-API) alongside `semrush_new_id` (rich-API) on `lm_shop_numbers`, but the code path only reads `semrush_new_id`.

Shop-number matching populates `semrush_new_id` via `/api/db/sync-rich-mappings` — matches shop records (in `lm_shop_numbers`) to rich API locations by website URL → phone → address+city (same heuristic order as the historical shop matcher). Idempotent; re-run any time.

### Bulk updates: per-location PATCH loop

The rich API has no bulk endpoint, so bulk paths loop per-location PATCH with a 250ms throttle:

- **General bulk edit** (`components/BulkModal.js` → `PUT /api/semrush/bulk-update`): client chunks into ≤50-location batches (server enforces the cap), inter-batch sleep in the modal, sequential PATCH per location on the server (max ~52s per chunk under `maxDuration=90`).
- **Holiday CSV import** (`app/dashboard/holiday-import/page.js` → `POST /api/holiday-push`): same shape — client chunks ≤50, server loops PATCHes.

Because PATCH only touches the fields in `update_mask`, `existingLocations` from the client is no longer needed for the "must send every required field" reason it existed on the old API. It IS still passed for one narrow case: the `holiday_hours` bulk field defensively piggybacks the shop's current `business_hours` on the PATCH, mirroring the old-API quirk that rejected `special_hours`-only updates. If the rich API doesn't need this, the extra key is a no-op (identity write).

Per-item results: `[{ locationId, state: "UPDATED" | "FAILED" | "SKIPPED", error? }]`.

### Bulk listing-photo push

[/dashboard/listings-photos](app/dashboard/listings-photos/page.js) pushes one image to every shop in a brand via Semrush's rich-API image endpoint. Same `Authorization: Apikey` auth. Reaches every directory Semrush distributes to (Google, Bing, Yelp, Apple Maps, Facebook, etc.).

Confirmed shape (via Semrush support):
- Endpoint: `POST /apis/v4/local/v1/locations/{location_id}/images`
- Body: `{ content: <base64>, type: "PHOTO", description? }` — **base64-encoded inline JSON**, NOT URL reference, NOT multipart
- Response: `{ id, url, type, createDate }` — `url` is a `storage.googleapis.com` storage URL

The page accepts either a pasted URL or a drag-drop upload (Vercel Blob — requires `BLOB_READ_WRITE_TOKEN` env). The bulk-image route at [app/api/semrush/bulk-image/route.js](app/api/semrush/bulk-image/route.js) fetches the source URL **once**, base64-encodes **once**, then loops over the brand's shops (those with `semrush_new_id` populated) with a 250ms throttle between requests. Each push records to `lm_image_pushes` (PENDING → SUCCESS|FAILED) for the history panel and audit log. Client batches at 30 shops/call to stay under Vercel's 60s Pro function timeout (route also bumps `maxDuration = 90`).

Shops without a `semrush_new_id` mapping are reported as "skipped" — run the rich-mappings sync on the Admin page to enable them.

Three reliability features built atop the push because Semrush's image endpoint has rough edges:

- **Server-side resize on upload** ([app/api/upload-image-blob/route.js](app/api/upload-image-blob/route.js)) — sharp resizes anything over 1200px on the long edge (JPEG q85, PNG preserved for transparency). 1.4 MB uploads were tripping Semrush's parser into a generic 400 "Invalid request" even when the image actually landed; resizing to under 500 KB usually makes Semrush respond cleanly. The page shows a preview thumbnail and "Resized from X → Y" metadata before push so the admin can verify.
- **Verify-after-fail** in the bulk-image route — after each FAILED POST, the route does a GET on the shop's images and looks for one with a `createDate` within ~60 seconds of the push. If found, the row is flipped to SUCCESS with the Semrush image_id + URL captured. Catches the "Semrush stored it but returned a 400" pattern automatically.
- **Audit endpoint** at [app/api/admin/audit-image-pushes](app/api/admin/audit-image-pushes/route.js) (admin-only "Audit Failed" button on the page) — retroactively runs the same verify check across recent FAILED rows.
- **Skip-mode** in the push UI (default ON) — at run start, the client asks the server for shops with a SUCCESS row matching the exact source URL, filters them out. Re-uploading the same file gets a new Vercel Blob URL (timestamp in path), so a "redo with resized image" workflow correctly bypasses skip-mode.

### GBP integration (Phase 0 scaffolding present, deeper phases pending)

A scaffold for direct Google Business Profile photo pushes lives in [lib/google-bp.js](lib/google-bp.js) — OAuth 2.0 authorization-code flow against the GBP API, token persistence via `lm_oauth_tokens` (provider `google_bp`), and stub helpers for listing accounts/locations and creating media. The `business.manage` scope is requested with `access_type=offline` and `prompt=consent` so we reliably get a refresh token. Activates only when `GOOGLE_BP_CLIENT_ID`/`SECRET` are set in env — without them, `isGoogleBpConfigured()` is false and the OAuth routes return 503.

OAuth flow at `/api/auth/google-bp/start` (admin-only) and `/api/auth/google-bp/callback`. `lm_shop_numbers` carries `gbp_account_id` + `gbp_location_id` for the Phase 2 shop↔GBP mapping. `lm_gbp_photo_pushes` audits Phase 3 bulk pushes. None wired to UI yet.

### Data shape: app ↔ Semrush

All translation lives in [lib/semrush-rich.js](lib/semrush-rich.js):
- `appLocationFromRich(rich)` — rich API → app shape. Sets `id = location_id`, flattens `business_hours` to app's `{ monday: [...], ... }` shape, splits `website_url` into `website` + `urlParams`, derives `status: "temp_closed"` from `reopen_date`, folds in all rich fields (description, categories, coordinates, etc.) so the list payload drives both the row grid AND the Extras tab.
- `appChangesToRichPatch(changes)` — app-shape change set → `{ fields, updateMask }` ready for `updateRichLocation()`. Only keys present in `changes` become part of the mask. Website + urlParams collapse to `website_url` if either is supplied.
- `splitUrl()` / `joinUrl()` — website URL and query params are stored separately so URL-params bulk edits can preserve each location's base URL. Duplicated in `lib/semrush.js` for callers that still import from there.
- Holiday hours pass through as-is; must be in Semrush shape (`{ type: "CLOSED" | "OPENED_ALL_DAY" | "RANGE", day, times? }`). `RANGE` requires `times`; the others omit it.

### EditModal save flow

Post-migration this is one call. The parent's `handleSave` in [app/dashboard/page.js](app/dashboard/page.js) sends `PUT /api/semrush/locations/[id]` with the diffed change set (`{ changes: {...} }`) — the route builds one PATCH from all the app-shape keys in the change object and touches only those on Semrush's side. No more dual-save orchestration; no more "rich save then core save" ordering.

The legacy `PATCH /api/semrush/rich/[id]` route (used pre-migration for the Extras tab) still exists for any code still hitting it, but new code should go through the unified single-edit route.

### Brand detection

`detectBrand()` in `lib/semrush.js` runs ordered substring matches against name+URL. Accepts either app-shape (`{ name, website }`) or rich-API shape (`{ business_name, website_url }`). **Order matters**: Canadian variants (`carstar-ca`, `take5-ca`, `maaco-ca`) must come before their US counterparts because the US patterns are substrings of the Canadian ones. When adding a new brand, add it to `BRAND_PATTERNS` here AND to `BRANDS` in `lib/data.js` (which carries display name + color). `getBrandConfig()` will fabricate a deterministic color for unknown brands rather than crash.

### Categories picker

The picker in EditModal hits `GET /api/semrush/categories` once on mount. That route proxies `getCategories()` in [lib/semrush-rich.js](lib/semrush-rich.js), which caches the catalog in-process for 24h per-country. If the upstream endpoint 404s or errors, the route returns `{ categories: [], reason }` — the picker degrades to a free-text input that accepts raw category IDs.

### API-health badge

`lib/semrush-rich.js` tracks `lastSuccessAt` / `lastErrorAt` / `lastErrorMessage` in module scope. `richFetch()` is wrapped in try/catch that calls `recordRichSuccess` / `recordRichError` so every call updates telemetry. `getRichStatus()` exposes this as a `state` field: `"healthy"` (success more recent than any error), `"failing"` (error more recent than success), `"untested"` (key configured but no calls yet from this worker), `"no_key"` (not configured).

[app/api/semrush/token/route.js](app/api/semrush/token/route.js) actively pings `GET /locations?limit=1` before returning telemetry so a cold worker's badge reflects current truth rather than the per-worker cache. Adds ~150ms to badge polls. `?skipPing=1` short-circuits for diagnostic use. Response shape still has `oldApi` for backwards compatibility with any lingering callers, but it always reports `no_token` post-migration — `richApi` is the field that matters.

### Bulk rich-field updates

[components/BulkModal.js](components/BulkModal.js) supports rich fields (`description`, `featured_message`, `suppress_address`, `youtube_video`, `instagram_username`, `twitter_username`, `category_append`) alongside the core fields (hours, phone, website, holiday hours, temp closure). All flow through `PUT /api/semrush/bulk-update` post-migration — no more separate route for rich vs. core.

`skipped` count means the location has no `semrush_new_id` mapping in `lm_shop_numbers`; the row can't be updated until sync-rich-mappings is re-run. Distinct from `failed`, which represents an actual API error.

**Append-categories** is a special case marked by `appendCategories: true` on the FIELDS entry. It costs **two API calls per location** (GET to read current categoryIds, then PATCH to write merged list). Merge logic: union of current + requested, deduped, capped at the API's 10-category limit, current-first ordering preserved (so the existing primary stays primary). If a location already has every requested category, no PATCH fires — counted as success with a separate `noopCount` shown in the progress UI as "Already had all". The category picker pre-loads the catalog for the brand's apparent country (`brandLocations[0]?.countryCode || "US"`) and falls back to free-text input when the catalog is empty or unavailable.

### Password management

Admin-set passwords (create or reset via [app/dashboard/admin/page.js](app/dashboard/admin/page.js)) mark `lm_users.password_temp = TRUE`. On the user's next login, [app/dashboard/layout.js](app/dashboard/layout.js) reads `passwordTemp` from `/api/auth/me` and redirects them to `/dashboard/account`, where the page renders in "forced" mode (no current-password field — they just authenticated with it). On submit, `PATCH /api/account/password` calls `updateOwnPassword()` which sets the new password and clears `password_temp`, then a full `window.location.href` reload refreshes the layout's user state. Voluntary password changes (from the header "Account" link) require the current password and don't trigger a hard reload.

The schema migration (`ALTER TABLE lm_users ADD COLUMN IF NOT EXISTS password_temp`) lives in `initDatabase()` and is called defensively by `/api/users` POST/PUT and `/api/account/password` PATCH, so the column is guaranteed present before any write that references it.

### Listing Health view

[app/dashboard/health/page.js](app/dashboard/health/page.js) is a triage view for locations Semrush reports as having sync errors. No new API calls — it reads `semrushErrors` straight from the same `/api/semrush/locations` response the main page already uses, filters to rows where `semrushErrors.length > 0`, and lets you sort by error count, brand, state, or name. Clicking a row opens [components/EditModal.js](components/EditModal.js) with `initialTab="errors"` so the user lands directly on the errors view.

[app/dashboard/page.js](app/dashboard/page.js) carries a status-distribution row (StatusCard) above the per-brand summary: Healthy / With Errors / Processing / Temp Closed counts with percent of total. The "With Errors" tile is a link to `/dashboard/health` when its value is > 0.

`semrushErrors` shape (per location, from the rich API's `errors` array): `[{ code: string, message: string, details?: [...] }]`. Errors are emitted by Semrush after a push to a downstream directory fails — they typically resolve when the offending field is corrected and the listing is re-pushed.

### Shop numbers

Driven Brands' internal "Shop ID" doesn't exist in Semrush — the `lm_shop_numbers` table joins the two. There are **two overlapping routes** here: `/api/shops` (admin-only, full CSV import + auto-match) and `/api/shop-numbers` (admin-or-manager, supports separate `import`/`auto-match`/`manual-match` actions). When adding shop-related features, prefer extending `/api/shop-numbers` since it has the finer-grained actions. Both use the same three matching strategies in `lib/db.js`:
1. Shop ID embedded in the Semrush website URL (strongest).
2. Normalized phone (last 10 digits).
3. Normalized street address + city.

`GET /api/semrush/locations` merges `shopId` onto each location using `mergeShopNumbers()` — primary lookup is by `semrush_new_id` (rich-API location_id), with URL/phone fallbacks for shops that haven't been sync'd yet.
