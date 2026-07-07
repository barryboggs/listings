import { DEMO_USERS } from "@/lib/auth";
import { ACTIVITY_LOG as SEED_ACTIVITY } from "@/lib/data";

/**
 * Database layer for Vercel Postgres (Neon).
 *
 * IMPORTANT: @vercel/postgres is lazy-loaded to avoid build-time connection
 * attempts that hang the Next.js build process. The `db()` helper returns
 * the sql tagged template only when actually called at runtime.
 *
 * Tables:
 *   - lm_users: team members with roles and brand access
 *   - lm_activity: audit log of all API actions
 *   - lm_shop_numbers: Driven Brands shop # ↔ Semrush ID mapping
 *   - lm_oauth_tokens: persisted OAuth tokens (survives cold starts; needed
 *     because Semrush rotates refresh tokens on use, so the env-var refresh
 *     token becomes invalid after the first successful refresh)
 *   - lm_pending_pushes: per-shop log of updates we've pushed to Semrush,
 *     so we can show a "shops awaiting approval in Semrush's Updates queue"
 *     view (Semrush has no API for that queue, so we infer it from our own
 *     push history — see /dashboard/pending-approval)
 *   - lm_gbp_photo_pushes: audit log of GBP Media API photo pushes — drives
 *     the bulk-photo-push progress UI and lets us trace failures per-shop
 *     (added during Phase 0 scaffolding; the route that writes to it is
 *     wired in Phase 3)
 *   - lm_image_pushes: audit log of Semrush listing-image bulk pushes
 *     (POST /locations/:id/images on the rich API). Active feature — the
 *     /dashboard/listings-photos page writes to this on every push and
 *     reads it back for the history panel.
 *   - lm_integration_secrets: hashed bearer secrets for the external-
 *     integration token-broker endpoint. Lets other apps (e.g. a coworker's
 *     local script) fetch the current Semrush access token without ever
 *     touching the refresh-token chain — this app stays the sole authority.
 *
 * lm_shop_numbers also carries gbp_account_id / gbp_location_id columns for
 * the Driven Brands shop → GBP location mapping (populated by the Phase 2
 * sync job, used by the Phase 3 bulk-photo-push route).
 *
 * Falls back to in-memory storage if no Postgres connection is available.
 */

// ---------------------------------------------------------------------------
// Lazy Postgres import
// ---------------------------------------------------------------------------

let _sql = null;

async function db() {
  if (!_sql) {
    const mod = await import("@vercel/postgres");
    _sql = mod.sql;
  }
  return _sql;
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

let memUsers = null;
let memActivity = null;

function getMemUsers() {
  if (!memUsers) memUsers = DEMO_USERS.map(({ password, ...u }) => ({ ...u }));
  return memUsers;
}

function getMemActivity() {
  if (!memActivity) memActivity = [...SEED_ACTIVITY];
  return memActivity;
}

export function hasPostgres() {
  return !!(
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_URL_UNPOOLED
  );
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

export async function initDatabase() {
  if (!hasPostgres()) {
    return { initialized: false, reason: "No Postgres connection configured" };
  }

  try {
    const sql = await db();

    await sql`
      CREATE TABLE IF NOT EXISTS lm_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT,
        role TEXT NOT NULL DEFAULT 'editor',
        initials TEXT,
        brands JSONB NOT NULL DEFAULT '[]',
        created_at TEXT
      )
    `;

    // password_temp marks passwords set by an admin (create or reset) so the
    // user is forced to change it on next login. Cleared when the user
    // changes their own password via /api/account/password.
    await sql`
      ALTER TABLE lm_users ADD COLUMN IF NOT EXISTS password_temp BOOLEAN DEFAULT FALSE
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS lm_activity (
        id TEXT PRIMARY KEY,
        time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        location TEXT,
        brand TEXT,
        details TEXT
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS lm_shop_numbers (
        shop_id TEXT PRIMARY KEY,
        brand TEXT NOT NULL,
        street_address TEXT,
        address2 TEXT,
        city TEXT,
        country TEXT,
        state TEXT,
        zip TEXT,
        phone TEXT,
        website TEXT,
        semrush_location_id TEXT,
        matched_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Phase 1: maps old-API semrush_location_id → new-API location_id.
    // Populated by POST /api/db/sync-rich-mappings (admin only).
    await sql`
      ALTER TABLE lm_shop_numbers ADD COLUMN IF NOT EXISTS semrush_new_id TEXT
    `;
    await sql`
      ALTER TABLE lm_shop_numbers ADD COLUMN IF NOT EXISTS rich_matched_at TIMESTAMPTZ
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_shop_numbers_semrush_id ON lm_shop_numbers(semrush_location_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_shop_numbers_brand ON lm_shop_numbers(brand)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_shop_numbers_new_id ON lm_shop_numbers(semrush_new_id)
    `;

    // Phase 0 scaffolding for GBP integration: shop → GBP location mapping
    // (a 4th ID space alongside shop_id, semrush_location_id, semrush_new_id).
    // Account and location IDs together form the Media API URL path:
    // accounts/{gbp_account_id}/locations/{gbp_location_id}/media
    await sql`
      ALTER TABLE lm_shop_numbers ADD COLUMN IF NOT EXISTS gbp_account_id TEXT
    `;
    await sql`
      ALTER TABLE lm_shop_numbers ADD COLUMN IF NOT EXISTS gbp_location_id TEXT
    `;
    await sql`
      ALTER TABLE lm_shop_numbers ADD COLUMN IF NOT EXISTS gbp_matched_at TIMESTAMPTZ
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_shop_numbers_gbp ON lm_shop_numbers(gbp_location_id)
    `;

    // Provider-keyed so the table can later hold the rich-API key too if
    // that ever moves off env. Today we only write `semrush` (the OAuth
    // device-flow tokens for the deprecated API).
    await sql`
      CREATE TABLE IF NOT EXISTS lm_oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // One row per (shop, push event) — used to surface a "shops awaiting
    // approval in Semrush's Updates queue" view. Semrush's API doesn't
    // expose its moderation queue, so we infer it from our own push log.
    // marked_done is user-flagged when they've handled the shop in Semrush.
    await sql`
      CREATE TABLE IF NOT EXISTS lm_pending_pushes (
        id BIGSERIAL PRIMARY KEY,
        semrush_location_id TEXT NOT NULL,
        location_name TEXT,
        shop_id TEXT,
        brand TEXT,
        fields TEXT,
        pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pushed_by TEXT,
        marked_done BOOLEAN NOT NULL DEFAULT FALSE,
        marked_done_at TIMESTAMPTZ
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_pending_pushes_done_time ON lm_pending_pushes (marked_done, pushed_at DESC)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_pending_pushes_location ON lm_pending_pushes (semrush_location_id)
    `;

    // Per-shop audit log of GBP Media API push attempts. One row per push;
    // state moves from PENDING → SUCCESS|FAILED as the bulk run progresses.
    // Drives the bulk-push progress UI (Phase 3) and post-hoc verification.
    await sql`
      CREATE TABLE IF NOT EXISTS lm_gbp_photo_pushes (
        id BIGSERIAL PRIMARY KEY,
        shop_id TEXT,
        brand TEXT,
        gbp_account_id TEXT NOT NULL,
        gbp_location_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        category TEXT NOT NULL,
        pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pushed_by TEXT,
        state TEXT NOT NULL DEFAULT 'PENDING',
        media_resource_name TEXT,
        error_message TEXT
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_gbp_pushes_time ON lm_gbp_photo_pushes (pushed_at DESC)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_gbp_pushes_state ON lm_gbp_photo_pushes (state)
    `;

    // Semrush image-push audit log. Each row = one shop receiving one image
    // via POST /apis/v4/local/v1/locations/:id/images. state transitions
    // PENDING → SUCCESS|FAILED. On SUCCESS we store the Semrush-returned
    // image_id + url (the storage.googleapis.com URL) so the history UI
    // can deep-link / show thumbnails.
    await sql`
      CREATE TABLE IF NOT EXISTS lm_image_pushes (
        id BIGSERIAL PRIMARY KEY,
        shop_id TEXT,
        brand TEXT,
        semrush_new_id TEXT NOT NULL,
        source_url TEXT,
        type TEXT NOT NULL DEFAULT 'PHOTO',
        description TEXT,
        pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pushed_by TEXT,
        state TEXT NOT NULL DEFAULT 'PENDING',
        semrush_image_id TEXT,
        semrush_image_url TEXT,
        error_message TEXT
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_image_pushes_time ON lm_image_pushes (pushed_at DESC)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_image_pushes_state ON lm_image_pushes (state)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_image_pushes_brand ON lm_image_pushes (brand)
    `;

    // Integration token-broker secrets. Single row per provider (currently
    // only "semrush"). Stores bcrypt hash, not plaintext — plaintext is
    // shown to the admin ONCE at generation time and never recoverable
    // afterward. `hint` is the last 4 chars of plaintext so the admin can
    // distinguish rotated secrets visually.
    await sql`
      CREATE TABLE IF NOT EXISTS lm_integration_secrets (
        provider TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        hint TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT,
        last_used_at TIMESTAMPTZ
      )
    `;

    const { rows: uc } = await sql`SELECT COUNT(*) as count FROM lm_users`;
    if (parseInt(uc[0].count) === 0) {
      for (const user of DEMO_USERS) {
        await sql`
          INSERT INTO lm_users (id, name, email, password, role, initials, brands, created_at)
          VALUES (${user.id}, ${user.name}, ${user.email}, ${user.password}, ${user.role}, ${user.initials}, ${JSON.stringify(user.brands)}, ${user.createdAt})
        `;
      }
    }

    const { rows: ac } = await sql`SELECT COUNT(*) as count FROM lm_activity`;
    if (parseInt(ac[0].count) === 0) {
      for (const entry of SEED_ACTIVITY) {
        await sql`
          INSERT INTO lm_activity (id, time, username, action, location, brand, details)
          VALUES (${entry.id}, ${entry.time}, ${entry.user}, ${entry.action}, ${entry.location}, ${entry.brand}, ${entry.details || ''})
        `;
      }
    }

    return { initialized: true };
  } catch (error) {
    console.error("Database init error:", error.message);
    return { initialized: false, reason: error.message };
  }
}

// ---------------------------------------------------------------------------
// Users CRUD
// ---------------------------------------------------------------------------

export async function getUsers() {
  if (!hasPostgres()) return getMemUsers();
  try {
    const sql = await db();
    const { rows } = await sql`
      SELECT id, name, email, role, initials, brands, created_at as "createdAt"
      FROM lm_users ORDER BY created_at ASC
    `;
    return rows.map((r) => ({ ...r, brands: typeof r.brands === "string" ? JSON.parse(r.brands) : r.brands }));
  } catch {
    return getMemUsers();
  }
}

export async function createUser(userData) {
  if (!hasPostgres()) {
    const users = getMemUsers();
    const newUser = {
      id: `usr-${Date.now()}`,
      name: userData.name,
      email: userData.email,
      role: userData.role || "editor",
      initials: userData.initials || userData.name.slice(0, 2).toUpperCase(),
      brands: userData.brands || [],
      createdAt: new Date().toISOString().split("T")[0],
    };
    memUsers.push(newUser);
    return newUser;
  }

  const sql = await db();
  const id = `usr-${Date.now()}`;
  const createdAt = new Date().toISOString().split("T")[0];
  const initials = userData.initials || userData.name.slice(0, 2).toUpperCase();

  // Admin-set passwords are always temp — the user is forced to change
  // it on their next login via the dashboard layout's redirect.
  await sql`
    INSERT INTO lm_users (id, name, email, password, role, initials, brands, created_at, password_temp)
    VALUES (${id}, ${userData.name}, ${userData.email}, ${userData.password || 'changeme'}, ${userData.role || 'editor'}, ${initials}, ${JSON.stringify(userData.brands || [])}, ${createdAt}, TRUE)
  `;

  return { id, name: userData.name, email: userData.email, role: userData.role || "editor", initials, brands: userData.brands || [], createdAt };
}

export async function updateUser(userId, userData) {
  if (!hasPostgres()) {
    const users = getMemUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) throw new Error("User not found");
    memUsers[idx] = { ...memUsers[idx], ...userData };
    return memUsers[idx];
  }

  const sql = await db();
  // password is only updated when explicitly provided (admin used the
  // "Reset Password" flow); otherwise COALESCE leaves the existing one.
  // When a password IS provided here, it's coming from an admin reset,
  // so we also mark password_temp = TRUE to force the user to change it.
  const isPasswordReset = !!userData.password;
  await sql`
    UPDATE lm_users
    SET name = COALESCE(${userData.name}, name),
        email = COALESCE(${userData.email}, email),
        role = COALESCE(${userData.role}, role),
        initials = COALESCE(${userData.initials}, initials),
        brands = COALESCE(${JSON.stringify(userData.brands)}, brands),
        password = COALESCE(${userData.password || null}, password),
        password_temp = CASE WHEN ${isPasswordReset} THEN TRUE ELSE password_temp END
    WHERE id = ${userId}
  `;

  const { rows } = await sql`SELECT id, name, email, role, initials, brands, created_at as "createdAt" FROM lm_users WHERE id = ${userId}`;
  if (rows.length === 0) throw new Error("User not found");
  const r = rows[0];
  return { ...r, brands: typeof r.brands === "string" ? JSON.parse(r.brands) : r.brands };
}

/**
 * Self-service password change. Sets the new password and clears the
 * password_temp flag so the user is no longer forced to change it.
 *
 * Pass `currentPassword` for voluntary changes — caller must verify it
 * matches before invoking this. For forced-change-on-first-login flows
 * the caller can skip the verification since the user just authenticated.
 *
 * @returns {Promise<boolean>}
 */
export async function updateOwnPassword(userId, newPassword) {
  if (!userId || !newPassword) throw new Error("userId and newPassword are required");

  if (!hasPostgres()) {
    const users = getMemUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) throw new Error("User not found");
    memUsers[idx] = { ...memUsers[idx], password: newPassword, password_temp: false };
    return true;
  }

  const sql = await db();
  const { rowCount } = await sql`
    UPDATE lm_users
    SET password = ${newPassword}, password_temp = FALSE
    WHERE id = ${userId}
  `;
  if (rowCount === 0) throw new Error("User not found");
  return true;
}

/**
 * Look up a user's plaintext password for current-password verification
 * on self-service change. Postgres-only — for memory mode we read from
 * DEMO_USERS in findUserByEmail.
 *
 * @returns {Promise<{ password: string, password_temp: boolean } | null>}
 */
export async function getUserAuthFields(userId) {
  if (!hasPostgres()) {
    const users = getMemUsers();
    const u = users.find((x) => x.id === userId);
    if (!u) return null;
    return { password: u.password || null, password_temp: !!u.password_temp };
  }
  try {
    const sql = await db();
    const { rows } = await sql`SELECT password, password_temp FROM lm_users WHERE id = ${userId}`;
    if (rows.length === 0) return null;
    return { password: rows[0].password, password_temp: !!rows[0].password_temp };
  } catch {
    return null;
  }
}

export async function deleteUser(userId) {
  if (!hasPostgres()) {
    const users = getMemUsers();
    const target = users.find((u) => u.id === userId);
    if (!target) throw new Error("User not found");
    if (target.role === "admin") throw new Error("Cannot remove admin users");
    memUsers = users.filter((u) => u.id !== userId);
    return true;
  }

  const sql = await db();
  const { rows } = await sql`SELECT role FROM lm_users WHERE id = ${userId}`;
  if (rows.length === 0) throw new Error("User not found");
  if (rows[0].role === "admin") throw new Error("Cannot remove admin users");
  await sql`DELETE FROM lm_users WHERE id = ${userId}`;
  return true;
}

export async function findUserByEmail(email) {
  if (!hasPostgres()) {
    return DEMO_USERS.find((u) => u.email === email) || null;
  }

  try {
    const sql = await db();
    const { rows } = await sql`SELECT * FROM lm_users WHERE email = ${email}`;
    if (rows.length === 0) return null;
    const r = rows[0];
    return { ...r, brands: typeof r.brands === "string" ? JSON.parse(r.brands) : r.brands, createdAt: r.created_at };
  } catch {
    return DEMO_USERS.find((u) => u.email === email) || null;
  }
}

// ---------------------------------------------------------------------------
// Activity CRUD
// ---------------------------------------------------------------------------

export async function getActivity(limit = 100) {
  if (!hasPostgres()) return getMemActivity().slice(0, limit);

  try {
    const sql = await db();
    const { rows } = await sql`
      SELECT id, time, username as "user", action, location, brand, details
      FROM lm_activity ORDER BY time DESC LIMIT ${limit}
    `;
    return rows;
  } catch {
    return getMemActivity().slice(0, limit);
  }
}

export async function logActivity({ user, action, location, brand, details }) {
  const id = `act-${Date.now()}`;
  const time = new Date().toISOString();

  if (!hasPostgres()) {
    const activity = getMemActivity();
    activity.unshift({ id, time, user, action, location, brand, details });
    if (activity.length > 200) memActivity = activity.slice(0, 200);
    return { id, time, user, action, location, brand, details };
  }

  try {
    const sql = await db();
    await sql`
      INSERT INTO lm_activity (id, time, username, action, location, brand, details)
      VALUES (${id}, ${time}, ${user}, ${action}, ${location || ''}, ${brand || 'unknown'}, ${details || ''})
    `;
    return { id, time, user, action, location, brand, details };
  } catch (error) {
    console.error("Activity log error:", error.message);
    const activity = getMemActivity();
    activity.unshift({ id, time, user, action, location, brand, details });
    return { id, time, user, action, location, brand, details };
  }
}

export async function clearActivity() {
  if (!hasPostgres()) {
    memActivity = [];
    return true;
  }

  try {
    const sql = await db();
    await sql`DELETE FROM lm_activity`;
    return true;
  } catch (error) {
    console.error("Clear activity error:", error.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shop Numbers CRUD
// ---------------------------------------------------------------------------

let memShopNumbers = [];

export async function getShopNumbers() {
  if (!hasPostgres()) return memShopNumbers;

  try {
    const sql = await db();
    const { rows } = await sql`SELECT * FROM lm_shop_numbers ORDER BY brand, shop_id`;
    return rows;
  } catch {
    return memShopNumbers;
  }
}

export async function getShopNumberMap() {
  const shops = await getShopNumbers();
  const bySemrushId = new Map();
  const byShopId = new Map();
  const byNewSemrushId = new Map();
  for (const shop of shops) {
    if (shop.semrush_location_id) {
      bySemrushId.set(shop.semrush_location_id, shop);
    }
    if (shop.semrush_new_id) {
      byNewSemrushId.set(shop.semrush_new_id, shop);
    }
    byShopId.set(shop.shop_id, shop);
  }
  return { bySemrushId, byShopId, byNewSemrushId, all: shops };
}

/**
 * Look up a new-API location_id given an old-API semrush_location_id.
 * Returns null if no mapping exists. Used by routes that bridge between
 * the deprecated and rich APIs (e.g. EditModal opening a location loaded
 * via the old API needs the new ID to fetch its rich fields).
 */
export async function getNewIdForOldId(oldId) {
  if (!oldId) return null;
  const { bySemrushId } = await getShopNumberMap();
  const shop = bySemrushId.get(oldId);
  return shop?.semrush_new_id || null;
}

/**
 * Apply a batch of old-ID → new-ID mappings produced by the rich-mappings
 * sync. Each match updates the shop row keyed by semrush_location_id.
 *
 * Rows without a matching semrush_location_id are silently skipped — they
 * indicate locations that exist on the old API but haven't been imported
 * into lm_shop_numbers yet (shop CSV not yet uploaded for them).
 *
 * Caller-visible errors: returns up to the first 3 error messages so a
 * silent schema mismatch (e.g. missing column) doesn't disappear into the
 * "missing" count.
 *
 * @param {Array<{ oldId: string, newId: string }>} matches
 * @returns {Promise<{ updated: number, missing: number, errors: string[] }>}
 */
export async function bulkSetNewIds(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return { updated: 0, missing: 0, errors: [] };
  }

  if (!hasPostgres()) {
    let updated = 0;
    let missing = 0;
    const now = new Date().toISOString();
    for (const { oldId, newId } of matches) {
      const shop = memShopNumbers.find((s) => s.semrush_location_id === oldId);
      if (shop) {
        shop.semrush_new_id = newId;
        shop.rich_matched_at = now;
        updated++;
      } else {
        missing++;
      }
    }
    return { updated, missing, errors: [] };
  }

  const sql = await db();
  let updated = 0;
  let missing = 0;
  const errors = [];

  for (const { oldId, newId } of matches) {
    try {
      const { rowCount } = await sql`
        UPDATE lm_shop_numbers
        SET semrush_new_id = ${newId}, rich_matched_at = NOW()
        WHERE semrush_location_id = ${oldId}
      `;
      if (rowCount > 0) updated++;
      else missing++;
    } catch (error) {
      console.error(`bulkSetNewIds error for old=${oldId}:`, error.message);
      missing++;
      if (errors.length < 3) errors.push(`old=${oldId}: ${error.message}`);
    }
  }

  return { updated, missing, errors };
}

/**
 * Post-migration variant: set semrush_new_id keyed by shop_id (Driven Brands
 * shop number), for shops that never had a semrush_location_id — such rows
 * can't be reached via bulkSetNewIds. Returns true if a row was updated.
 */
export async function setNewIdByShopId(shopId, newId) {
  if (!shopId || !newId) return false;

  if (!hasPostgres()) {
    const shop = memShopNumbers.find((s) => s.shop_id === shopId);
    if (shop) {
      shop.semrush_new_id = newId;
      shop.rich_matched_at = new Date().toISOString();
      return true;
    }
    return false;
  }

  const sql = await db();
  const { rowCount } = await sql`
    UPDATE lm_shop_numbers
    SET semrush_new_id = ${newId}, rich_matched_at = NOW()
    WHERE shop_id = ${shopId}
  `;
  return rowCount > 0;
}

export async function importShopNumbers(records) {
  if (!hasPostgres()) {
    memShopNumbers = records.map((r) => ({ ...r, created_at: new Date().toISOString() }));
    return { imported: records.length, errors: 0 };
  }

  const sql = await db();
  let imported = 0;
  let errors = 0;

  for (const r of records) {
    try {
      await sql`
        INSERT INTO lm_shop_numbers (shop_id, brand, street_address, address2, city, country, state, zip, phone, website)
        VALUES (${r.shop_id}, ${r.brand}, ${r.street_address || ''}, ${r.address2 || ''}, ${r.city || ''}, ${r.country || ''}, ${r.state || ''}, ${r.zip || ''}, ${r.phone || ''}, ${r.website || ''})
        ON CONFLICT (shop_id) DO UPDATE SET
          brand = EXCLUDED.brand,
          street_address = EXCLUDED.street_address,
          address2 = EXCLUDED.address2,
          city = EXCLUDED.city,
          country = EXCLUDED.country,
          state = EXCLUDED.state,
          zip = EXCLUDED.zip,
          phone = EXCLUDED.phone,
          website = EXCLUDED.website
      `;
      imported++;
    } catch (error) {
      console.error(`Shop import error for ${r.shop_id}:`, error.message);
      errors++;
    }
  }

  return { imported, errors };
}

export async function matchShopToLocation(shopId, semrushLocationId) {
  if (!hasPostgres()) {
    const shop = memShopNumbers.find((s) => s.shop_id === shopId);
    if (shop) shop.semrush_location_id = semrushLocationId;
    return true;
  }

  try {
    const sql = await db();
    await sql`
      UPDATE lm_shop_numbers
      SET semrush_location_id = ${semrushLocationId}, matched_at = NOW()
      WHERE shop_id = ${shopId}
    `;
    return true;
  } catch (error) {
    console.error("Match shop error:", error.message);
    return false;
  }
}

/**
 * Assign a shop number to a Semrush location in one step — backs the
 * "locations missing a shop number" admin view.
 *
 * If a shop-number row already exists for `shopId`, only the location
 * link is updated; existing address/brand/etc. are left intact (trust
 * the prior canonical import). If no row exists, a new one is created
 * seeded from the Semrush location's own fields.
 */
export async function assignShopNumber({ shopId, semrushLocationId, brand, streetAddress, city, state, zip, phone, website }) {
  if (!shopId || !semrushLocationId) {
    throw new Error("shopId and semrushLocationId are required");
  }

  if (!hasPostgres()) {
    const existing = memShopNumbers.find((s) => s.shop_id === shopId);
    if (existing) {
      existing.semrush_location_id = semrushLocationId;
      existing.matched_at = new Date().toISOString();
    } else {
      memShopNumbers.push({
        shop_id: shopId,
        brand: brand || "",
        street_address: streetAddress || "",
        city: city || "",
        state: state || "",
        zip: zip || "",
        phone: phone || "",
        website: website || "",
        semrush_location_id: semrushLocationId,
        matched_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    }
    return true;
  }

  const sql = await db();
  await sql`
    INSERT INTO lm_shop_numbers
      (shop_id, brand, street_address, city, state, zip, phone, website, semrush_location_id, matched_at)
    VALUES
      (${shopId}, ${brand || ''}, ${streetAddress || ''}, ${city || ''}, ${state || ''}, ${zip || ''}, ${phone || ''}, ${website || ''}, ${semrushLocationId}, NOW())
    ON CONFLICT (shop_id) DO UPDATE SET
      semrush_location_id = EXCLUDED.semrush_location_id,
      matched_at = NOW()
  `;
  return true;
}

export async function bulkMatchShops(matches) {
  // matches = [{ shopId, semrushLocationId }]
  if (!hasPostgres()) {
    for (const m of matches) {
      const shop = memShopNumbers.find((s) => s.shop_id === m.shopId);
      if (shop) shop.semrush_location_id = m.semrushLocationId;
    }
    return { matched: matches.length };
  }

  const sql = await db();
  let matched = 0;
  for (const m of matches) {
    try {
      await sql`
        UPDATE lm_shop_numbers
        SET semrush_location_id = ${m.semrushLocationId}, matched_at = NOW()
        WHERE shop_id = ${m.shopId}
      `;
      matched++;
    } catch {}
  }
  return { matched };
}

export async function updateShopNumber(shopId, updates) {
  if (!hasPostgres()) {
    const idx = memShopNumbers.findIndex((s) => s.shop_id === shopId);
    if (idx !== -1) memShopNumbers[idx] = { ...memShopNumbers[idx], ...updates };
    return true;
  }

  try {
    const sql = await db();
    await sql`
      UPDATE lm_shop_numbers
      SET semrush_location_id = COALESCE(${updates.semrush_location_id || null}, semrush_location_id)
      WHERE shop_id = ${shopId}
    `;
    return true;
  } catch {
    return false;
  }
}

export async function clearShopNumbers() {
  if (!hasPostgres()) {
    memShopNumbers = [];
    return true;
  }

  try {
    const sql = await db();
    await sql`DELETE FROM lm_shop_numbers`;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OAuth token persistence
// ---------------------------------------------------------------------------
//
// Cold starts and serverless instance churn would otherwise lose any token
// pair obtained via refresh, falling back to the env-var bootstrap — which is
// dead the moment Semrush rotates the refresh token. Persisting here makes
// refresh actually stick across worker lifecycles.
//
// No in-memory fallback: when Postgres isn't configured, callers (lib/semrush)
// just keep using their module-scope cache as before, which is the pre-fix
// behavior. Without a DB there's nowhere to persist anyway.

export async function loadOauthTokens(provider = "semrush") {
  if (!hasPostgres()) return null;
  try {
    const sql = await db();
    const { rows } = await sql`
      SELECT access_token, refresh_token, expires_at
      FROM lm_oauth_tokens WHERE provider = ${provider}
    `;
    if (rows.length === 0) return null;
    return {
      accessToken: rows[0].access_token,
      refreshToken: rows[0].refresh_token || null,
      expiresAt: rows[0].expires_at ? new Date(rows[0].expires_at).toISOString() : null,
    };
  } catch (error) {
    console.error("loadOauthTokens error:", error.message);
    return null;
  }
}

export async function saveOauthTokens({ accessToken, refreshToken, expiresAt }, provider = "semrush") {
  if (!hasPostgres()) return false;
  if (!accessToken) return false;
  try {
    const sql = await db();
    await sql`
      INSERT INTO lm_oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
      VALUES (${provider}, ${accessToken}, ${refreshToken || null}, ${expiresAt || null}, NOW())
      ON CONFLICT (provider) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `;
    return true;
  } catch (error) {
    console.error("saveOauthTokens error:", error.message);
    return false;
  }
}

export async function clearOauthTokens(provider = "semrush") {
  if (!hasPostgres()) return false;
  try {
    const sql = await db();
    await sql`DELETE FROM lm_oauth_tokens WHERE provider = ${provider}`;
    return true;
  } catch (error) {
    console.error("clearOauthTokens error:", error.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pending pushes — Semrush "Updates" queue mirror
// ---------------------------------------------------------------------------
//
// Semrush's API doesn't expose its moderation queue (the per-shop Updates
// tab showing New/Processing/Failed/Accepted/Rejected pushes), so we keep
// our own log of every successful push and let the user mark each shop as
// handled once they've approved it in Semrush's UI.
//
// In-memory fallback uses a module-scope array so the dashboard still
// works without Postgres in demo mode.

let memPendingPushes = [];
let _memPendingId = 1;

/**
 * Record a batch of pushes — one row per shop. Called after every
 * successful Semrush write (single PUT, bulk PUT, holiday-push).
 *
 * @param {Array<{ semrushLocationId, locationName?, shopId?, brand?, fields?, pushedBy? }>} rows
 */
export async function recordPendingPushes(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  if (!hasPostgres()) {
    const now = new Date().toISOString();
    for (const r of rows) {
      if (!r.semrushLocationId) continue;
      memPendingPushes.unshift({
        id: _memPendingId++,
        semrush_location_id: r.semrushLocationId,
        location_name: r.locationName || "",
        shop_id: r.shopId || "",
        brand: r.brand || "",
        fields: r.fields || "",
        pushed_at: now,
        pushed_by: r.pushedBy || "",
        marked_done: false,
        marked_done_at: null,
      });
    }
    if (memPendingPushes.length > 5000) memPendingPushes = memPendingPushes.slice(0, 5000);
    return rows.length;
  }

  try {
    const sql = await db();
    let inserted = 0;
    for (const r of rows) {
      if (!r.semrushLocationId) continue;
      await sql`
        INSERT INTO lm_pending_pushes (semrush_location_id, location_name, shop_id, brand, fields, pushed_by)
        VALUES (${r.semrushLocationId}, ${r.locationName || ''}, ${r.shopId || ''}, ${r.brand || ''}, ${r.fields || ''}, ${r.pushedBy || ''})
      `;
      inserted++;
    }
    return inserted;
  } catch (error) {
    console.error("recordPendingPushes error:", error.message);
    return 0;
  }
}

/**
 * List recent pushes, joined to lm_shop_numbers so the caller can build the
 * Semrush deep-link from semrush_new_id. Default: open (not-yet-marked-done)
 * pushes only, newest first.
 *
 * @param {{ markedDone?: boolean, brand?: string, limit?: number }} opts
 */
export async function getPendingPushes({ markedDone = false, brand = null, limit = 1000 } = {}) {
  if (!hasPostgres()) {
    let list = memPendingPushes.filter((p) => p.marked_done === markedDone);
    if (brand) list = list.filter((p) => p.brand === brand);
    return list.slice(0, limit).map((p) => ({ ...p, semrush_new_id: null }));
  }

  try {
    const sql = await db();
    if (brand) {
      const { rows } = await sql`
        SELECT p.*, s.semrush_new_id
        FROM lm_pending_pushes p
        LEFT JOIN lm_shop_numbers s ON s.semrush_location_id = p.semrush_location_id
        WHERE p.marked_done = ${markedDone} AND p.brand = ${brand}
        ORDER BY p.pushed_at DESC
        LIMIT ${limit}
      `;
      return rows;
    }
    const { rows } = await sql`
      SELECT p.*, s.semrush_new_id
      FROM lm_pending_pushes p
      LEFT JOIN lm_shop_numbers s ON s.semrush_location_id = p.semrush_location_id
      WHERE p.marked_done = ${markedDone}
      ORDER BY p.pushed_at DESC
      LIMIT ${limit}
    `;
    return rows;
  } catch (error) {
    console.error("getPendingPushes error:", error.message);
    return [];
  }
}

/**
 * Mark every open push for a given location as done. Used when the user
 * clicks the per-shop "Mark Done" button after handling Semrush's UI.
 *
 * @returns count of rows affected
 */
export async function markPushesDoneByLocation(semrushLocationId) {
  if (!semrushLocationId) return 0;

  if (!hasPostgres()) {
    let count = 0;
    const now = new Date().toISOString();
    for (const p of memPendingPushes) {
      if (p.semrush_location_id === semrushLocationId && !p.marked_done) {
        p.marked_done = true;
        p.marked_done_at = now;
        count++;
      }
    }
    return count;
  }

  try {
    const sql = await db();
    const { rowCount } = await sql`
      UPDATE lm_pending_pushes
      SET marked_done = TRUE, marked_done_at = NOW()
      WHERE semrush_location_id = ${semrushLocationId} AND marked_done = FALSE
    `;
    return rowCount || 0;
  } catch (error) {
    console.error("markPushesDoneByLocation error:", error.message);
    return 0;
  }
}

/**
 * Mark ALL currently-open pushes as done — for the "Mark all done" bulk
 * action when the user has worked through the entire queue in Semrush.
 */
export async function markAllPushesDone({ brand = null } = {}) {
  if (!hasPostgres()) {
    let count = 0;
    const now = new Date().toISOString();
    for (const p of memPendingPushes) {
      if (p.marked_done) continue;
      if (brand && p.brand !== brand) continue;
      p.marked_done = true;
      p.marked_done_at = now;
      count++;
    }
    return count;
  }

  try {
    const sql = await db();
    if (brand) {
      const { rowCount } = await sql`
        UPDATE lm_pending_pushes
        SET marked_done = TRUE, marked_done_at = NOW()
        WHERE marked_done = FALSE AND brand = ${brand}
      `;
      return rowCount || 0;
    }
    const { rowCount } = await sql`
      UPDATE lm_pending_pushes
      SET marked_done = TRUE, marked_done_at = NOW()
      WHERE marked_done = FALSE
    `;
    return rowCount || 0;
  } catch (error) {
    console.error("markAllPushesDone error:", error.message);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// GBP integration scaffolding (Phase 0)
// ---------------------------------------------------------------------------
//
// These helpers are placeholders that the Phase 2 mapping sync and Phase 3
// bulk-photo-push will use. They're safe to ship before the OAuth wiring
// exists — callers that don't pass valid GBP IDs simply do nothing.

/**
 * Look up the GBP account/location IDs for a Driven Brands shop, keyed by
 * old-API semrush_location_id (the ID we have on hand in EditModal and
 * elsewhere). Returns null if the shop hasn't been mapped to GBP yet.
 */
export async function getGbpIdsForOldId(oldSemrushLocationId) {
  if (!oldSemrushLocationId) return null;

  if (!hasPostgres()) {
    const shop = memShopNumbers.find((s) => s.semrush_location_id === oldSemrushLocationId);
    if (!shop || !shop.gbp_location_id) return null;
    return { gbpAccountId: shop.gbp_account_id || null, gbpLocationId: shop.gbp_location_id };
  }

  try {
    const sql = await db();
    const { rows } = await sql`
      SELECT gbp_account_id, gbp_location_id
      FROM lm_shop_numbers
      WHERE semrush_location_id = ${oldSemrushLocationId}
    `;
    if (rows.length === 0 || !rows[0].gbp_location_id) return null;
    return { gbpAccountId: rows[0].gbp_account_id || null, gbpLocationId: rows[0].gbp_location_id };
  } catch (error) {
    console.error("getGbpIdsForOldId error:", error.message);
    return null;
  }
}

/**
 * Apply a batch of GBP mappings produced by the Phase 2 sync job. Each
 * match updates the shop row keyed by semrush_location_id (old-API ID).
 * Mirrors bulkSetNewIds for the rich-API mapping.
 *
 * @param {Array<{ oldId, gbpAccountId, gbpLocationId }>} matches
 */
export async function bulkSetGbpIds(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return { updated: 0, missing: 0, errors: [] };
  }

  if (!hasPostgres()) {
    let updated = 0;
    let missing = 0;
    const now = new Date().toISOString();
    for (const { oldId, gbpAccountId, gbpLocationId } of matches) {
      const shop = memShopNumbers.find((s) => s.semrush_location_id === oldId);
      if (shop) {
        shop.gbp_account_id = gbpAccountId;
        shop.gbp_location_id = gbpLocationId;
        shop.gbp_matched_at = now;
        updated++;
      } else {
        missing++;
      }
    }
    return { updated, missing, errors: [] };
  }

  const sql = await db();
  let updated = 0;
  let missing = 0;
  const errors = [];

  for (const { oldId, gbpAccountId, gbpLocationId } of matches) {
    try {
      const { rowCount } = await sql`
        UPDATE lm_shop_numbers
        SET gbp_account_id = ${gbpAccountId},
            gbp_location_id = ${gbpLocationId},
            gbp_matched_at = NOW()
        WHERE semrush_location_id = ${oldId}
      `;
      if (rowCount > 0) updated++;
      else missing++;
    } catch (error) {
      console.error(`bulkSetGbpIds error for old=${oldId}:`, error.message);
      missing++;
      if (errors.length < 3) errors.push(`old=${oldId}: ${error.message}`);
    }
  }

  return { updated, missing, errors };
}

/**
 * Record a single GBP photo-push attempt in the audit log. Called by the
 * Phase 3 bulk-push route per location. Returns the inserted row's id so
 * the route can update state from PENDING → SUCCESS|FAILED as the upload
 * resolves.
 */
let memGbpPushes = [];
let _memGbpPushId = 1;

export async function recordGbpPhotoPush({ shopId, brand, gbpAccountId, gbpLocationId, sourceUrl, category, pushedBy }) {
  if (!gbpLocationId || !sourceUrl || !category) {
    throw new Error("gbpLocationId, sourceUrl, and category are required");
  }

  if (!hasPostgres()) {
    const row = {
      id: _memGbpPushId++,
      shop_id: shopId || "",
      brand: brand || "",
      gbp_account_id: gbpAccountId || "",
      gbp_location_id: gbpLocationId,
      source_url: sourceUrl,
      category,
      pushed_at: new Date().toISOString(),
      pushed_by: pushedBy || "",
      state: "PENDING",
      media_resource_name: null,
      error_message: null,
    };
    memGbpPushes.unshift(row);
    return row.id;
  }

  try {
    const sql = await db();
    const { rows } = await sql`
      INSERT INTO lm_gbp_photo_pushes
        (shop_id, brand, gbp_account_id, gbp_location_id, source_url, category, pushed_by, state)
      VALUES
        (${shopId || ''}, ${brand || ''}, ${gbpAccountId || ''}, ${gbpLocationId}, ${sourceUrl}, ${category}, ${pushedBy || ''}, 'PENDING')
      RETURNING id
    `;
    return rows[0]?.id || null;
  } catch (error) {
    console.error("recordGbpPhotoPush error:", error.message);
    return null;
  }
}

/**
 * Mark a previously-recorded push as resolved — SUCCESS with the Google
 * media resource name, or FAILED with an error message.
 */
export async function resolveGbpPhotoPush(id, { success, mediaResourceName = null, errorMessage = null }) {
  if (!id) return false;
  const state = success ? "SUCCESS" : "FAILED";

  if (!hasPostgres()) {
    const row = memGbpPushes.find((p) => p.id === id);
    if (!row) return false;
    row.state = state;
    row.media_resource_name = mediaResourceName;
    row.error_message = errorMessage;
    return true;
  }

  try {
    const sql = await db();
    await sql`
      UPDATE lm_gbp_photo_pushes
      SET state = ${state},
          media_resource_name = ${mediaResourceName},
          error_message = ${errorMessage}
      WHERE id = ${id}
    `;
    return true;
  } catch (error) {
    console.error("resolveGbpPhotoPush error:", error.message);
    return false;
  }
}

/**
 * List recent GBP photo pushes for the bulk-push progress UI / audit view.
 * Returns rows ordered most-recent first.
 */
export async function getGbpPhotoPushes({ state = null, brand = null, limit = 500 } = {}) {
  if (!hasPostgres()) {
    let list = memGbpPushes;
    if (state) list = list.filter((p) => p.state === state);
    if (brand) list = list.filter((p) => p.brand === brand);
    return list.slice(0, limit);
  }

  try {
    const sql = await db();
    if (state && brand) {
      const { rows } = await sql`
        SELECT * FROM lm_gbp_photo_pushes
        WHERE state = ${state} AND brand = ${brand}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    if (state) {
      const { rows } = await sql`
        SELECT * FROM lm_gbp_photo_pushes
        WHERE state = ${state}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    if (brand) {
      const { rows } = await sql`
        SELECT * FROM lm_gbp_photo_pushes
        WHERE brand = ${brand}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    const { rows } = await sql`
      SELECT * FROM lm_gbp_photo_pushes
      ORDER BY pushed_at DESC LIMIT ${limit}
    `;
    return rows;
  } catch (error) {
    console.error("getGbpPhotoPushes error:", error.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Semrush image-push audit (POST /locations/:id/images via the rich API)
// ---------------------------------------------------------------------------

let memImagePushes = [];
let _memImagePushId = 1;

export async function recordImagePush({ shopId, brand, semrushNewId, sourceUrl, type = "PHOTO", description, pushedBy }) {
  if (!semrushNewId) throw new Error("semrushNewId is required");

  if (!hasPostgres()) {
    const row = {
      id: _memImagePushId++,
      shop_id: shopId || "",
      brand: brand || "",
      semrush_new_id: semrushNewId,
      source_url: sourceUrl || "",
      type,
      description: description || "",
      pushed_at: new Date().toISOString(),
      pushed_by: pushedBy || "",
      state: "PENDING",
      semrush_image_id: null,
      semrush_image_url: null,
      error_message: null,
    };
    memImagePushes.unshift(row);
    return row.id;
  }

  try {
    const sql = await db();
    const { rows } = await sql`
      INSERT INTO lm_image_pushes
        (shop_id, brand, semrush_new_id, source_url, type, description, pushed_by, state)
      VALUES
        (${shopId || ''}, ${brand || ''}, ${semrushNewId}, ${sourceUrl || ''}, ${type}, ${description || ''}, ${pushedBy || ''}, 'PENDING')
      RETURNING id
    `;
    return rows[0]?.id || null;
  } catch (error) {
    console.error("recordImagePush error:", error.message);
    return null;
  }
}

export async function resolveImagePush(id, { success, semrushImageId = null, semrushImageUrl = null, errorMessage = null }) {
  if (!id) return false;
  const state = success ? "SUCCESS" : "FAILED";

  if (!hasPostgres()) {
    const row = memImagePushes.find((p) => p.id === id);
    if (!row) return false;
    row.state = state;
    row.semrush_image_id = semrushImageId;
    row.semrush_image_url = semrushImageUrl;
    row.error_message = errorMessage;
    return true;
  }

  try {
    const sql = await db();
    await sql`
      UPDATE lm_image_pushes
      SET state = ${state},
          semrush_image_id = ${semrushImageId},
          semrush_image_url = ${semrushImageUrl},
          error_message = ${errorMessage}
      WHERE id = ${id}
    `;
    return true;
  } catch (error) {
    console.error("resolveImagePush error:", error.message);
    return false;
  }
}

export async function getImagePushes({ state = null, brand = null, sourceUrl = null, limit = 100 } = {}) {
  if (!hasPostgres()) {
    let list = memImagePushes;
    if (state) list = list.filter((p) => p.state === state);
    if (brand) list = list.filter((p) => p.brand === brand);
    if (sourceUrl) list = list.filter((p) => p.source_url === sourceUrl);
    return list.slice(0, limit);
  }

  try {
    const sql = await db();
    // Build dynamic WHERE — @vercel/postgres tagged-template doesn't allow
    // conditional clauses, so we branch on the present filters. Order is:
    // (state, brand, sourceUrl) → 8 combinations.
    if (state && brand && sourceUrl) {
      const { rows } = await sql`
        SELECT * FROM lm_image_pushes
        WHERE state = ${state} AND brand = ${brand} AND source_url = ${sourceUrl}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    if (state && brand) {
      const { rows } = await sql`
        SELECT * FROM lm_image_pushes WHERE state = ${state} AND brand = ${brand}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    if (state && sourceUrl) {
      const { rows } = await sql`
        SELECT * FROM lm_image_pushes WHERE state = ${state} AND source_url = ${sourceUrl}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    if (brand && sourceUrl) {
      const { rows } = await sql`
        SELECT * FROM lm_image_pushes WHERE brand = ${brand} AND source_url = ${sourceUrl}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    if (state) {
      const { rows } = await sql`
        SELECT * FROM lm_image_pushes WHERE state = ${state}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    if (brand) {
      const { rows } = await sql`
        SELECT * FROM lm_image_pushes WHERE brand = ${brand}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    if (sourceUrl) {
      const { rows } = await sql`
        SELECT * FROM lm_image_pushes WHERE source_url = ${sourceUrl}
        ORDER BY pushed_at DESC LIMIT ${limit}
      `;
      return rows;
    }
    const { rows } = await sql`
      SELECT * FROM lm_image_pushes ORDER BY pushed_at DESC LIMIT ${limit}
    `;
    return rows;
  } catch (error) {
    console.error("getImagePushes error:", error.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Integration token-broker secrets
// ---------------------------------------------------------------------------
//
// Hashed bearer secrets for external apps that need to call the broker
// endpoint and get the current Semrush access token. Plaintext is shown
// once at creation, then only the bcrypt hash is stored. Verification
// uses bcrypt.compare (constant-time-ish) so a leaked DB doesn't expose
// usable credentials.

let memIntegrationSecrets = []; // demo/in-memory fallback

export async function setIntegrationSecret(provider, plaintext, createdBy = "") {
  if (!provider || !plaintext) throw new Error("provider and plaintext are required");
  if (typeof plaintext !== "string" || plaintext.length < 16) {
    throw new Error("plaintext secret must be at least 16 characters");
  }

  const bcrypt = await import("bcryptjs");
  const hash = await bcrypt.hash(plaintext, 10);
  const hint = plaintext.slice(-4); // last 4 chars for visual disambiguation

  if (!hasPostgres()) {
    const idx = memIntegrationSecrets.findIndex((s) => s.provider === provider);
    const row = {
      provider, secret_hash: hash, hint,
      created_at: new Date().toISOString(),
      created_by: createdBy,
      last_used_at: null,
    };
    if (idx >= 0) memIntegrationSecrets[idx] = row;
    else memIntegrationSecrets.push(row);
    return true;
  }

  try {
    const sql = await db();
    await sql`
      INSERT INTO lm_integration_secrets (provider, secret_hash, hint, created_by, last_used_at)
      VALUES (${provider}, ${hash}, ${hint}, ${createdBy}, NULL)
      ON CONFLICT (provider) DO UPDATE SET
        secret_hash = EXCLUDED.secret_hash,
        hint = EXCLUDED.hint,
        created_at = NOW(),
        created_by = EXCLUDED.created_by,
        last_used_at = NULL
    `;
    return true;
  } catch (error) {
    console.error("setIntegrationSecret error:", error.message);
    return false;
  }
}

/**
 * Verify a presented plaintext against the stored hash. On match, updates
 * last_used_at (fire-and-forget) and returns true. On mismatch or absence,
 * returns false. Constant-time-ish via bcrypt.compare.
 */
export async function verifyIntegrationSecret(provider, plaintext) {
  if (!provider || !plaintext) return false;

  const bcrypt = await import("bcryptjs");

  if (!hasPostgres()) {
    const row = memIntegrationSecrets.find((s) => s.provider === provider);
    if (!row) return false;
    const ok = await bcrypt.compare(plaintext, row.secret_hash);
    if (ok) row.last_used_at = new Date().toISOString();
    return ok;
  }

  try {
    const sql = await db();
    const { rows } = await sql`
      SELECT secret_hash FROM lm_integration_secrets WHERE provider = ${provider}
    `;
    if (rows.length === 0) return false;
    const ok = await bcrypt.compare(plaintext, rows[0].secret_hash);
    if (ok) {
      // Don't block the request on this — fire-and-forget.
      sql`UPDATE lm_integration_secrets SET last_used_at = NOW() WHERE provider = ${provider}`
        .catch((e) => console.error("integration secret last_used update failed:", e.message));
    }
    return ok;
  } catch (error) {
    console.error("verifyIntegrationSecret error:", error.message);
    return false;
  }
}

export async function getIntegrationSecretMeta(provider) {
  if (!hasPostgres()) {
    const row = memIntegrationSecrets.find((s) => s.provider === provider);
    if (!row) return { provider, configured: false };
    return {
      provider,
      configured: true,
      hint: row.hint,
      createdAt: row.created_at,
      createdBy: row.created_by,
      lastUsedAt: row.last_used_at,
    };
  }

  try {
    const sql = await db();
    const { rows } = await sql`
      SELECT hint, created_at, created_by, last_used_at
      FROM lm_integration_secrets WHERE provider = ${provider}
    `;
    if (rows.length === 0) return { provider, configured: false };
    return {
      provider,
      configured: true,
      hint: rows[0].hint,
      createdAt: rows[0].created_at ? new Date(rows[0].created_at).toISOString() : null,
      createdBy: rows[0].created_by,
      lastUsedAt: rows[0].last_used_at ? new Date(rows[0].last_used_at).toISOString() : null,
    };
  } catch (error) {
    console.error("getIntegrationSecretMeta error:", error.message);
    return { provider, configured: false, error: error.message };
  }
}

export async function clearIntegrationSecret(provider) {
  if (!hasPostgres()) {
    memIntegrationSecrets = memIntegrationSecrets.filter((s) => s.provider !== provider);
    return true;
  }
  try {
    const sql = await db();
    await sql`DELETE FROM lm_integration_secrets WHERE provider = ${provider}`;
    return true;
  } catch (error) {
    console.error("clearIntegrationSecret error:", error.message);
    return false;
  }
}

/**
 * Inspect stored token presence without exposing the secret values. Used by
 * the admin recovery endpoint so an operator can see whether the DB has
 * tokens stored and when they were last refreshed.
 */
export async function getOauthTokenMeta(provider = "semrush") {
  if (!hasPostgres()) return { provider, hasAccess: false, hasRefresh: false, expiresAt: null, updatedAt: null, source: "memory" };
  try {
    const sql = await db();
    const { rows } = await sql`
      SELECT access_token, refresh_token, expires_at, updated_at
      FROM lm_oauth_tokens WHERE provider = ${provider}
    `;
    if (rows.length === 0) {
      return { provider, hasAccess: false, hasRefresh: false, expiresAt: null, updatedAt: null, source: "postgres" };
    }
    return {
      provider,
      hasAccess: !!rows[0].access_token,
      hasRefresh: !!rows[0].refresh_token,
      expiresAt: rows[0].expires_at ? new Date(rows[0].expires_at).toISOString() : null,
      updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null,
      source: "postgres",
    };
  } catch (error) {
    console.error("getOauthTokenMeta error:", error.message);
    return { provider, hasAccess: false, hasRefresh: false, expiresAt: null, updatedAt: null, source: "error", error: error.message };
  }
}
