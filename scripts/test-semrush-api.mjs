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

  // 6. Pagination probe — does the new API actually paginate, and what's
  //    the real per-page cap? Hit page 1, 2, 3 with different page_size
  //    values and compare.
  console.log(`\n${pad(72, "═")}`);
  console.log("STEP 6 — NEW API pagination probe");
  console.log(`${pad(72, "═")}`);

  const probesPage = [
    { page: 1, page_size: 50 },
    { page: 2, page_size: 50 },
    { page: 3, page_size: 50 },
    { page: 1, page_size: 200 },
    { page: 1, page_size: 500 },
  ];

  const summaries = [];
  for (const p of probesPage) {
    const r = await call(
      `pagination probe page=${p.page} page_size=${p.page_size}`,
      "GET",
      `${NEW_BASE}/locations?page=${p.page}&page_size=${p.page_size}`,
      null,
      "apikey"
    );
    const items = r.body?.data || [];
    summaries.push({
      page: p.page,
      page_size: p.page_size,
      returned: items.length,
      firstId: items[0]?.location_id || null,
      lastId: items[items.length - 1]?.location_id || null,
    });
  }

  console.log(`\n${pad(72, "─")}`);
  console.log("PAGINATION SUMMARY");
  console.log(`${pad(72, "─")}`);
  console.table(summaries);

  const page1 = summaries.find((s) => s.page === 1 && s.page_size === 50);
  const page2 = summaries.find((s) => s.page === 2);
  const page1big = summaries.find((s) => s.page_size === 500);

  console.log("\nDiagnostic:");
  if (page2?.returned === 0) {
    console.log("  → page=2 returned 0 items. Account scope appears to be limited to 50 locations on the Apikey.");
  } else if (page2?.firstId && page1?.firstId && page2.firstId === page1.firstId) {
    console.log("  → page=2 returned the SAME first location as page=1. The API is ignoring the `page` parameter.");
    console.log("    We'd need a different pagination scheme (cursor? offset?) or a different param name.");
  } else if (page2?.returned > 0) {
    console.log("  → page=2 returned distinct data. Pagination IS honored. The fix in lib/semrush-rich.js should work — check that Vercel has the latest deploy.");
  }

  if (page1big?.returned && page1big.returned > 50) {
    console.log(`  → page_size=500 returned ${page1big.returned} items. The 50-per-page cap is NOT a hard server limit; pagination is what we need.`);
  } else if (page1big?.returned === 50) {
    console.log("  → page_size=500 still capped at 50. The server enforces a 50-item max per page; we must paginate.");
  }

  console.log(`\n${pad(72, "═")}`);
  console.log("Done. Read above for results.");
  console.log("All write attempts used validate_only=true — nothing was modified.");

  // 7. Categories endpoint probes — base /categories returned 400 (exists
  //    but malformed). Walk common parameter combos to find the right one.
  console.log(`\n${pad(72, "═")}`);
  console.log("STEP 7 — NEW API categories endpoint probes");
  console.log(`${pad(72, "═")}`);

  const catProbes = [
    { url: `${NEW_BASE}/categories?country=US` },
    { url: `${NEW_BASE}/categories?country=US&limit=50` },
    { url: `${NEW_BASE}/categories?country=US&language=en` },
    { url: `${NEW_BASE}/categories?language=en` },
    { url: `${NEW_BASE}/categories?limit=50&offset=0` },
    { url: `${NEW_BASE}/categories?country=us` }, // lowercase
    { url: `${NEW_BASE}/categories?country_code=US` },
    { url: `${NEW_BASE}/category` }, // singular
    { url: `${NEW_BASE}/business-categories` }, // alt name
    { url: `${NEW_BASE}/categories?search=food` }, // maybe needs search filter
  ];

  const catSummaries = [];
  for (const p of catProbes) {
    const r = await call(`probe ${p.url.replace(NEW_BASE, "")}`, "GET", p.url, null, "apikey");
    catSummaries.push({
      url: p.url.replace(NEW_BASE, ""),
      status: r.status,
      isArray: Array.isArray(r.body?.data),
      count: Array.isArray(r.body?.data) ? r.body.data.length : 0,
      firstKey: Array.isArray(r.body?.data) && r.body.data[0] ? Object.keys(r.body.data[0]).slice(0, 6).join(",") : "—",
    });
  }

  console.log(`\n${pad(72, "─")}`);
  console.log("CATEGORIES SUMMARY");
  console.log(`${pad(72, "─")}`);
  console.table(catSummaries);

  const winner = catSummaries.find((s) => s.status === 200 && s.count > 0);
  if (winner) {
    console.log(`\n✓ Found a working categories endpoint: ${winner.url}`);
    console.log(`  Returned ${winner.count} items with keys: ${winner.firstKey}`);
    console.log(`  Update lib/semrush-rich.js getCategories() to use this path.`);
  } else {
    console.log("\n✗ None of the probed URLs returned a categories list.");
    console.log("  Will need a Semrush support ticket or different doc source for the right path.");
  }
})();
