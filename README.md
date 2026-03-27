# Listing Manager — Driven Brands

A Next.js application that bridges your team and the Semrush Listing Management API. Multiple team members manage business listings across CARSTAR, Take 5 Oil Change, and Auto Glass Now through a single Semrush API credential — eliminating per-seat costs.

## The Problem

Semrush charges per user seat. When multiple team members need to manage listings across hundreds of locations, those seat costs add up fast.

## The Solution

This app authenticates your team through its own auth system, then proxies all listing changes to Semrush through a single Bearer Token stored server-side. You get:

- **Unlimited team members** — no additional Semrush seats needed
- **Brand-level permissions** — editors only see their assigned brands
- **Full audit trail** — every change logged with user attribution
- **Bulk updates** — change hours/phone/status across hundreds of locations at once
- **Role-based access** — admin, manager, editor, viewer
- **Automatic fallback** — demo mode when no API token is configured

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — the app runs in demo mode by default.

## Demo Accounts

| Email | Password | Role | Access |
|-------|----------|------|--------|
| admin@drivenbrands.com | admin123 | Admin | All brands + user management |
| barry@drivenbrands.com | demo123 | Manager | All brands |
| maria@drivenbrands.com | demo123 | Editor | CARSTAR only |
| james@drivenbrands.com | demo123 | Editor | Take 5 + Auto Glass Now |

## Connecting the Semrush API

### Step 1: Get a Bearer Token

Follow [Semrush's Listing Management API tutorial](https://developer.semrush.com/api/basics/api-tutorials/listing-management-api/) to complete the Device Authorization Grant flow:

1. You'll need a Semrush account with the **Local Pro** or **Business** plan
2. Complete the OAuth Device Authorization flow to get an access token
3. Copy the Bearer Token

### Step 2: Add to Environment

Add to `.env.local` (local) or Vercel environment variables (production):

```
SEMRUSH_BEARER_TOKEN=your_token_here
```

### Step 3: Restart

Restart the dev server or redeploy on Vercel. The header badge will switch from "Demo Mode" (yellow) to "API Live" (green), and the locations page will pull real data.

### How It Works

```
Browser → Your Auth (JWT) → Next.js API Routes → Bearer Token → Semrush API → 70+ Directories
```

All API routes live in `app/api/semrush/`. The Bearer Token is **only on the server** — never exposed to the browser. The routes:

1. **Verify** the user's JWT cookie (are they logged in?)
2. **Check permissions** (does their role allow this action? do they have access to this brand?)
3. **Transform** data between your app's format and Semrush's format
4. **Proxy** the request to Semrush with the Bearer Token attached
5. **Log** the action for the activity trail

If the token is missing or expired, everything falls back to demo mode automatically.

## Deploy to Vercel

### Option 1: Git (Recommended)

1. Push this repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new) → import the repo
3. Add environment variables:
   - `JWT_SECRET` = any random 32+ character string
   - `SEMRUSH_BEARER_TOKEN` = your token (optional — skip for demo mode)
4. Deploy

### Option 2: CLI

```bash
npm i -g vercel
vercel
```

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── auth/                    # Login, logout, session
│   │   │   ├── login/route.js
│   │   │   ├── logout/route.js
│   │   │   └── me/route.js
│   │   └── semrush/                 # API proxy layer (server-side only)
│   │       ├── locations/route.js        GET  → fetch all locations
│   │       ├── locations/[id]/route.js   PUT  → update single location
│   │       ├── bulk-update/route.js      PUT  → bulk update locations
│   │       └── token/route.js            GET  → check API connection status
│   ├── dashboard/
│   │   ├── page.js                  # Locations list (main view)
│   │   ├── activity/page.js         # Activity log with filters
│   │   ├── api-status/page.js       # API health + architecture + cost comparison
│   │   ├── admin/page.js            # User management (admin only)
│   │   └── layout.js                # Dashboard shell + sidebar + auth
│   ├── login/page.js
│   └── layout.js                    # Root layout
├── components/
│   ├── EditModal.js                 # Single location editor
│   └── BulkModal.js                 # Bulk update modal
├── lib/
│   ├── auth.js                      # JWT + demo users
│   ├── data.js                      # Seed data (brands, locations, activity, roles)
│   └── semrush.js                   # Semrush API client (token mgmt, CRUD, transforms)
└── middleware.js                     # Auth route protection
```

## Semrush API Endpoints Used

| Method | Endpoint | Rate Limit | Purpose |
|--------|----------|------------|---------|
| GET | `/external/locations` | 10 req/sec | Retrieve all locations |
| PUT | `/external/locations/{id}` | 5 req/sec | Update single location |
| PUT | `/external/locations` | 5 req/sec | Bulk update locations |

The Listing Management API **does not consume API units** — included with the Local Pro/Business plan.

## Key Design Decisions

**Auto-brand detection**: `lib/semrush.js` includes `detectBrand()` which assigns CARSTAR/Take 5/Auto Glass Now based on location name or website URL. Customize the matching rules in that function for your actual naming conventions.

**Rate limiting**: Bulk updates self-throttle to ~4.5 req/sec (under Semrush's 5/sec PUT limit) with per-request error tracking. Failures don't stop the batch.

**Graceful degradation**: If the Semrush API returns an error, the app falls back to demo data and shows a banner. The user sees something useful either way.

**Server-side tokens only**: The Bearer Token lives in environment variables and `lib/semrush.js` in-memory cache. It's never serialized to the client.

## Production Roadmap

1. **Database** — Replace `lib/data.js` seed data with Postgres/MySQL (Vercel Postgres or PlanetScale)
2. **Real auth** — Swap demo JWT for corporate SSO (Okta, Azure AD, Google Workspace)
3. **Persistent tokens** — Move Semrush token storage from in-memory to Vercel KV or database
4. **Activity persistence** — Log all API interactions to database, add export for C-suite reports
5. **Sync job** — Cron that pulls location data from Semrush nightly to keep local DB current
6. **Expand API fields** — Add support for categories, descriptions, photos as Semrush expands their API
