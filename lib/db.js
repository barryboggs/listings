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
