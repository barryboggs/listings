"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "../layout";
import { getBrandConfig } from "@/lib/data";

/**
 * Bulk-push one image to every shop in a brand via Semrush's per-location
 * image endpoint. Reaches every directory Semrush distributes to.
 *
 * Source modes:
 *   - Paste a public URL (the server fetches + base64-encodes)
 *   - Drag/drop or pick a file (we upload to Vercel Blob first, get a
 *     URL, then use it; falls back to paste-only if Blob isn't configured)
 *
 * The push itself is sequential server-side (250ms throttle, single
 * fetch+encode reused for all shops). Page polls the bulk-image GET
 * endpoint to show recent history below.
 */
export default function ListingsPhotosPage() {
  const currentUser = useUser();
  const fileInputRef = useRef(null);

  const [shops, setShops] = useState([]);
  const [shopsLoading, setShopsLoading] = useState(true);

  const [brandFilter, setBrandFilter] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [description, setDescription] = useState("");

  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState(null);

  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [toast, setToast] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const showToast = (msg, isError) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 4500);
  };

  // Load shop list once on mount — we need it to count eligible shops
  // per brand. Reuses /api/shops which returns the full lm_shop_numbers
  // table with semrush_new_id populated where mapping has run.
  useEffect(() => {
    fetch("/api/shops")
      .then((r) => r.json())
      .then((data) => setShops(data.shops || []))
      .catch(() => {})
      .finally(() => setShopsLoading(false));
  }, []);

  const fetchHistory = async (brand) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (brand) params.set("brand", brand);
      const res = await fetch(`/api/semrush/bulk-image?${params.toString()}`);
      const data = await res.json();
      setHistory(Array.isArray(data.rows) ? data.rows : []);
    } catch {
      setHistory([]);
    }
    setHistoryLoading(false);
  };

  useEffect(() => {
    fetchHistory(brandFilter);
  }, [brandFilter]);

  // Brands that actually have at least one shop in lm_shop_numbers.
  // Sorted alphabetically by brand name for the picker.
  const brandSummary = useMemo(() => {
    const map = new Map();
    for (const s of shops) {
      if (!s.brand) continue;
      const existing = map.get(s.brand) || { brand: s.brand, total: 0, eligible: 0 };
      existing.total++;
      if (s.semrush_new_id) existing.eligible++;
      map.set(s.brand, existing);
    }
    return Array.from(map.values())
      .map((b) => ({ ...b, config: getBrandConfig(b.brand) }))
      .sort((a, b) => (a.config?.name || a.brand).localeCompare(b.config?.name || b.brand));
  }, [shops]);

  const selectedBrandStats = useMemo(() => {
    if (!brandFilter) return null;
    return brandSummary.find((b) => b.brand === brandFilter) || null;
  }, [brandFilter, brandSummary]);

  const canPush = !!brandFilter && !!sourceUrl && (selectedBrandStats?.eligible || 0) > 0 && !pushing;

  // ----- File upload (Vercel Blob) -----

  const handleFileUpload = async (file) => {
    if (!file) return;
    setUploadError(null);
    setUploadingFile(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload-image-blob", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 503) {
          setUploadError("Vercel Blob not configured. Paste a public URL instead, or ask an admin to set BLOB_READ_WRITE_TOKEN.");
        } else {
          setUploadError(data.error || `Upload failed (HTTP ${res.status})`);
        }
        return;
      }
      setSourceUrl(data.url);
      showToast(`Uploaded ${file.name} → ${Math.round(file.size / 1024)} KB`);
    } catch (e) {
      setUploadError(`Upload failed: ${e.message}`);
    }
    setUploadingFile(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
  };

  // ----- Bulk push -----

  const handlePush = async () => {
    if (!canPush) return;
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch("/api/semrush/bulk-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand: brandFilter, sourceUrl, description: description || undefined }),
      });
      const data = await res.json();
      setPushResult(data);
      if (res.ok && data.succeeded > 0) {
        showToast(`Pushed image to ${data.succeeded}/${data.total} shops`);
      } else if (!res.ok) {
        showToast(data.error || "Push failed", true);
      } else {
        showToast(`Push completed: ${data.succeeded} succeeded, ${data.failed} failed`, data.failed > 0);
      }
      // Refresh history to surface the new rows
      fetchHistory(brandFilter);
    } catch (e) {
      showToast(`Network error: ${e.message}`, true);
    }
    setPushing(false);
  };

  if (currentUser?.role && !["admin", "manager"].includes(currentUser.role)) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-3xl mb-3">🔒</div>
          <h2 className="text-base font-bold text-white mb-1">Admin or manager only</h2>
        </div>
      </div>
    );
  }

  return (
    <>
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-slide-up px-5 py-3 rounded-lg text-sm font-medium flex items-center gap-2" style={{ background: toast.isError ? "#2d0a0a" : "#1a2e1a", border: `1px solid ${toast.isError ? "#5c1a1a" : "#2d5a2d"}`, color: toast.isError ? "#f87171" : "#6ee7b7" }}>
          <span>{toast.isError ? "✗" : "✓"}</span> {toast.msg}
        </div>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">Bulk Push Listing Photos</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>
            Upload one image, push it to every shop in a brand. Reaches every directory Semrush distributes to.
          </p>
        </div>
      </div>

      {/* Source picker */}
      <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <h4 className="text-sm font-semibold text-white mb-3">Image source</h4>

        {/* File drop zone */}
        <div
          className="rounded-lg p-5 mb-3 text-center cursor-pointer transition-colors"
          style={{
            background: dragOver ? "#0c1a2e" : "#1a1a1d",
            border: `2px dashed ${dragOver ? "#93c5fd" : uploadingFile ? "#555" : "#2a2a2e"}`,
          }}
          onClick={() => !uploadingFile && fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            className="hidden"
            onChange={(e) => handleFileUpload(e.target.files?.[0])}
          />
          {uploadingFile ? (
            <div className="text-sm" style={{ color: "#93c5fd" }}>Uploading…</div>
          ) : (
            <div>
              <div className="text-2xl mb-2">🖼️</div>
              <div className="text-sm font-semibold text-white">Drag a PNG / JPG / WebP here, or click to browse</div>
              <p className="text-[10px] mt-1" style={{ color: "#555" }}>
                Up to 10 MB. Hosted on Vercel Blob; the URL appears below.
              </p>
            </div>
          )}
        </div>
        {uploadError && (
          <p className="text-[11px] mb-3" style={{ color: "#f87171" }}>
            {uploadError}
          </p>
        )}

        {/* URL field — populated by the upload OR pasted directly */}
        <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
          Source URL (or paste one)
        </label>
        <input
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://… (any publicly-fetchable image URL)"
          className="w-full px-3 py-2 rounded-md text-xs font-mono mb-3"
          style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
        />

        <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
          Description <span style={{ color: "#555" }}>(optional caption, applied to every shop)</span>
        </label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Auto Glass Now exterior"
          className="w-full px-3 py-2 rounded-md text-xs"
          style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
        />
      </div>

      {/* Brand picker */}
      <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <h4 className="text-sm font-semibold text-white mb-3">Target brand</h4>
        {shopsLoading ? (
          <div className="text-xs" style={{ color: "#666" }}>Loading shops…</div>
        ) : brandSummary.length === 0 ? (
          <div className="text-xs" style={{ color: "#666" }}>No shops in lm_shop_numbers. Import some on the Shop Numbers page first.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {brandSummary.map((b) => {
              const active = brandFilter === b.brand;
              const eligibility = b.eligible === b.total
                ? `${b.total} shops`
                : `${b.eligible}/${b.total} eligible`;
              return (
                <button
                  key={b.brand}
                  onClick={() => setBrandFilter(active ? "" : b.brand)}
                  className="px-3 py-2 rounded-lg text-left transition-all"
                  style={{
                    background: active ? b.config.color + "30" : b.config.color + "10",
                    border: `1.5px solid ${active ? b.config.color : b.config.color + "30"}`,
                  }}
                >
                  <div className="text-xs font-semibold" style={{ color: b.config.color }}>{b.config.name}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: active ? "#ddd" : "#888" }}>{eligibility}</div>
                </button>
              );
            })}
          </div>
        )}

        {selectedBrandStats && selectedBrandStats.eligible < selectedBrandStats.total && (
          <p className="text-[11px] mt-3" style={{ color: "#fbbf24" }}>
            ⚠ {selectedBrandStats.total - selectedBrandStats.eligible} {selectedBrandStats.config.name} shops have no rich-API mapping and will be skipped.
            Run <strong>Sync Rich Mappings</strong> on the Admin page to enable them.
          </p>
        )}
      </div>

      {/* Push button */}
      <div className="flex items-center justify-between p-5 rounded-xl mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <div>
          <div className="text-sm font-semibold text-white">
            {brandFilter && selectedBrandStats
              ? `Push to ${selectedBrandStats.eligible} ${selectedBrandStats.config.name} shop${selectedBrandStats.eligible === 1 ? "" : "s"}`
              : "Pick a brand and image source"}
          </div>
          <p className="text-[11px] mt-0.5" style={{ color: "#666" }}>
            {brandFilter && selectedBrandStats
              ? `~${Math.round((selectedBrandStats.eligible * 250 + selectedBrandStats.eligible * 800) / 1000)}s estimated. Server fetches and base64-encodes once, then pushes per-shop with throttling.`
              : "Image upload + brand selection + at least one eligible shop are required."}
          </p>
        </div>
        <button
          onClick={handlePush}
          disabled={!canPush}
          className="px-6 py-2.5 rounded-md text-sm font-semibold text-white"
          style={{ background: "#E31837", opacity: canPush ? 1 : 0.5 }}
        >
          {pushing ? "Pushing…" : "Push to Semrush"}
        </button>
      </div>

      {/* Push result */}
      {pushResult && (
        <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <h4 className="text-sm font-semibold mb-3" style={{ color: pushResult.failed > 0 ? "#fbbf24" : "#34d399" }}>
            {pushResult.failed > 0 ? `Completed with ${pushResult.failed} failures` : "Success"}
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            {[
              { label: "Pushed", value: pushResult.succeeded || 0, color: "#34d399" },
              { label: "Failed", value: pushResult.failed || 0, color: pushResult.failed > 0 ? "#f87171" : "#555" },
              { label: "Skipped (no mapping)", value: pushResult.skipped || 0, color: pushResult.skipped > 0 ? "#fbbf24" : "#555" },
              { label: "Total attempted", value: pushResult.total || 0, color: "#93c5fd" },
            ].map((s) => (
              <div key={s.label} className="px-3 py-2 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
                <div className="text-[10px] font-semibold" style={{ color: "#888" }}>{s.label}</div>
                <div className="text-xl font-bold mt-0.5" style={{ color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
          {pushResult.errors?.length > 0 && (
            <div className="rounded-lg p-3" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40" }}>
              <div className="text-[10px] font-bold uppercase mb-1" style={{ color: "#f87171" }}>
                Failures (first {Math.min(pushResult.errors.length, 50)})
              </div>
              <div className="max-h-40 overflow-auto space-y-0.5">
                {pushResult.errors.slice(0, 50).map((e, i) => (
                  <div key={i} className="text-[10px] flex gap-2 font-mono">
                    <span style={{ color: "#93c5fd" }}>#{e.shopId}</span>
                    <span style={{ color: "#f87171" }}>{e.error}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* History panel */}
      <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: "1px solid #1e1e22" }}>
          <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: "#aaa" }}>
            Recent Pushes {brandFilter && selectedBrandStats ? `(${selectedBrandStats.config.name})` : "(all brands)"}
          </h4>
          <button
            onClick={() => fetchHistory(brandFilter)}
            className="px-3 py-1 rounded text-[11px] font-semibold"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
          >
            Refresh
          </button>
        </div>
        {historyLoading ? (
          <div className="py-8 text-center text-xs" style={{ color: "#666" }}>Loading…</div>
        ) : history.length === 0 ? (
          <div className="py-8 text-center text-xs" style={{ color: "#666" }}>No image pushes yet.</div>
        ) : (
          <div className="divide-y" style={{ borderColor: "#1a1a1d" }}>
            {history.map((row) => {
              const config = getBrandConfig(row.brand);
              const stateColor = row.state === "SUCCESS" ? "#34d399" : row.state === "FAILED" ? "#f87171" : "#fbbf24";
              return (
                <div key={row.id} className="px-4 py-3 flex items-start gap-3" style={{ borderTop: "1px solid #1a1a1d" }}>
                  <span className="w-1 h-10 rounded-sm flex-shrink-0" style={{ background: config.color }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {row.shop_id && (
                        <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded" style={{ background: "#0c1a2e", color: "#93c5fd" }}>
                          #{row.shop_id}
                        </span>
                      )}
                      <span className="text-xs" style={{ color: config.color }}>{config.name}</span>
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase" style={{ background: stateColor + "20", color: stateColor, border: `1px solid ${stateColor}40` }}>
                        {row.state}
                      </span>
                      <span className="text-[10px]" style={{ color: "#555" }}>
                        {row.pushed_at ? new Date(row.pushed_at).toLocaleString() : "—"}
                      </span>
                      {row.pushed_by && <span className="text-[10px]" style={{ color: "#666" }}>by {row.pushed_by}</span>}
                    </div>
                    {row.semrush_image_url && (
                      <div className="text-[10px] font-mono truncate mt-1" style={{ color: "#666" }}>
                        <a href={row.semrush_image_url} target="_blank" rel="noopener noreferrer" style={{ color: "#93c5fd", textDecoration: "underline" }}>
                          View on Semrush ↗
                        </a>
                      </div>
                    )}
                    {row.error_message && (
                      <div className="text-[10px] font-mono mt-1" style={{ color: "#f87171" }}>
                        {row.error_message}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
