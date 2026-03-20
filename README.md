# Listing Manager — Driven Brands

A Next.js application that serves as a bridge between your team and the Semrush Listing Management API. Multiple team members can update business listings across CARSTAR, Take 5 Oil Change, and Auto Glass Now — all through a single Semrush API credential, eliminating per-seat costs.

## The Problem

Semrush charges per user seat. When multiple team members need to manage listings across hundreds of locations, those seat costs add up fast.

## The Solution

This app authenticates your team through its own auth system, then proxies all listing changes to Semrush through a single Bearer Token stored server-side. You get:

- **Unlimited team members** — no additional Semrush seats
- **Brand-level permissions** — editors only see their assigned brands
- **Full audit trail** — every change logged with user attribution
- **Bulk updates** — change hours/phone/status across hundreds of locations at once
- **Role-based access** — admin, manager, editor, viewer

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Demo Accounts

| Email | Password | Role | Access |
|-------|----------|------|--------|
| admin@drivenbrands.com | admin123 | Admin | All brands + user management |
| barry@drivenbrands.com | demo123 | Manager | All brands |
| maria@drivenbrands.com | demo123 | Editor | CARSTAR only |
| james@drivenbrands.com | demo123 | Editor | Take 5 + Auto Glass Now |

## Deploy to Vercel

### Option 1: Git Deploy (Recommended)

1. Push this repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import the repository
4. Add environment variable: `JWT_SECRET` = any random 32+ character string
5. Deploy

### Option 2: Vercel CLI

```bash
npm i -g vercel
vercel
```

## Architecture

```
Team Members (browser)
       ↓
  Auth (JWT cookie)
       ↓
  This App (Next.js on Vercel)
       ↓
  API Routes (server-side, holds Bearer Token)
       ↓
  Semrush Listing Management API
       ↓
  70+ directories (Google, Yelp, Bing, Apple Maps, etc.)
```

## Project Structure

```
├── app/
│   ├── api/auth/          # Login, logout, session endpoints
│   ├── dashboard/
│   │   ├── page.js        # Locations list (main view)
│   │   ├── activity/      # Activity log with filters
│   │   ├── api-status/    # API health + architecture diagram
│   │   ├── admin/         # User management (admin only)
│   │   └── layout.js      # Dashboard shell + sidebar
│   ├── login/             # Login page
│   └── layout.js          # Root layout
├── components/
│   ├── EditModal.js       # Single location editor
│   └── BulkModal.js       # Bulk update modal
├── lib/
│   ├── auth.js            # JWT signing/verification + demo users
│   └── data.js            # Seed data (brands, locations, activity)
└── middleware.js           # Auth route protection
```

## Production Considerations

This prototype uses in-memory demo data. For production:

1. **Database** — Replace `lib/data.js` with Postgres/MySQL for locations, users, and activity
2. **Semrush API** — Add proxy routes in `app/api/semrush/` that attach the Bearer Token server-side
3. **Auth** — Swap JWT demo auth for your corporate SSO (Okta, Azure AD, etc.)
4. **Permissions** — Enforce brand-level access in API routes, not just the UI
5. **Webhooks** — Add a cron or webhook to sync location data from Semrush back to your DB

## Semrush API Endpoints Used

| Method | Endpoint | Rate Limit | Purpose |
|--------|----------|------------|---------|
| GET | `/listing-management/v1/external/locations` | 10 req/sec | Retrieve all locations |
| PUT | `/listing-management/v1/external/locations/{id}` | 5 req/sec | Update single location |
| PUT | `/listing-management/v1/external/locations` | 5 req/sec | Bulk update locations |

The Listing Management API **does not consume API units** — it's included with the Local Pro plan.
