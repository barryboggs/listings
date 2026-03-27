import { sql } from "@vercel/postgres";
import { DEMO_USERS } from "@/lib/auth";
import { ACTIVITY_LOG as SEED_ACTIVITY } from "@/lib/data";

/**
 * Database layer for Vercel Postgres.
 *
 * Tables:
 *   - lm_users: team members with roles and brand access
 *   - lm_activity: audit log of all API actions
 *
 * Falls back to in-memory storage if POSTGRES_URL is not set,
 * so the app works locally without a database.
 */

// ---------------------------------------------------------------------------
// In-memory fallback (used when no Postgres connection)
// ---------------------------------------------------------------------------

let memUsers = null;
let memActivity = null;

function getMemUsers() {
  if (!memUsers) {
    memUsers = DEMO_USERS.map(({ password, ...u }) => ({ ...u }));
  }
  return memUsers;
}

function getMemActivity() {
  if (!memActivity) {
    memActivity = [...SEED_ACTIVITY];
  }
  return memActivity;
}

function hasPostgres() {
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
    return { initialized: false, reason: "No POSTGRES_URL configured" };
  }

  try {
    // Users table
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

    // Activity table
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

    // Seed demo users if table is empty
    const { rows: existingUsers } = await sql`SELECT COUNT(*) as count FROM lm_users`;
    if (parseInt(existingUsers[0].count) === 0) {
      for (const user of DEMO_USERS) {
        await sql`
          INSERT INTO lm_users (id, name, email, password, role, initials, brands, created_at)
          VALUES (${user.id}, ${user.name}, ${user.email}, ${user.password}, ${user.role}, ${user.initials}, ${JSON.stringify(user.brands)}, ${user.createdAt})
        `;
      }
    }

    // Seed activity if empty
    const { rows: existingActivity } = await sql`SELECT COUNT(*) as count FROM lm_activity`;
    if (parseInt(existingActivity[0].count) === 0) {
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
    await sql`
      INSERT INTO lm_activity (id, time, username, action, location, brand, details)
      VALUES (${id}, ${time}, ${user}, ${action}, ${location || ''}, ${brand || 'unknown'}, ${details || ''})
    `;
    return { id, time, user, action, location, brand, details };
  } catch (error) {
    console.error("Activity log error:", error.message);
    // Fallback to memory
    const activity = getMemActivity();
    activity.unshift({ id, time, user, action, location, brand, details });
    return { id, time, user, action, location, brand, details };
  }
}
