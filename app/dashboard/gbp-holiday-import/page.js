"use client";

/**
 * GBP Holiday Hours Import — the Semrush holiday import's twin, writing
 * straight to Google Business Profile instead.
 *
 * Same CSV (Franchise ID, Holiday, Holiday Open, Holiday Close [, Holiday 2
 * ...]). Rows match shops in lm_shop_numbers that carry a gbp_location_id.
 * Open/Close of "REMOVE" takes the date off the profile. For each shop the
 * server reads the profile's current special hours, replaces only the
 * CSV's dates, and writes the list back — other dates are untouched.
 *
 * Push flow mirrors /dashboard/gbp-posts: chunks of 50 to
 * /api/gbp/holiday-push with a batchId; the server may hand back
 * remainingShopIds when its time budget runs out, which get re-queued.
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { useUser } from "../layout";
import { getBrandConfig } from "@/lib/data";
import { describePeriod } from "@/lib/gbp-hours";

const BATCH_SIZE = 50;
const INTER_BATCH_DELAY_MS = 3000;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function describeEntry(hh) {
  if (hh.type === "REMOVE") return `${hh.day}: Remove`;
  if (hh.type === "CLOSED") return `${hh.day}: Closed`;
  if (hh.type === "OPENED_ALL_DAY") return `${hh.day}: Open 24h`;
  const t = hh.times?.[0];
  return `${hh.day}: ${t ? `${t.from}–${t.to}` : "?"}`;
}

function entryColors(type) {
  if (type === "REMOVE") return { bg: "#2d1b0020", fg: "#fbbf24", border: "#8b6b2040" };
  if (type === "CLOSED") return { bg: "#2d0a0a20", fg: "#f87171", border: "#5c1a1a40" };
  return { bg: "#0d281820", fg: "#34d399", border: "#2d5a2d40" };
}

export default function GbpHolidayImportPage() {
  const user = useUser();
  const canPush = user && ["admin", "manager"].includes(user.role);

  const fileInputRef = useRef(null);
  const cancelRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pushProgress, setPushProgress] = useState(null);
  const [pushResult, setPushResult] = useState(null);
  const [toast, setToast] = useState(null);

  // Shops (for the template generator) and import history.
  const [shops, setShops] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedBatchId, setExpandedBatchId] = useState(null);
  const [detailByBatch, setDetailByBatch] = useState({});

  // Template generator.
  const [tmplBrand, setTmplBrand] = useState("");
  const [tmplDate, setTmplDate] = useState("");
  const [tmplMode, setTmplMode] = useState("closed"); // closed | hours | remove
  const [tmplOpen, setTmplOpen] = useState("09:00");
  const [tmplClose, setTmplClose] = useState("17:00");

  useEffect(() => {
    fetch("/api/shops")
      .then((r) => r.json())
      .then((d) => setShops(d.shops || []))
      .catch(() => {});
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/gbp/holiday-push?limit=25");
      const data = await res.json();
      setHistory(data.batches || []);
    } catch {
      /* history is best-effort */
    }
    setHistoryLoading(false);
  };

  const showToast = (msg, isError) => setToast({ msg, isError });

  const brandList = useMemo(() => {
    const ids = [...new Set(shops.map((s) => s.brand).filter(Boolean))];
    return ids
      .map((id) => ({ id, name: getBrandConfig(id).name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [shops]);

  const tmplBrandShops = tmplBrand ? shops.filter((s) => s.brand === tmplBrand && s.gbp_location_id) : [];
  const tmplBrandNoGbp = tmplBrand ? shops.filter((s) => s.brand === tmplBrand && !s.gbp_location_id).length : 0;

  const generateTemplate = () => {
    if (!tmplBrand) { showToast("Pick a brand first", true); return; }
    if (!tmplDate) { showToast("Pick a holiday date", true); return; }
    if (tmplMode === "hours" && (!tmplOpen || !tmplClose)) {
      showToast("Enter open and close times", true);
      return;
    }
    if (tmplBrandShops.length === 0) {
      showToast("No shops with a GBP mapping for that brand", true);
      return;
    }
    const openVal = tmplMode === "closed" ? "CLOSED" : tmplMode === "remove" ? "REMOVE" : tmplOpen;
    const closeVal = tmplMode === "closed" ? "CLOSED" : tmplMode === "remove" ? "REMOVE" : tmplClose;
    const sorted = [...tmplBrandShops].sort((a, b) =>
      String(a.shop_id).localeCompare(String(b.shop_id), undefined, { numeric: true })
    );
    const rows = [
      "Franchise ID,Holiday,Holiday Open,Holiday Close",
      ...sorted.map((s) => `${s.shop_id},${tmplDate},${openVal},${closeVal}`),
    ];
    const blob = new Blob([rows.join("\r\n")], { type: "text/csv" });
    const brandName = getBrandConfig(tmplBrand).name.replace(/\s+/g, "-").toLowerCase();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${brandName}-gbp-holiday-${tmplDate}${tmplMode === "remove" ? "-remove" : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast(`Template generated — ${sorted.length} shops`);
  };

  const handleFileSelect = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) { showToast("Please select a CSV file", true); return; }
    setLoading(true);
    setPreview(null);
    setPushResult(null);
    setPushProgress(null);
    try {
      const csvData = await file.text();
      const res = await fetch("/api/gbp/holiday-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvData }),
      });
      const rawText = await res.text();
      let result;
      try {
        result = JSON.parse(rawText);
      } catch {
        showToast(`Server returned non-JSON (HTTP ${res.status}): ${rawText.slice(0, 100)}`, true);
        setLoading(false);
        return;
      }
      if (res.ok) {
        setPreview(result);
        if (result.gbp?.state === "no_credentials" || result.gbp?.state === "not_connected") {
          showToast(`Google is ${result.gbp.state.replace("_", " ")}. The push will fail until an admin connects Google on the Admin page.`, true);
        }
      } else {
        showToast(result.error || "Failed to parse CSV", true);
      }
    } catch (error) {
      showToast("Failed to process file: " + error.message, true);
    }
    setLoading(false);
  };

  const handlePush = async () => {
    if (!preview?.updates?.length || !canPush) return;
    setPushing(true);
    setStopping(false);
    setPushResult(null);
    cancelRef.current = false;

    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const byShop = new Map(preview.updates.map((u) => [String(u.shopId), u]));
    const chunks = chunkArray(preview.updates.map((u) => String(u.shopId)), BATCH_SIZE);
    let totalBatches = chunks.length;

    let pushed = 0;
    let unchanged = 0;
    let errors = 0;
    let skipped = 0;
    let stopped = false;
    const allErrors = [];
    const changedShops = [];

    setPushProgress({ current: 0, total: totalBatches, pushed, unchanged, errors, skipped });

    for (let i = 0; i < chunks.length; i++) {
      if (cancelRef.current) { stopped = true; break; }
      if (i > 0) {
        const start = Date.now();
        while (Date.now() - start < INTER_BATCH_DELAY_MS) {
          if (cancelRef.current) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (cancelRef.current) { stopped = true; break; }
      }

      setPushProgress({ current: i + 1, total: totalBatches, pushed, unchanged, errors, skipped });
      const updates = chunks[i].map((id) => ({ shopId: id, holidayHours: byShop.get(id).holidayHours }));

      try {
        const res = await fetch("/api/gbp/holiday-push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchId, updates }),
        });
        const raw = await res.text();
        let data = null;
        try { data = JSON.parse(raw); } catch { data = null; }
        if (!data || typeof data !== "object") {
          const snippet = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
          throw new Error(`Server didn't return a readable answer (HTTP ${res.status}${snippet ? `: ${snippet}` : ""}). Check the history below for what was recorded.`);
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        pushed += data.pushed || 0;
        unchanged += data.unchanged || 0;
        errors += data.pushErrors || 0;
        skipped += data.skipped || 0;
        for (const r of data.results || []) {
          if (r.state === "SUCCESS") changedShops.push(r.shopId);
          if (r.state === "FAILED" || r.state === "SKIPPED") {
            const u = byShop.get(String(r.shopId));
            allErrors.push({ shopId: r.shopId, state: r.state, where: u ? `${u.street}, ${u.city} ${u.state}` : "", error: r.error || "Unknown error" });
          }
        }
        if (Array.isArray(data.remainingShopIds) && data.remainingShopIds.length > 0) {
          chunks.splice(i + 1, 0, data.remainingShopIds);
          totalBatches = chunks.length;
        }
      } catch (e) {
        errors += chunks[i].length;
        for (const id of chunks[i]) {
          const u = byShop.get(id);
          allErrors.push({ shopId: id, state: "FAILED", where: u ? `${u.street}, ${u.city} ${u.state}` : "", error: e.message });
        }
      }
    }

    setPushProgress(null);
    setPushResult({ batchId, pushed, unchanged, pushErrors: errors, skipped, stopped, errors: allErrors.length > 0 ? allErrors : undefined });
    setPushing(false);
    setStopping(false);
    showToast(
      stopped
        ? `Stopped — ${pushed} profiles updated before stop`
        : `Updated ${pushed} GBP profiles${unchanged > 0 ? ` · ${unchanged} already matched` : ""}${errors > 0 ? ` · ${errors} failed` : ""}${skipped > 0 ? ` · ${skipped} skipped` : ""}`,
      errors > 0
    );
    fetchHistory();
  };

  const handleStop = () => {
    cancelRef.current = true;
    setStopping(true);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files[0]);
  };

  const reset = () => {
    setPreview(null);
    setPushResult(null);
    setPushProgress(null);
  };

  const toggleBatchDetail = async (batchId) => {
    if (expandedBatchId === batchId) { setExpandedBatchId(null); return; }
    setExpandedBatchId(batchId);
    if (detailByBatch[batchId]) return;
    setDetailByBatch((d) => ({ ...d, [batchId]: { loading: true } }));
    try {
      const res = await fetch(`/api/gbp/holiday-push?batchId=${encodeURIComponent(batchId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDetailByBatch((d) => ({ ...d, [batchId]: { rows: data.rows || [] } }));
    } catch (e) {
      setDetailByBatch((d) => ({ ...d, [batchId]: { error: e.message } }));
    }
  };

  const downloadBatchCsv = (batchId, rows) => {
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const fmt = (periods) => (Array.isArray(periods) ? periods.map(describePeriod).join("; ") : "");
    const lines = ["Shop ID,Brand,Outcome,Dates in CSV,Before,After,Error,Recorded at"];
    for (const r of rows) {
      lines.push([r.shopId, r.brand, r.state, (r.entries || []).map(describeEntry).join("; "), fmt(r.before), fmt(r.after), r.error, r.pushedAt].map(esc).join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gbp-holiday-${batchId}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const inputStyle = { background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" };

  return (
    <>
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-slide-up px-5 py-3 rounded-lg text-sm font-medium flex items-start gap-3 max-w-lg" style={{ background: toast.isError ? "#2d0a0a" : "#1a2e1a", border: `1px solid ${toast.isError ? "#5c1a1a" : "#2d5a2d"}`, color: toast.isError ? "#f87171" : "#6ee7b7" }}>
          <span className="flex-shrink-0 mt-0.5">{toast.isError ? "✗" : "✓"}</span>
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity" style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: "1rem", lineHeight: 1, marginLeft: "0.25rem" }}>×</button>
        </div>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">GBP Holiday Hours Import</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>
            Upload a CSV to set or remove holiday hours directly on Google Business Profile. Semrush is not involved.
          </p>
        </div>
        {(preview || pushResult) && !pushing && (
          <button onClick={reset} className="px-3 py-1.5 rounded-md text-xs font-semibold" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}>
            Upload New File
          </button>
        )}
      </div>

      {!canPush && (
        <div className="rounded-xl p-4 mb-5" style={{ background: "#2d1b0020", border: "1px solid #8b6b2040" }}>
          <div className="text-xs" style={{ color: "#fbbf24" }}>Only admins and managers can push holiday hours to Google. You can still preview a CSV and view history.</div>
        </div>
      )}

      {/* Upload area */}
      {!preview && !pushResult && (
        <div
          className="rounded-xl p-8 mb-5 text-center transition-colors cursor-pointer"
          style={{ background: dragOver ? "#0c1a2e" : "#151517", border: `2px dashed ${dragOver ? "#93c5fd" : loading ? "#555" : "#2a2a2e"}` }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !loading && fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFileSelect(e.target.files[0])} />
          {loading ? (
            <div>
              <div className="text-lg mb-2" style={{ color: "#93c5fd" }}>Processing...</div>
              <p className="text-xs" style={{ color: "#666" }}>Parsing CSV and matching shop IDs to Google Business Profiles</p>
            </div>
          ) : (
            <div>
              <div className="text-3xl mb-3">🗓</div>
              <div className="text-sm font-semibold text-white mb-1">Upload Holiday Hours CSV</div>
              <p className="text-xs" style={{ color: "#666" }}>Drag and drop your CSV here, or click to browse</p>
              <p className="text-[10px] mt-2" style={{ color: "#555" }}>Columns: Franchise ID, Holiday (date), Holiday Open, Holiday Close. Use REMOVE in Open/Close to delete a date.</p>
            </div>
          )}
        </div>
      )}

      {/* Template generator */}
      {!preview && !pushResult && (
        <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <h4 className="text-sm font-semibold text-white mb-1">Generate a template</h4>
          <p className="text-[11px] mb-4" style={{ color: "#666" }}>
            Build a ready-to-upload CSV with every GBP-mapped shop in a brand for one date. Pick &ldquo;Remove this date&rdquo; to take a wrong holiday off every profile.
          </p>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#777" }}>Brand</label>
              <select value={tmplBrand} onChange={(e) => setTmplBrand(e.target.value)} className="px-3 py-2 rounded-md text-xs" style={{ ...inputStyle, minWidth: "180px" }}>
                <option value="">Select a brand…</option>
                {brandList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#777" }}>Holiday date</label>
              <input type="date" value={tmplDate} onChange={(e) => setTmplDate(e.target.value)} className="px-3 py-2 rounded-md text-xs" style={inputStyle} />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#777" }}>Hours</label>
              <div className="flex items-center gap-2">
                <select value={tmplMode} onChange={(e) => setTmplMode(e.target.value)} className="px-3 py-2 rounded-md text-xs" style={inputStyle}>
                  <option value="closed">Closed all day</option>
                  <option value="hours">Open with special hours</option>
                  <option value="remove">Remove this date</option>
                </select>
                {tmplMode === "hours" && (
                  <div className="flex items-center gap-1.5">
                    <input type="time" value={tmplOpen} onChange={(e) => setTmplOpen(e.target.value)} className="px-2 py-1.5 rounded text-xs font-mono" style={inputStyle} />
                    <span className="text-[11px]" style={{ color: "#555" }}>to</span>
                    <input type="time" value={tmplClose} onChange={(e) => setTmplClose(e.target.value)} className="px-2 py-1.5 rounded text-xs font-mono" style={inputStyle} />
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={generateTemplate}
              disabled={!tmplBrand || !tmplDate || tmplBrandShops.length === 0}
              className="px-4 py-2 rounded-md text-xs font-semibold text-white"
              style={{ background: "#E31837", opacity: !tmplBrand || !tmplDate || tmplBrandShops.length === 0 ? 0.5 : 1 }}
            >
              Download CSV
            </button>
          </div>
          {tmplBrand && (
            <p className="text-[11px] mt-3" style={{ color: "#888" }}>
              {tmplBrandShops.length} shop{tmplBrandShops.length === 1 ? "" : "s"} will be included.
              {tmplBrandNoGbp > 0 && (
                <span style={{ color: "#fbbf24" }}> {tmplBrandNoGbp} excluded (no GBP mapping — run the mapping sync on the Admin page).</span>
              )}
            </p>
          )}
        </div>
      )}

      {/* Live progress */}
      {pushProgress && (
        <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="flex justify-between items-center mb-3">
            <h4 className="text-sm font-semibold text-white">{stopping ? "Stopping after this batch…" : "Updating Google Business Profiles..."}</h4>
            <div className="flex items-center gap-3">
              <span className="text-xs font-mono" style={{ color: "#93c5fd" }}>Batch {pushProgress.current} of {pushProgress.total}</span>
              <button
                onClick={handleStop}
                disabled={stopping}
                className="px-3 py-1 rounded-md text-[11px] font-semibold"
                style={{ background: stopping ? "#1c1c1f" : "#2d0a0a", border: `1px solid ${stopping ? "#2a2a2e" : "#5c1a1a"}`, color: stopping ? "#666" : "#f87171", cursor: stopping ? "default" : "pointer" }}
              >
                {stopping ? "Stopping…" : "Stop"}
              </button>
            </div>
          </div>
          <div className="w-full h-2 rounded-full mb-3" style={{ background: "#1c1c1f" }}>
            <div className="h-2 rounded-full transition-all duration-500" style={{ background: "#93c5fd", width: `${(pushProgress.current / Math.max(1, pushProgress.total)) * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-6 text-xs" style={{ color: "#888" }}>
            <span>Updated: <strong style={{ color: "#34d399" }}>{pushProgress.pushed}</strong></span>
            <span>Already matched: <strong style={{ color: "#aaa" }}>{pushProgress.unchanged}</strong></span>
            <span>Errors: <strong style={{ color: pushProgress.errors > 0 ? "#f87171" : "#34d399" }}>{pushProgress.errors}</strong></span>
            <span>Skipped: <strong style={{ color: pushProgress.skipped > 0 ? "#fbbf24" : "#aaa" }}>{pushProgress.skipped}</strong></span>
            <span style={{ color: "#555" }}>Each batch of {BATCH_SIZE} takes about a minute. Keep this tab open.</span>
          </div>
        </div>
      )}

      {/* Preview */}
      {preview && !pushResult && !pushing && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: "CSV Rows", value: preview.total, color: "#e8e8e8" },
              { label: "Matched to GBP", value: preview.matched, color: "#34d399" },
              { label: "Unknown Shop ID", value: preview.unmatched, color: preview.unmatched > 0 ? "#fbbf24" : "#34d399" },
              { label: "No GBP Mapping", value: preview.noGbp, color: preview.noGbp > 0 ? "#fbbf24" : "#34d399" },
            ].map((stat) => (
              <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
                <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
                <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: "Closed", value: preview.closed, color: "#f87171" },
              { label: "Special Hours", value: preview.specialHours, color: "#93c5fd" },
              { label: "Removals", value: preview.removals, color: "#fbbf24" },
              { label: "Profiles to Update", value: preview.updates?.length || 0, color: "#34d399" },
            ].map((stat) => (
              <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
                <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
                <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
              </div>
            ))}
          </div>

          {preview.unmatched > 0 && (
            <div className="rounded-xl p-4 mb-5" style={{ background: "#2d1b0020", border: "1px solid #8b6b2040" }}>
              <div className="text-xs font-semibold mb-1" style={{ color: "#fbbf24" }}>{preview.unmatched} shop IDs are not in the Shop Numbers database</div>
              <div className="text-[10px] font-mono" style={{ color: "#888" }}>{(preview.unmatchedIds || []).join(", ")}</div>
            </div>
          )}
          {preview.noGbp > 0 && (
            <div className="rounded-xl p-4 mb-5" style={{ background: "#2d1b0020", border: "1px solid #8b6b2040" }}>
              <div className="text-xs font-semibold mb-1" style={{ color: "#fbbf24" }}>{preview.noGbp} shops have no Google Business Profile mapping</div>
              <div className="text-[10px] font-mono" style={{ color: "#888" }}>{(preview.noGbpIds || []).join(", ")}</div>
              <p className="text-[10px] mt-1.5" style={{ color: "#666" }}>Run the GBP mapping sync on the Admin page, then re-upload to include them.</p>
            </div>
          )}

          <div className="rounded-xl overflow-hidden mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="px-4 py-3" style={{ borderBottom: "1px solid #1e1e22" }}>
              <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: "#aaa" }}>Preview — First 20 Updates</h4>
            </div>
            {(preview.preview || []).map((u, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-4" style={{ borderBottom: "1px solid #1a1a1d", background: i % 2 === 0 ? "#151517" : "#131315" }}>
                <span className="text-xs font-mono font-semibold w-16" style={{ color: "#93c5fd" }}>#{u.shopId}</span>
                <span className="text-xs text-white truncate flex-1">{u.street}</span>
                <span className="text-[11px]" style={{ color: "#888" }}>{u.city}, {u.state}</span>
                <div className="flex gap-1.5 flex-wrap justify-end">
                  {u.holidayHours.map((hh, j) => {
                    const c = entryColors(hh.type);
                    return (
                      <span key={j} className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}>
                        {describeEntry(hh)}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-4 p-5 rounded-xl" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div>
              <div className="text-sm font-semibold text-white">Ready to update {preview.updates?.length || 0} Google Business Profiles</div>
              <p className="text-[10px] mt-0.5" style={{ color: "#666" }}>
                Only the dates in the CSV change on each profile; other holiday dates stay as they are. Batches of {BATCH_SIZE}, about a minute each —
                roughly {Math.max(1, Math.ceil((preview.updates?.length || 0) / BATCH_SIZE))} minute{Math.ceil((preview.updates?.length || 0) / BATCH_SIZE) === 1 ? "" : "s"}. Keep this tab open.
              </p>
            </div>
            <button
              onClick={handlePush}
              disabled={!canPush || pushing || (preview.updates?.length || 0) === 0}
              className="px-6 py-2.5 rounded-md text-sm font-semibold text-white flex-shrink-0"
              style={{ background: "#E31837", opacity: !canPush || pushing || (preview.updates?.length || 0) === 0 ? 0.5 : 1 }}
            >
              Push to Google
            </button>
          </div>
        </>
      )}

      {/* Results */}
      {pushResult && (
        <div className="space-y-5">
          {pushResult.stopped && (
            <div className="rounded-xl p-4" style={{ background: "#2d1b0020", border: "1px solid #8b6b2040" }}>
              <div className="text-xs font-semibold" style={{ color: "#fbbf24" }}>Import stopped early</div>
              <p className="text-[10px] mt-1" style={{ color: "#888" }}>
                Re-upload the CSV to finish. Profiles that already match the CSV are reported as &ldquo;already matched&rdquo; and not written again.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Profiles Updated", value: pushResult.pushed, color: "#34d399" },
              { label: "Already Matched", value: pushResult.unchanged, color: "#aaa" },
              { label: "Errors", value: pushResult.pushErrors, color: pushResult.pushErrors > 0 ? "#f87171" : "#34d399" },
              { label: "Skipped", value: pushResult.skipped, color: pushResult.skipped > 0 ? "#fbbf24" : "#aaa" },
            ].map((stat) => (
              <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
                <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
                <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
              </div>
            ))}
          </div>

          {pushResult.errors && pushResult.errors.length > 0 && (
            <div className="rounded-xl p-4" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40" }}>
              <div className="flex justify-between items-center mb-3">
                <h4 className="text-xs font-bold" style={{ color: "#f87171" }}>{pushResult.errors.length} shops not updated</h4>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const csv = "Shop ID,Outcome,Address,Error\n" + pushResult.errors.map((e) => `${e.shopId},${e.state},"${e.where || ""}","${String(e.error).replace(/"/g, '""')}"`).join("\n");
                      navigator.clipboard.writeText(csv);
                      showToast("Error list copied to clipboard as CSV");
                    }}
                    className="px-2.5 py-1 rounded text-[10px] font-semibold"
                    style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
                  >
                    Copy as CSV
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(pushResult.errors.map((e) => e.shopId).join(", "));
                      showToast("Shop IDs copied to clipboard");
                    }}
                    className="px-2.5 py-1 rounded text-[10px] font-semibold"
                    style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
                  >
                    Copy Shop IDs
                  </button>
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-0.5">
                {pushResult.errors.map((err, i) => (
                  <div key={i} className="text-[11px] py-1 flex items-start gap-3" style={{ borderBottom: i < pushResult.errors.length - 1 ? "1px solid #5c1a1a15" : "none" }}>
                    <span className="font-mono font-semibold flex-shrink-0 w-16" style={{ color: "#93c5fd" }}>#{err.shopId}</span>
                    <span className="flex-1 truncate" style={{ color: "#999" }}>{err.where}</span>
                    <span style={{ color: err.state === "SKIPPED" ? "#fbbf24" : "#f87171" }}>{err.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="p-4 rounded-xl" style={{ background: "#0d281830", border: "1px solid #2d5a2d40" }}>
            <p className="text-xs" style={{ color: "#34d399" }}>
              Holiday hours were written straight to Google Business Profile. They usually show on Google within minutes. Semrush was not changed, so a later Semrush sync of special hours could still overwrite them.
            </p>
          </div>
        </div>
      )}

      {/* History */}
      <div className="mt-5 rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <div className="px-4 py-3 flex justify-between items-center" style={{ borderBottom: "1px solid #1e1e22" }}>
          <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: "#aaa" }}>Recent GBP holiday imports</h4>
          <button onClick={fetchHistory} className="text-[10px]" style={{ color: "#666" }}>{historyLoading ? "Loading…" : "Refresh"}</button>
        </div>
        {history.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs" style={{ color: "#555" }}>{historyLoading ? "Loading…" : "No imports yet."}</div>
        ) : (
          <div>
            {history.map((h) => {
              const expanded = expandedBatchId === h.batch_id;
              const detail = detailByBatch[h.batch_id];
              return (
                <div key={h.batch_id} style={{ borderBottom: "1px solid #1a1a1d" }}>
                  <div className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs cursor-pointer" onClick={() => toggleBatchDetail(h.batch_id)}>
                    <span style={{ color: "#888" }}>{h.pushed_at ? new Date(h.pushed_at).toLocaleString() : ""}</span>
                    <span className="font-semibold text-white">{h.brand ? getBrandConfig(h.brand).name : "—"}</span>
                    <span className="font-mono" style={{ color: "#93c5fd" }}>{(h.dates || []).join(", ")}</span>
                    <span style={{ color: "#555" }}>by {h.pushed_by || "—"}</span>
                    <span className="ml-auto flex gap-3">
                      <span style={{ color: "#34d399" }}>{h.succeeded} updated</span>
                      {h.unchanged > 0 && <span style={{ color: "#aaa" }}>{h.unchanged} matched</span>}
                      {h.failed > 0 && <span style={{ color: "#f87171" }}>{h.failed} failed</span>}
                      {h.skipped > 0 && <span style={{ color: "#fbbf24" }}>{h.skipped} skipped</span>}
                      <span style={{ color: "#555" }}>{expanded ? "▴" : "▾"}</span>
                    </span>
                  </div>
                  {expanded && (
                    <div className="px-4 pb-4 text-[11px]">
                      {detail?.loading && <div style={{ color: "#666" }}>Loading…</div>}
                      {detail?.error && <div style={{ color: "#f87171" }}>Couldn&apos;t load: {detail.error}</div>}
                      {detail?.rows && (
                        <>
                          <div className="flex justify-between items-center mb-2">
                            <span style={{ color: "#888" }}>{detail.rows.length} shops. Before/after are the full special-hours lists Google held, so a bad import can be undone from this file.</span>
                            <button onClick={() => downloadBatchCsv(h.batch_id, detail.rows)} className="px-2 py-1 rounded text-[10px] font-semibold" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#93c5fd" }}>
                              Download CSV
                            </button>
                          </div>
                          <div className="max-h-64 overflow-y-auto space-y-0.5">
                            {detail.rows.map((r) => (
                              <div key={r.shopId} className="grid grid-cols-12 gap-2 text-[10px]" style={{ color: "#aaa" }}>
                                <div className="col-span-1 font-mono" style={{ color: "#ddd" }}>{r.shopId}</div>
                                <div className="col-span-2" style={{ color: r.state === "SUCCESS" ? "#34d399" : r.state === "FAILED" ? "#f87171" : r.state === "SKIPPED" ? "#fbbf24" : "#aaa" }}>{r.state}</div>
                                <div className="col-span-9 truncate" title={r.error || (Array.isArray(r.after) ? r.after.map(describePeriod).join("; ") : "")}>
                                  {r.error || (Array.isArray(r.after) ? (r.after.length ? r.after.map(describePeriod).join("; ") : "No special hours") : "")}
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Help */}
      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <h4 className="text-xs font-bold mb-2" style={{ color: "#aaa" }}>CSV Format</h4>
        <div className="text-xs leading-relaxed space-y-1" style={{ color: "#777" }}>
          <p><strong style={{ color: "#aaa" }}>Required:</strong> Franchise ID (shop number), Holiday (date like 11/26/2026), Holiday Open, Holiday Close</p>
          <p><strong style={{ color: "#aaa" }}>Optional:</strong> Holiday 2, Holiday Open 2, Holiday Close 2 (a second date in the same row). Repeat the Franchise ID across rows for more dates.</p>
          <p><strong style={{ color: "#aaa" }}>Closed:</strong> set Holiday Open and Holiday Close to &ldquo;CLOSED&rdquo;</p>
          <p><strong style={{ color: "#aaa" }}>Remove a date:</strong> set Holiday Open and Holiday Close to &ldquo;REMOVE&rdquo; — the date is deleted from the profile&apos;s special hours</p>
          <p><strong style={{ color: "#aaa" }}>Special hours:</strong> times like &ldquo;9:00:00 AM&rdquo; or &ldquo;17:00&rdquo;</p>
          <p><strong style={{ color: "#aaa" }}>What changes:</strong> only the dates listed. Each profile&apos;s other holiday dates are left exactly as Google has them.</p>
        </div>
      </div>
    </>
  );
}
