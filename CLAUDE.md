# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # next dev — http://localhost:3000
npm run build    # next build (uses .next/)
npm run start    # serve production build
npm run lint     # next lint
```

There is no test framework configured. The project is plain JavaScript (no TypeScript), using Next.js 14 App Router with `jsconfig.json` mapping `@/*` to the repo root (e.g. `import { ... } from "@/lib/semrush"`).

Required env vars (see `.env.example`):
- `JWT_SECRET` — random ≥32 chars. There is a hardcoded fallback in `lib/auth.js` and `middleware.js`; never rely on it in production.
- `SEMRUSH_BEARER_TOKEN` — optional. Without it the app runs in **demo mode** (seed data from `lib/data.js`).
- `POSTGRES_URL` / `DATABASE_URL` (any of the four Vercel Postgres vars) — optional. Without it `lib/db.js` falls back to in-memory storage seeded from `DEMO_USERS` and `ACTIVITY_LOG`.

To initialize Postgres tables (`lm_users`, `lm_activity`, `lm_shop_numbers`), an admin must POST `/api/db` once after deploying with the env var set.

## Architecture

This is a Next.js App Router app that acts as a **thin multi-tenant proxy over the Semrush Listing Management API**. The whole company shares one Semrush Bearer Token (to avoid per-seat costs); the app's own JWT auth gates who can use it and which brands they can edit.

### Request flow

```
Browser → JWT cookie (auth-token) → middleware.js → API route → lib/semrush.js → Semrush API
                                                  ↘ lib/db.js (activity log, users, shop numbers)
```

- `middleware.js` only gates `/dashboard/*` and `/login`. **API routes verify the JWT themselves** (`verifyToken(cookies.get("auth-token"))`) — never assume middleware ran.
- The Semrush Bearer Token lives in `tokenCache` (in-memory, module-scoped) inside `lib/semrush.js`. It is **never** sent to the browser. This in-memory cache does not survive serverless cold starts — for persistent OAuth tokens, replace with Vercel KV / DB (the file already comments this).
- Every state-changing route calls `logActivity(...)` from `lib/db.js` so the activity log captures user attribution.

### Demo-mode fallback (load-bearing)

Several routes ship demo data instead of failing:
- `GET /api/semrush/locations` returns `LOCATIONS` from `lib/data.js` if either no Bearer Token is set, or the Semrush call throws.
- `PUT /api/semrush/bulk-update` and `PUT /api/semrush/locations/[id]` return a fake "UPDATED" result in demo mode.
- The header badge in `app/dashboard/layout.js` toggles between "API Live" / "Demo Mode" based on `getTokenStatus()`.

Keep this fallback when adding new Semrush-touching routes — the UI assumes it.

### Permissions model

Encoded in the JWT payload, derived from `lib/auth.js` `DEMO_USERS` or the `lm_users` table:
- `role`: `admin` | `manager` | `editor` | `viewer` (see `ROLES` in `lib/data.js`).
- `brands`: array of brand IDs (e.g. `["carstar", "take5"]`) or `["*"]` for all.
- Routes filter locations with `user.brands.includes("*") || user.brands.includes(loc.brand)`.
- Admin/manager-only routes check `user.role` directly; admin-only routes (user CRUD, `/api/db`, `DELETE /api/activity`) reject everything else.

### Semrush rate limits — non-obvious

`lib/semrush.js` is the single API client. Limits per endpoint (from the docstrings):
- `GET /external/locations`: **10 req/sec** — `getAllLocations()` paginates with a 150 ms delay (~6.5 req/sec).
- `PUT /external/locations/{id}`: 5 req/sec.
- `PUT /external/locations` (bulk): **5 requests per MINUTE**, max 50 locations per request, IDs must be unique. This is the surprising one — bulk is per-minute, not per-second.

`semrushFetch()` auto-retries 429s with 2s then 5s backoff, and auto-refreshes the token on a 401 if a refresh token is cached. Both error response shapes (`meta.success: false` and legacy `error: {...}`) are handled.

### Bulk updates: client-driven batching

Because Vercel's free-tier serverless functions time out before a long bulk run finishes, holiday updates are **batched on the client**, not the server:
- `POST /api/holiday-import` parses the CSV and returns a preview + `updates[]` array (no Semrush calls).
- The client (`app/dashboard/holiday-import/page.js`) slices into 50-location batches and calls `POST /api/holiday-push` once per batch, sleeping **15 seconds between batches** to stay under the 5/min bulk limit.
- The Semrush bulk endpoint returns HTTP 200 even when individual locations fail — `bulkUpdateLocations()` returns `[{ locationId, state: "UPDATED" | "FAILED", error? }]`. Callers must inspect each item.

The general bulk-edit modal (`components/BulkModal.js`) drives the same pattern through `PUT /api/semrush/bulk-update`. **The client must send `existingLocations`** — Semrush requires `locationName`, `city`, `address`, `phone` on every bulk item, so the route merges the change on top of these existing fields before forwarding.

### Data shape: app ↔ Semrush

`lib/semrush.js` is the only place where these translate:
- `transformLocation()` — Semrush → app (renames `locationName` → `name`, `region` → `state`; splits `websiteUrl` into `website` + `urlParams`; derives `status: "temp_closed"` from `reopenDate`).
- `toSemrushFormat()` / `toBulkSemrushFormat()` — app → Semrush. Handles **two business-hours shapes**: app format `{ monday: { open, close, closed } }` vs Semrush format `{ monday: [{ from, to }] }`. It auto-detects which one it got.
- `splitUrl()` / `joinUrl()` — website URL and query params are stored separately so URL-params bulk edits can preserve each location's base URL.
- Holiday hours are passed through as-is; they must already be in Semrush shape (`{ type: "REGULAR" | "CLOSED" | "OPENED_ALL_DAY" | "RANGE", day, times? }`). `RANGE` requires `times`; the others must omit it.

### Brand detection

`detectBrand()` in `lib/semrush.js` runs ordered substring matches against name+URL. **Order matters**: Canadian variants (`carstar-ca`, `take5-ca`, `maaco-ca`) must come before their US counterparts because the US patterns are substrings of the Canadian ones. When adding a new brand, add it to `BRAND_PATTERNS` here AND to `BRANDS` in `lib/data.js` (which carries display name + color). `getBrandConfig()` will fabricate a deterministic color for unknown brands rather than crash.

### Shop numbers

Driven Brands' internal "Shop ID" doesn't exist in Semrush — the `lm_shop_numbers` table joins the two. There are **two overlapping routes** here: `/api/shops` (admin-only, full CSV import + auto-match) and `/api/shop-numbers` (admin-or-manager, supports separate `import`/`auto-match`/`manual-match` actions). When adding shop-related features, prefer extending `/api/shop-numbers` since it has the finer-grained actions. Both use the same three matching strategies in `lib/db.js`:
1. Shop ID embedded in the Semrush website URL (strongest).
2. Normalized phone (last 10 digits).
3. Normalized street address + city.

`GET /api/semrush/locations` merges `shopId` onto each location using `mergeShopNumbers()` with the same fallback chain, so the UI sees it as just another field.
