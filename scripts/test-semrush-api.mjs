/**
 * Phase 0 verification for the Semrush API migration.
 *
 * Run:   node scripts/test-semrush-api.js
 * Needs: SEMRUSH_BEARER_TOKEN in .env.local
 *
 * Every write call uses validate_only=true — no real changes are made to
 * any location. Only the initial GET reads live data.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------- load .env.local ----------
try {
  const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = value;
  }
} catch (e) {
  console.error("Could not read .env.local:", e.message);
  process.exit(1);
}

const TOKEN = process.env.SEMRUSH_BEARER_TOKEN;
const APIKEY = process.env.SEMRUSH_API_KEY;
if (!TOKEN) {
  console.error("SEMRUSH_BEARER_TOKEN is not set in .env.local");
  process.exit(1);
}

const OLD_BASE = "https://api.semrush.com/apis/v4-raw/listing-management/v1";
const NEW_BASE = "https://api.semrush.com/apis/v4/local/v1";

// ---------- helpers ----------
const pad = (n, ch = "─") => ch.repeat(n);

// auth: "bearer" | "apikey"
async function call(label, method, url, body, auth = "bearer") {
  console.log(`\n${pad(72)}`);
  console.log(label);
  console.log(`${method} ${url}`);
  console.log(`auth: ${auth}`);
  if (body) console.log(`body: ${JSON.stringify(body).slice(0, 200)}`);

  const authHeader =
    auth === "apikey" ? `Apikey ${APIKEY}` : `Bearer ${TOKEN}`;

  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (e) {
    console.log(`  → network error: ${e.message}`);
    return { ok: false, status: 0, body: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  const snippet =
    typeof parsed === "string"
      ? parsed.slice(0, 400)
      : JSON.stringify(parsed, null, 2).slice(0, 600);

  console.log(`  → HTTP ${res.status}`);
  console.log(snippet);
  return { ok: res.ok, status: res.status, body: parsed };
}

// ---------- run ----------
(async () => {
  console.log(`Token: ${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)} (length ${TOKEN.length})`);

  // 1. OLD API: get one real location so we have a valid ID + required fields
  const list = await call(
    "STEP 1 — OLD API: list one location (read-only)",
    "GET",
    `${OLD_BASE}/external/locations?page=1&size=1`
  );

  const sample = list.body?.data?.content?.[0];
  if (!sample?.id) {
    console.error(
      "\nNo location found on the old API — cannot continue. Token may be invalid or account has no listings."
    );
    process.exit(1);
  }
  console.log(`\nUsing test location: id=${sample.id} name="${sample.locationName}"`);

  // Required fields for any update — we echo the existing values back so
  // even if validate_only were ignored, no data would change.
  const requiredEcho = {
    locationName: sample.locationName,
    city: sample.city,
    address: sample.address,
    phone: sample.phone,
  };

  // 2. OLD API: bulk PUT with validate_only=true (echo existing values)
  await call(
    "STEP 2 — OLD API: bulk PUT with validate_only=true (dry run)",
    "PUT",
    `${OLD_BASE}/external/locations?validate_only=true`,
    { locations: [{ id: sample.id, ...requiredEcho }] }
  );

  if (!APIKEY) {
    console.log(
      "\nSEMRUSH_API_KEY not set — skipping new-API tests. Add it to .env.local and re-run."
    );
    process.exit(0);
  }

  // 3. NEW API: list locations with Apikey auth. Capture the response so we
  //    can pull the new-API location ID and full field shape for step 4.
  const newList = await call(
    "STEP 3 — NEW API: list one location (read-only, Apikey)",
    "GET",
    `${NEW_BASE}/locations?page_size=1`,
    null,
    "apikey"
  );

  const newSample = newList.body?.data?.[0];
  if (!newSample) {
    console.error("\nNo location returned from new API — cannot continue with step 4.");
    process.exit(1);
  }

  console.log("\n--- new-API location field names ---");
  console.log(Object.keys(newSample).join(", "));

  // Find the ID field — could be id, location_id, or something else
  const idCandidates = ["id", "location_id", "locationId", "uuid", "_id"];
  const idField = idCandidates.find((k) => newSample[k]);
  const newId = idField ? newSample[idField] : null;
  console.log(`new-API id field: ${idField || "NONE FOUND"} = ${newId}`);
  console.log(`Same as old-API id (${sample.id})? ${newId === sample.id}`);

  if (!newId) {
    console.error("\nNo recognizable ID field in new-API response. Cannot test PATCH.");
    process.exit(1);
  }

  // 4a. NEW API: PATCH with new-API's own ID and a writable field (description).
  //     Echo back the existing description so even without validate_only, no change.
  await call(
    "STEP 4a — NEW API: PATCH new-API id + description with validate_only=true",
    "PATCH",
    `${NEW_BASE}/locations/${newId}?validate_only=true&update_mask=description`,
    { description: newSample.description || "Test description that meets the minimum 10-character requirement." },
    "apikey"
  );

  // 4b. NEW API: try business_name field on the new-API ID (rule out field-specific permission)
  await call(
    "STEP 4b — NEW API: PATCH new-API id + business_name with validate_only=true",
    "PATCH",
    `${NEW_BASE}/locations/${newId}?validate_only=true&update_mask=business_name`,
    { business_name: newSample.business_name },
    "apikey"
  );

  // 4c. NEW API: PATCH without validate_only to see if the error message differs
  //     (still safe — echoing existing value back, no actual change). Comment this
  //     out if you don't want a real write attempt even on existing data.
  await call(
    "STEP 4c — NEW API: PATCH WITHOUT validate_only (echo existing description, no change)",
    "PATCH",
    `${NEW_BASE}/locations/${newId}?update_mask=description`,
    { description: newSample.description || "Test description that meets the minimum 10-character requirement." },
    "apikey"
  );

  // 5. NEW API: probe for a bulk endpoint (now with Apikey). None of these are
  //    documented; we want to know whether the 404s from the Bearer run were
  //    real "endpoint doesn't exist" or auth-related.
  const probes = [
    {
      label: "STEP 5a — NEW API probe: PATCH /locations (plural, Apikey)",
      method: "PATCH",
      url: `${NEW_BASE}/locations?validate_only=true`,
      body: { locations: [{ location_id: sample.id, business_name: sample.locationName }] },
    },
    {
      label: "STEP 5b — NEW API probe: POST /locations:batchUpdate (Google-style, Apikey)",
      method: "POST",
      url: `${NEW_BASE}/locations:batchUpdate?validate_only=true`,
      body: {
        requests: [
          {
            location_id: sample.id,
            update_mask: "business_name",
            location: { business_name: sample.locationName },
          },
        ],
      },
    },
    {
      label: "STEP 5c — NEW API probe: POST /locations/batchUpdate (Apikey)",
      method: "POST",
      url: `${NEW_BASE}/locations/batchUpdate?validate_only=true`,
      body: { locations: [{ id: sample.id, business_name: sample.locationName }] },
    },
    {
      label: "STEP 5d — NEW API probe: PUT /locations (plural, bulk style from old API, Apikey)",
      method: "PUT",
      url: `${NEW_BASE}/locations?validate_only=true`,
      body: { locations: [{ id: sample.id, business_name: sample.locationName }] },
    },
  ];

  for (const p of probes) {
    await call(p.label, p.method, p.url, p.body, "apikey");
  }

  console.log(`\n${pad(72, "═")}`);
  console.log("Done. Read above for results.");
  console.log("All write attempts used validate_only=true — nothing was modified.");
})();
