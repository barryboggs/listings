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

    await sql`
      CREATE INDEX IF NOT EXISTS idx_shop_numbers_semrush_id ON lm_shop_numbers(semrush_location_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_shop_numbers_brand ON lm_shop_numbers(brand)
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

  await sql`
    INSERT INTO lm_users (id, name, email, password, role, initials, brands, created_at)
    VALUES (${id}, ${userData.name}, ${userData.email}, ${userData.password || 'changeme'}, ${userData.role || 'editor'}, ${initials}, ${JSON.stringify(userData.brands || [])}, ${createdAt})
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
  await sql`
    UPDATE lm_users
    SET name = COALESCE(${userData.name}, name),
        email = COALESCE(${userData.email}, email),
        role = COALESCE(${userData.role}, role),
        initials = COALESCE(${userData.initials}, initials),
        brands = COALESCE(${JSON.stringify(userData.brands)}, brands)
    WHERE id = ${userId}
  `;

  const { rows } = await sql`SELECT id, name, email, role, initials, brands, created_at as "createdAt" FROM lm_users WHERE id = ${userId}`;
  if (rows.length === 0) throw new Error("User not found");
  const r = rows[0];
  return { ...r, brands: typeof r.brands === "string" ? JSON.parse(r.brands) : r.brands };
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
  for (const shop of shops) {
    if (shop.semrush_location_id) {
      bySemrushId.set(shop.semrush_location_id, shop);
    }
    byShopId.set(shop.shop_id, shop);
  }
  return { bySemrushId, byShopId, all: shops };
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
