"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "../layout";
import { getBrandConfig } from "@/lib/data";

/**
 * Map Markers page — surfaces shops whose Semrush listing has no map
 * pin set up. Detection signal (verified 2026-08-31 via /api/gbp/bulk-...
 * diagnostic on a Maaco shop):
 *
 *   Semrush returns `coordinates: {}` (empty object) for shops where
 *   the map pin isn't set. The `errors[]` array is empty and
 *   `location_status` is still "COMPLETED" — no other API signal
 *   indicates the missing pin. appLocationFromRich normalizes the
 *   empty object to null so this page filters on `!loc.coordinates`.
 *
 * Fix flow:
 *   For each affected shop, GET the corresponding GBP location's
 *   `latlng` (Google is the source of truth for verified pin
 *   positions), then PATCH Semrush's `coordinates` field directly.
 *   Bypasses Semrush's own sync from GBP (which is what's broken
 *   here — Semrush isn't picking up GBP's coordinates on its own).
 *
 * Admin-only.
 */

const BATCH_SIZE = 30;
const INTER_BATCH_DELAY_MS = 500;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function MapMarkersPage() {
  const currentUser = useUser();
  const cancelRef = useRef(false);

  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);

  const [brandFilter, setBrandFilter] = useState("all");
  const [selected, setSelected] = useState(() => new Set());

  const [pushing, setPushing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState(null);
  const [toast, setToast] = useState(null);

  // Diagnostic panel — paste a shop_id or location_id, dump the full
  // raw Semrush response. Useful when detection assumptions need
  // re-verifying (as happened during the initial build of this page).
  const [diagShopId, setDiagShopId] = useState("");
  const [diagResult, setDiagResult] = useState(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

  // CSV import panel — bulk-populate lm_shop_numbers.latitude/longitude
  // from the internal Driven Brands shop DB. Fix route prefers these
  // over GBP's latlng.
  const [csvText, setCsvText] = useState("");
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvResult, setCsvResult] = useState(null);
  const [csvOpen, setCsvOpen] = useState(false);

  const showToast = (msg, isError) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 5000);
  };

  const isAdmin = currentUser?.role === "admin";

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/semrush/locations")
      .then((r) => r.json())
      .then((data) => setLocations(data.locations || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isAdmin]);

  // Locations missing a Semrush map pin. `coordinates` is normalized in
  // appLocationFromRich so `!loc.coordinates` catches both null and the
  // empty-object case Semrush returns for unset pins.
  const affected = useMemo(() => {
    return (locations || []).filter((l) => !l.coordinates);
  }, [locations]);

  const brandOptions = useMemo(() => {
    const set = new Set(affected.map((l) => l.brand).filter(Boolean));
    return [...set].sort();
  }, [affected]);

  const filtered = useMemo(() => {
    if (brandFilter === "all") return affected;
    return affected.filter((l) => l.brand === brandFilter);
  }, [affected, brandFilter]);

  // Reset selection when filters change so admin doesn't push shops
  // that are no longer visible.
  useEffect(() => {
    setSelected(new Set());
  }, [brandFilter]);

  // Fixable = we have SOME source of coordinates. Either DB coords (from
  // CSV import) OR a GBP mapping (fetches latlng at fix time). Shops
  // with neither can't be auto-fixed; admin needs to either import
  // coords via CSV or run GBP mapping sync.
  const fixable = useMemo(
    () => filtered.filter((l) =>
      l.shopId && (
        (typeof l.shopLatitude === "number" && typeof l.shopLongitude === "number") ||
        l.gbpLocationId
      )
    ),
    [filtered]
  );

  const selectedFixable = useMemo(
    () => fixable.filter((l) => selected.has(l.shopId)),
    [fixable, selected]
  );

  const gbpDashboardLink = (loc) => {
    // GBP dashboard deep-link. Google's URL uses the numeric location
    // id (strip the "locations/" prefix). Works when admin is logged
    // into Business Profile Manager.
    const gbpId = loc.gbpLocationId || null;
    if (!gbpId) return "https://business.google.com/locations";
    const bare = String(gbpId).replace(/^locations\//, "");
    return `https://business.google.com/n/${bare}/dashboard`;
  };

  const runBulkFix = async () => {
    if (pushing) return;
    const shopIds = [...selectedFixable].map((l) => l.shopId);
    if (shopIds.length === 0) {
      showToast("Select at least one fixable shop first.", true);
      return;
    }
    if (!confirm(`Fix map pins for ${shopIds.length} shop${shopIds.length === 1 ? "" : "s"}? Pulls each shop's coordinates from Google Business Profile and pushes them into Semrush.`)) return;

    setPushing(true);
    setStopping(false);
    cancelRef.current = false;

    const chunks = chunkArray(shopIds, BATCH_SIZE);
    let succeeded = 0, skipped = 0, failed = 0;
    const errors = [];

    setProgress({ phase: "starting", chunk: 0, totalChunks: chunks.length, total: shopIds.length, succeeded, skipped, failed, errors });

    for (let i = 0; i < chunks.length; i++) {
      if (cancelRef.current) break;
      setProgress((p) => ({ ...(p || {}), phase: "sending", chunk: i + 1 }));

      try {
        const res = await fetch("/api/semrush/bulk-fix-coordinates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shopIds: chunks[i] }),
        });
        const data = await res.json();
        if (res.ok) {
          succeeded += data.succeeded || 0;
          skipped += data.skipped || 0;
          failed += data.failed || 0;
          if (Array.isArray(data.results)) {
            for (const r of data.results) {
              if (r.state !== "SUCCESS" && errors.length < 30) {
                errors.push({ shopId: r.shopId, state: r.state, error: r.error || "" });
              }
            }
          }
        } else {
          failed += chunks[i].length;
          if (errors.length < 30) errors.push({ shopId: "chunk", state: "FAILED", error: data.error || `HTTP ${res.status}` });
        }
      } catch (e) {
        failed += chunks[i].length;
        if (errors.length < 30) errors.push({ shopId: "chunk", state: "FAILED", error: e.message });
      }

      setProgress({ phase: "sending", chunk: i + 1, totalChunks: chunks.length, total: shopIds.length, succeeded, skipped, failed, errors });

      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
    }

    setProgress((p) => ({ ...(p || {}), phase: cancelRef.current ? "cancelled" : "done" }));
    setPushing(false);
    setStopping(false);
    const cancelSuffix = cancelRef.current ? " (stopped)" : "";
    showToast(`Fixed ${succeeded}/${shopIds.length} · ${skipped} skipped · ${failed} failed${cancelSuffix}`);

    // Re-fetch locations so the just-fixed shops disappear from the
    // affected list automatically.
    fetch("/api/semrush/locations")
      .then((r) => r.json())
      .then((data) => setLocations(data.locations || []))
      .catch(() => {});
  };

  const requestStop = () => {
    cancelRef.current = true;
    setStopping(true);
    setProgress((p) => (p ? { ...p, phase: "stopping" } : p));
  };

  const runCsvImport = async () => {
    if (csvImporting || !csvText.trim()) return;
    setCsvImporting(true);
    setCsvResult(null);
    try {
      const res = await fetch("/api/shop-numbers/import-coordinates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvData: csvText }),
      });
      const data = await res.json();
      if (res.ok) {
        setCsvResult(data);
        showToast(`Imported ${data.updated} shops · ${data.unmatched} unmatched · ${data.invalid} invalid rows`);
        // Re-fetch locations so DB coords appear on the affected rows
        // (updates the fixable count and "source" hint per shop).
        fetch("/api/semrush/locations")
          .then((r) => r.json())
          .then((d) => setLocations(d.locations || []))
          .catch(() => {});
      } else {
        // Preserve the full error payload so the panel can show the
        // received headers when the header-detection failed.
        setCsvResult({ error: data.error || `HTTP ${res.status}`, ...data });
        showToast(data.error || "CSV import failed", true);
      }
    } catch (e) {
      setCsvResult({ error: e.message });
      showToast(e.message, true);
    }
    setCsvImporting(false);
  };

  const runDiagnostic = async () => {
    const q = diagShopId.trim();
    if (!q) return;
    const match = locations.find((l) => l.shopId === q || l.id === q);
    if (!match) {
      setDiagResult({ error: `No location found for shopId or id "${q}". Check the value and try again.` });
      return;
    }
    setDiagLoading(true);
    setDiagResult(null);
    try {
      const res = await fetch(`/api/semrush/locations/${encodeURIComponent(match.id)}?raw=1`);
      const data = await res.json();
      setDiagResult({
        shopId: match.shopId,
        locationId: match.id,
        name: match.name,
        errorsArray: match.semrushErrors,
        coordinates: match.coordinates,
        semrushStatus: match.semrushStatus,
        raw: data.raw || data,
      });
    } catch (e) {
      setDiagResult({ error: e.message });
    }
    setDiagLoading(false);
  };

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-3xl mb-3">🔒</div>
          <h2 className="text-base font-bold text-white mb-1">Access Restricted</h2>
          <p className="text-sm" style={{ color: "#666" }}>Admin access required.</p>
        </div>
      </div>
    );
  }

  const unfixableCount = filtered.length - fixable.length;

  return (
    <>
      {toast && (
        <div className="fixed top-6 right-6 z-50 px-4 py-3 rounded-lg text-sm font-medium max-w-md" style={{
          background: toast.isError ? "#2d0a0a" : "#0d2818",
          border: `1px solid ${toast.isError ? "#5c1a1a" : "#2d5a2d"}`,
          color: toast.isError ? "#f87171" : "#34d399",
        }}>
          {toast.msg}
        </div>
      )}

      <div className="mb-5 flex justify-between items-start gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">GBP Map Markers</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>
            Shops where Semrush has no map pin set. Fix pulls coordinates from Google Business Profile and pushes them into Semrush directly.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => setCsvOpen(!csvOpen)}
            className="text-[11px] px-3 py-1.5 rounded"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#6ee7b7" }}
          >
            {csvOpen ? "Hide import" : "📥 Import CSV"}
          </button>
          <button
            onClick={() => setDiagOpen(!diagOpen)}
            className="text-[11px] px-3 py-1.5 rounded"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#93c5fd" }}
          >
            {diagOpen ? "Hide diagnostic" : "🔎 Shop diagnostic"}
          </button>
        </div>
      </div>

      {csvOpen && (
        <div className="rounded-xl p-4 mb-4" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="text-[11px] mb-2" style={{ color: "#aaa" }}>
            Paste CSV of shop coordinates. Format: <span className="font-mono" style={{ color: "#e8e8e8" }}>shop_id, latitude, longitude</span> — one shop per row. Header row optional. Fix route will prefer these over GBP&rsquo;s latlng.
          </div>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            rows={6}
            placeholder={"shop_id,latitude,longitude\n13000,30.4394,-97.5993\n13001,30.4212,-97.6104"}
            className="w-full px-3 py-2 rounded-md text-xs font-mono mb-3"
            style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
          />
          <div className="flex justify-between items-center">
            <button
              onClick={runCsvImport}
              disabled={csvImporting || !csvText.trim()}
              className="px-4 py-2 rounded-md text-xs font-semibold text-white"
              style={{ background: "#6ee7b7", color: "#0d2818", opacity: csvImporting ? 0.5 : 1 }}
            >
              {csvImporting ? "Importing…" : "Import coordinates"}
            </button>
            {csvResult && (
              <div className="text-[11px]" style={{ color: csvResult.error ? "#f87171" : "#aaa" }}>
                {csvResult.error
                  ? csvResult.error
                  : `Parsed ${csvResult.parsed} · Updated ${csvResult.updated} · Unmatched ${csvResult.unmatched} · Invalid ${csvResult.invalid}`}
              </div>
            )}
          </div>
          {csvResult?.invalidSamples && csvResult.invalidSamples.length > 0 && (
            <div className="mt-2 text-[10px] font-mono p-2 rounded" style={{ background: "#2d1b0020", border: "1px solid #5c3a0040", color: "#fbbf24" }}>
              <div className="font-semibold mb-1">Invalid row samples:</div>
              {csvResult.invalidSamples.map((s, i) => <div key={i}>{s}</div>)}
            </div>
          )}
          {csvResult?.headersReceived && (
            <div className="mt-2 text-[10px] font-mono p-2 rounded" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40", color: "#f87171" }}>
              <div className="font-semibold mb-1">Header row we received:</div>
              <div>{csvResult.headersReceived.join(" · ")}</div>
              {csvResult.detected && (
                <div className="mt-1" style={{ color: "#aaa" }}>
                  Matched: shop_id → {csvResult.detected.shop || "❌ none"} · latitude → {csvResult.detected.latitude || "❌ none"} · longitude → {csvResult.detected.longitude || "❌ none"}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {diagOpen && (
        <div className="rounded-xl p-4 mb-4" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="text-[11px] mb-2" style={{ color: "#aaa" }}>
            Paste a <strong style={{ color: "#e8e8e8" }}>shop_id</strong> or rich-API <strong style={{ color: "#e8e8e8" }}>location_id</strong> to inspect the raw Semrush response — useful for verifying detection assumptions or debugging weird shops.
          </div>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={diagShopId}
              onChange={(e) => setDiagShopId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runDiagnostic(); }}
              placeholder="e.g. 3456 (shop_id) or a Semrush location_id"
              className="flex-1 px-3 py-2 rounded-md text-xs font-mono"
              style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
            />
            <button
              onClick={runDiagnostic}
              disabled={diagLoading || !diagShopId.trim()}
              className="px-4 py-2 rounded-md text-xs font-semibold text-white"
              style={{ background: "#0ea5e9", opacity: diagLoading ? 0.5 : 1 }}
            >
              {diagLoading ? "Fetching…" : "Dump raw"}
            </button>
          </div>
          {diagResult && (
            <div className="text-[10px] font-mono p-3 rounded overflow-auto max-h-96" style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#aaa" }}>
              {diagResult.error ? (
                <span style={{ color: "#f87171" }}>{diagResult.error}</span>
              ) : (
                <>
                  <div style={{ color: "#93c5fd" }}># App-side view</div>
                  <div>shopId: {String(diagResult.shopId)}</div>
                  <div>locationId: {diagResult.locationId}</div>
                  <div>name: {diagResult.name}</div>
                  <div>coordinates: {JSON.stringify(diagResult.coordinates)}</div>
                  <div>semrushStatus: {JSON.stringify(diagResult.semrushStatus)}</div>
                  <div>errorsArray: {JSON.stringify(diagResult.errorsArray)}</div>
                  <div className="mt-3" style={{ color: "#93c5fd" }}># Raw Semrush response</div>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{JSON.stringify(diagResult.raw, null, 2)}</pre>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Summary + controls */}
      <div className="rounded-xl p-4 mb-4" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <div className="flex flex-wrap justify-between items-end gap-3">
          <div>
            <div className="text-sm font-semibold text-white">
              {affected.length} shops with no map pin
              {brandFilter !== "all" && ` (${filtered.length} in ${getBrandConfig(brandFilter)?.name || brandFilter})`}
            </div>
            {unfixableCount > 0 && (
              <div className="text-[11px] mt-0.5" style={{ color: "#fbbf24" }}>
                {unfixableCount} unfixable — no GBP mapping. Run <a href="/dashboard/admin" style={{ color: "#93c5fd" }}>GBP mapping sync</a> to unlock.
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            <select
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              className="px-3 py-2 rounded-md text-xs"
              style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
            >
              <option value="all">All brands</option>
              {brandOptions.map((b) => (
                <option key={b} value={b}>{getBrandConfig(b)?.name || b}</option>
              ))}
            </select>
            <button
              onClick={() => setSelected(new Set(fixable.map((l) => l.shopId)))}
              disabled={fixable.length === 0}
              className="px-3 py-2 rounded-md text-xs font-semibold"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa", opacity: fixable.length === 0 ? 0.5 : 1 }}
            >
              Select all fixable ({fixable.length})
            </button>
            <button
              onClick={() => setSelected(new Set())}
              disabled={selected.size === 0}
              className="px-3 py-2 rounded-md text-xs font-semibold"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa", opacity: selected.size === 0 ? 0.5 : 1 }}
            >
              Deselect all
            </button>
            {pushing ? (
              <button
                onClick={requestStop}
                disabled={stopping}
                className="px-3 py-2 rounded-md text-xs font-semibold"
                style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}
              >
                {stopping ? "Stopping…" : "Stop"}
              </button>
            ) : (
              <button
                onClick={runBulkFix}
                disabled={selectedFixable.length === 0}
                className="px-4 py-2 rounded-md text-xs font-semibold text-white"
                style={{ background: selectedFixable.length === 0 ? "#333" : "#0ea5e9", opacity: selectedFixable.length === 0 ? 0.5 : 1 }}
                title="Fetch each shop's GBP latlng and PATCH it into Semrush's coordinates field."
              >
                Fix pins for {selectedFixable.length} shop{selectedFixable.length === 1 ? "" : "s"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Progress panel */}
      {progress && (
        <div className="rounded-xl p-4 mb-4" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="flex justify-between items-center mb-2 text-xs">
            <div className="font-bold" style={{ color: progress.phase === "done" ? "#34d399" : progress.phase === "cancelled" ? "#f87171" : "#0ea5e9" }}>
              {progress.phase === "done" ? "Fix complete"
                : progress.phase === "cancelled" ? "Cancelled"
                : progress.phase === "stopping" ? "Stopping…"
                : `Fixing pins… chunk ${progress.chunk}/${progress.totalChunks}`}
            </div>
            <div className="text-[10px]" style={{ color: "#666" }}>
              {progress.succeeded} succeeded · {progress.skipped} skipped · {progress.failed} failed / {progress.total}
            </div>
          </div>
          <div className="h-1.5 rounded overflow-hidden" style={{ background: "#1a1a1d" }}>
            <div className="h-full transition-all duration-300" style={{ width: `${(progress.chunk / progress.totalChunks) * 100}%`, background: progress.phase === "done" ? "#34d399" : "#0ea5e9" }} />
          </div>
          {progress.errors && progress.errors.length > 0 && (
            <div className="mt-2 p-2 rounded max-h-32 overflow-y-auto text-[10px] font-mono" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40", color: "#f87171" }}>
              {progress.errors.slice(0, 15).map((e, i) => (
                <div key={i}>{e.shopId} [{e.state}]: {e.error}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="text-center py-10 text-xs" style={{ color: "#666" }}>Loading locations…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl p-8 text-center" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="text-2xl mb-2">✔</div>
          <div className="text-sm font-semibold text-white mb-1">
            {affected.length === 0 ? "No shops missing a map pin" : "No affected shops in the current filter"}
          </div>
          {affected.length > 0 && (
            <div className="text-xs" style={{ color: "#666" }}>Try switching the brand filter.</div>
          )}
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider" style={{ background: "#1a1a1d", color: "#666" }}>
            <div className="col-span-1"></div>
            <div className="col-span-1">Shop</div>
            <div className="col-span-3">Name</div>
            <div className="col-span-3">Address</div>
            <div className="col-span-1">Brand</div>
            <div className="col-span-1">Source</div>
            <div className="col-span-2 text-right">Dashboard</div>
          </div>
          {filtered.map((loc) => {
            const brandCfg = getBrandConfig(loc.brand);
            const hasDbCoords = typeof loc.shopLatitude === "number" && typeof loc.shopLongitude === "number";
            const isFixable = !!loc.shopId && (hasDbCoords || !!loc.gbpLocationId);
            const isChecked = loc.shopId ? selected.has(loc.shopId) : false;
            return (
              <div
                key={loc.id}
                className="grid grid-cols-12 gap-2 px-4 py-2 items-center text-xs"
                style={{ borderTop: "1px solid #1e1e22" }}
              >
                <div className="col-span-1">
                  {isFixable ? (
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(loc.shopId);
                        else next.delete(loc.shopId);
                        setSelected(next);
                      }}
                    />
                  ) : (
                    <span title="Not fixable — no GBP mapping" style={{ color: "#555" }}>—</span>
                  )}
                </div>
                <div className="col-span-1 font-mono text-[10px]" style={{ color: "#888" }}>{loc.shopId || "—"}</div>
                <div className="col-span-3 truncate" style={{ color: "#e8e8e8" }}>{loc.name}</div>
                <div className="col-span-3 text-[11px] truncate" style={{ color: "#aaa" }}>
                  {loc.address}, {loc.city}, {loc.state}
                </div>
                <div className="col-span-1">
                  <span className="text-[10px] font-semibold" style={{ color: brandCfg?.color || "#888" }}>{brandCfg?.name || loc.brand}</span>
                </div>
                <div className="col-span-1">
                  {hasDbCoords ? (
                    <span className="text-[10px]" style={{ color: "#6ee7b7" }} title="DB coords available (from CSV import)">DB</span>
                  ) : loc.gbpLocationId ? (
                    <span className="text-[10px]" style={{ color: "#93c5fd" }} title="GBP mapped — fix pulls coords from GBP at run time">GBP</span>
                  ) : (
                    <span className="text-[10px]" style={{ color: "#fbbf24" }} title="No coord source — import CSV or run GBP mapping">none</span>
                  )}
                </div>
                <div className="col-span-2 text-right">
                  {loc.gbpLocationId && (
                    <a
                      href={gbpDashboardLink(loc)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px]"
                      style={{ color: "#93c5fd", textDecoration: "none" }}
                    >
                      Open in GBP ↗
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="text-[11px] mt-3" style={{ color: "#666" }}>
          Showing {filtered.length} shops · {fixable.length} fixable · {unfixableCount} need GBP mapping first.
        </div>
      )}
    </>
  );
}
