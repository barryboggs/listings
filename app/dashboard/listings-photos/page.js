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
 * Batching strategy: the bulk-image route handles N shops per call with a
 * 250ms server-side throttle between each. To stay under Vercel's 60s
 * Pro function timeout, the client chunks the brand's eligible shops into
 * BATCH_SIZE-sized groups and calls the route once per batch. ~30 shops
 * per batch fits ~32s of server work comfortably under 60s. A 1,300-shop
 * brand pushes in ~44 batches ≈ 25 minutes wall-clock. Cancel button
 * sets a ref the loop checks between batches.
 */
const BATCH_SIZE = 30;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Defensive string coercion at render sites. React error #31 fires if you
 * render an object directly into JSX; sometimes Semrush returns an error
 * shape like { code, id, message } and that object can leak into our
 * error rendering path. This converts safely: strings pass through,
 * non-strings get JSON-serialized so they at least display readably.
 * Logs to console when a non-string appears so we can trace the source
 * the next time it happens.
 */
function safeRenderable(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    console.warn("[listings-photos] non-string value in error render path", val);
    return JSON.stringify(val);
  } catch {
    return "[unrenderable]";
  }
}

export default function ListingsPhotosPage() {
  const currentUser = useUser();
  const fileInputRef = useRef(null);
  // Set true by the Stop button; the push loop checks between batches.
  const cancelRef = useRef(false);

  const [shops, setShops] = useState([]);
  const [shopsLoading, setShopsLoading] = useState(true);

  const [brandFilter, setBrandFilter] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [description, setDescription] = useState("");
  // Metadata returned by /api/upload-image-blob — drives the preview block.
  // { url, contentType, originalSize, originalWidth, originalHeight,
  //   resizedSize, resizedWidth, resizedHeight, wasResized }
  const [uploadMeta, setUploadMeta] = useState(null);

  const [skipAlreadyPushed, setSkipAlreadyPushed] = useState(true);
  const [auditing, setAuditing] = useState(false);

  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const [pushing, setPushing] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Live progress across batched runs. Set per batch so the UI updates
  // every ~30s as a batch completes (and the user can hit Cancel between).
  // { phase: 'sending'|'done'|'cancelled', batch, totalBatches,
  //   totalEligible, totalSucceeded, totalFailed, totalSkipped, errors }
  const [batchProgress, setBatchProgress] = useState(null);

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
      // 1500 covers the biggest brand in a single bulk run.
      // History is a UI display thing, not a paginated browse —
      // the user wants to see the whole run, not a sample.
      const params = new URLSearchParams({ limit: "1500" });
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
          setUploadError(safeRenderable(data?.error) || `Upload failed (HTTP ${res.status})`);
        }
        return;
      }
      setSourceUrl(data.url);
      setUploadMeta(data);
      const sizeKb = Math.round((data.resizedSize || file.size) / 1024);
      const note = data.wasResized
        ? `Resized to ${sizeKb} KB (${data.resizedWidth}×${data.resizedHeight})`
        : `${sizeKb} KB`;
      showToast(`Uploaded ${file.name} — ${note}`);
    } catch (e) {
      setUploadError(`Upload failed: ${e.message}`);
    }
    setUploadingFile(false);
  };

  const handleClearUpload = () => {
    setSourceUrl("");
    setUploadMeta(null);
    setUploadError(null);
  };

  const handleAudit = async () => {
    if (!confirm("Audit recent FAILED image pushes? This checks Semrush to find ones that actually succeeded and updates the history.")) return;
    setAuditing(true);
    try {
      const body = brandFilter ? { brand: brandFilter, hoursBack: 24 } : { hoursBack: 24 };
      const res = await fetch("/api/admin/audit-image-pushes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      // Always log the full response — when fixed=0 the diagnostics field
      // shows what the closest Semrush image's createDate was per row.
      console.log("Audit result:", data);
      if (!res.ok) {
        showToast(safeRenderable(data?.error) || "Audit failed", true);
      } else if (data.fixed === 0 && data.scanned > 0) {
        showToast(`Scanned ${data.scanned} — no fixes. Check console for diagnostics (closest image gap per shop).`, true);
        fetchHistory(brandFilter);
      } else {
        showToast(`Audit: scanned ${data.scanned}, fixed ${data.fixed}, still failed ${data.stillFailed}`);
        fetchHistory(brandFilter);
      }
    } catch (e) {
      showToast(`Audit error: ${e.message}`, true);
    }
    setAuditing(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
  };

  // ----- Bulk push (client-batched to stay under Vercel function timeout) -----

  const handlePush = async () => {
    if (!canPush) return;

    // Build eligible-shop list locally so we can chunk and track progress
    // without depending on the server to enumerate. Server still filters
    // defensively, but the count drives the batch math here.
    let eligibleShops = shops.filter((s) => s.brand === brandFilter && s.semrush_new_id);
    if (eligibleShops.length === 0) {
      showToast("No eligible shops for that brand", true);
      return;
    }

    setPushing(true);
    setStopping(false);
    cancelRef.current = false;

    // Skip-mode: ask the server which shops already have a SUCCESS row
    // for this exact source URL, filter them out. Source URL identity is
    // the dedup key — re-uploading the same file produces a new URL
    // (Vercel Blob includes a timestamp), so a "redo with resized image"
    // workflow correctly bypasses skip-mode.
    let prePushSkipped = 0;
    if (skipAlreadyPushed) {
      try {
        const params = new URLSearchParams({
          brand: brandFilter,
          state: "SUCCESS",
          sourceUrl,
          limit: "5000",
        });
        const res = await fetch(`/api/semrush/bulk-image?${params.toString()}`);
        const data = await res.json();
        const alreadyShopIds = new Set((data.rows || []).map((r) => String(r.shop_id)));
        const before = eligibleShops.length;
        eligibleShops = eligibleShops.filter((s) => !alreadyShopIds.has(String(s.shop_id)));
        prePushSkipped = before - eligibleShops.length;
        if (prePushSkipped > 0) {
          showToast(`Skip-mode: ${prePushSkipped} shops already received this image — skipping`);
        }
      } catch (e) {
        showToast(`Skip-mode lookup failed: ${e.message}. Pushing to all eligible.`, true);
      }
      if (eligibleShops.length === 0) {
        setPushing(false);
        showToast("All shops already received this image — nothing to push", false);
        return;
      }
    }

    const allShopIds = eligibleShops.map((s) => s.shop_id);
    const batches = chunkArray(allShopIds, BATCH_SIZE);

    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let allErrors = [];
    let stopped = false;

    setBatchProgress({
      phase: "sending",
      batch: 0,
      totalBatches: batches.length,
      totalEligible: eligibleShops.length,
      totalSucceeded, totalFailed, totalSkipped,
      errors: allErrors,
    });

    for (let i = 0; i < batches.length; i++) {
      if (cancelRef.current) { stopped = true; break; }

      setBatchProgress({
        phase: "sending",
        batch: i + 1,
        totalBatches: batches.length,
        totalEligible: eligibleShops.length,
        totalSucceeded, totalFailed, totalSkipped,
        errors: allErrors,
      });

      try {
        const res = await fetch("/api/semrush/bulk-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: brandFilter,
            sourceUrl,
            description: description || undefined,
            shopIds: batches[i],
          }),
        });
        const data = await res.json();
        if (res.ok) {
          totalSucceeded += data.succeeded || 0;
          totalFailed += data.failed || 0;
          totalSkipped += data.skipped || 0;
          if (Array.isArray(data.errors)) {
            for (const err of data.errors) {
              if (allErrors.length < 200) {
                // Normalize at ingest so anything downstream is safe to
                // render. Some Semrush error responses come back as
                // { code, id, message } objects; coerce to a readable string.
                allErrors.push({
                  shopId: safeRenderable(err?.shopId),
                  error: safeRenderable(err?.error),
                });
              }
            }
          }
        } else {
          totalFailed += batches[i].length;
          if (allErrors.length < 200) {
            allErrors.push({
              shopId: `batch-${i + 1}`,
              error: safeRenderable(data?.error) || `HTTP ${res.status}`,
            });
          }
        }
      } catch (e) {
        totalFailed += batches[i].length;
        if (allErrors.length < 200) {
          allErrors.push({ shopId: `batch-${i + 1}`, error: safeRenderable(e?.message || e) });
        }
      }
    }

    const finalPhase = stopped ? "cancelled" : "done";
    setBatchProgress({
      phase: finalPhase,
      batch: batches.length,
      totalBatches: batches.length,
      totalEligible: eligibleShops.length,
      totalSucceeded, totalFailed, totalSkipped,
      errors: allErrors,
    });
    fetchHistory(brandFilter);
    setPushing(false);
    setStopping(false);
    showToast(
      stopped
        ? `Cancelled — ${totalSucceeded}/${eligibleShops.length} pushed before stop`
        : `Pushed image to ${totalSucceeded}/${eligibleShops.length} shops${totalFailed > 0 ? ` (${totalFailed} failed)` : ""}`,
      stopped && totalSucceeded === 0
    );
  };

  const handleStop = () => {
    cancelRef.current = true;
    setStopping(true);
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

        {/* Preview block — shows the actual image Semrush will receive */}
        {sourceUrl && (
          <div className="mb-3 p-3 rounded-md flex items-start gap-3" style={{ background: "#0c0c0e", border: "1px solid #2a2a2e" }}>
            <img
              src={sourceUrl}
              alt="Preview"
              style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 4, background: "#1a1a1d", border: "1px solid #222", flexShrink: 0 }}
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-white truncate">Preview — this is what Semrush will receive</div>
              {uploadMeta ? (
                <div className="text-[11px] mt-1" style={{ color: "#888" }}>
                  {uploadMeta.wasResized ? (
                    <>
                      <span style={{ color: "#34d399" }}>Resized</span>: {Math.round(uploadMeta.originalSize / 1024)} KB
                      {uploadMeta.originalWidth ? ` (${uploadMeta.originalWidth}×${uploadMeta.originalHeight})` : ""}
                      {" → "}
                      {Math.round(uploadMeta.resizedSize / 1024)} KB
                      {uploadMeta.resizedWidth ? ` (${uploadMeta.resizedWidth}×${uploadMeta.resizedHeight})` : ""}
                      {" · "}
                      <span style={{ color: "#aaa" }}>{uploadMeta.contentType}</span>
                    </>
                  ) : (
                    <>
                      {Math.round((uploadMeta.resizedSize || uploadMeta.originalSize) / 1024)} KB
                      {uploadMeta.resizedWidth ? ` (${uploadMeta.resizedWidth}×${uploadMeta.resizedHeight})` : ""}
                      {" · "}
                      <span style={{ color: "#aaa" }}>{uploadMeta.contentType}</span>
                      {" · No resize needed"}
                    </>
                  )}
                </div>
              ) : (
                <div className="text-[11px] mt-1" style={{ color: "#666" }}>
                  Pasted URL — no resize applied. If the image is large ({"> 1 MB"}) consider uploading instead so the server can resize.
                </div>
              )}
              <button
                onClick={handleClearUpload}
                className="text-[10px] mt-1.5 px-2 py-0.5 rounded"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
              >
                Replace
              </button>
            </div>
          </div>
        )}

        {/* URL field — populated by the upload OR pasted directly */}
        <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
          Source URL (or paste one)
        </label>
        <input
          value={sourceUrl}
          onChange={(e) => { setSourceUrl(e.target.value); setUploadMeta(null); }}
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
        <div className="flex-1 min-w-0 pr-4">
          <div className="text-sm font-semibold text-white">
            {brandFilter && selectedBrandStats
              ? `Push to ${selectedBrandStats.eligible} ${selectedBrandStats.config.name} shop${selectedBrandStats.eligible === 1 ? "" : "s"}`
              : "Pick a brand and image source"}
          </div>
          <p className="text-[11px] mt-0.5" style={{ color: "#666" }}>
            {brandFilter && selectedBrandStats
              ? `Runs in batches of ${BATCH_SIZE} shops to stay under Vercel's 60s function timeout. ${Math.ceil(selectedBrandStats.eligible / BATCH_SIZE)} batches · ~${Math.ceil(selectedBrandStats.eligible * 1.05 / 60)} min wall-clock. Keep this tab open.`
              : "Image upload + brand selection + at least one eligible shop are required."}
          </p>
          <label className="flex items-center gap-1.5 mt-2 text-[11px] cursor-pointer" style={{ color: "#aaa" }}>
            <input
              type="checkbox"
              checked={skipAlreadyPushed}
              onChange={(e) => setSkipAlreadyPushed(e.target.checked)}
              style={{ accentColor: "#93c5fd" }}
            />
            Skip shops that already received this exact image
            <span style={{ color: "#555", fontWeight: "normal" }} className="ml-1">(matches by source URL)</span>
          </label>
        </div>
        <div className="flex gap-2">
          {pushing && (
            <button
              onClick={handleStop}
              disabled={stopping}
              className="px-3 py-1.5 rounded-md text-xs font-semibold"
              style={{
                background: stopping ? "#1c1c1f" : "#2d0a0a",
                border: `1px solid ${stopping ? "#2a2a2e" : "#5c1a1a"}`,
                color: stopping ? "#666" : "#f87171",
                cursor: stopping ? "default" : "pointer",
              }}
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          <button
            onClick={handlePush}
            disabled={!canPush}
            className="px-6 py-2.5 rounded-md text-sm font-semibold text-white"
            style={{ background: "#E31837", opacity: canPush ? 1 : 0.5 }}
          >
            {pushing ? "Pushing…" : "Push to Semrush"}
          </button>
        </div>
      </div>

      {/* Live batch progress — appears during a run; stays through completion
          (replaced/augmented by pushResult below once done) */}
      {batchProgress && (
        <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="flex justify-between items-baseline mb-3">
            <h4 className="text-sm font-semibold" style={{ color: batchProgress.phase === "cancelled" ? "#fbbf24" : batchProgress.phase === "done" ? "#34d399" : "#aaa" }}>
              {batchProgress.phase === "cancelled"
                ? `Stopped after batch ${batchProgress.batch} of ${batchProgress.totalBatches}`
                : batchProgress.phase === "done"
                  ? `Done — ${batchProgress.totalBatches} batches complete`
                  : stopping
                    ? `Stopping after batch ${batchProgress.batch}…`
                    : `Sending batch ${batchProgress.batch} of ${batchProgress.totalBatches}…`}
            </h4>
            <span className="text-[11px] font-mono" style={{ color: "#888" }}>
              {batchProgress.totalSucceeded + batchProgress.totalFailed + batchProgress.totalSkipped} / {batchProgress.totalEligible}
            </span>
          </div>
          {/* Progress bar */}
          <div className="w-full h-1.5 rounded-full overflow-hidden mb-3" style={{ background: "#111113" }}>
            <div
              className="h-full transition-all"
              style={{
                width: `${batchProgress.totalEligible > 0 ? ((batchProgress.totalSucceeded + batchProgress.totalFailed + batchProgress.totalSkipped) / batchProgress.totalEligible) * 100 : 0}%`,
                background: batchProgress.phase === "cancelled" ? "#fbbf24" : "#34d399",
              }}
            />
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div>
              <div style={{ color: "#888" }}>Pushed</div>
              <div className="font-bold" style={{ color: "#34d399" }}>{batchProgress.totalSucceeded}</div>
            </div>
            <div>
              <div style={{ color: "#888" }}>Failed</div>
              <div className="font-bold" style={{ color: batchProgress.totalFailed > 0 ? "#f87171" : "#555" }}>{batchProgress.totalFailed}</div>
            </div>
            <div>
              <div style={{ color: "#888" }}>Skipped (no mapping)</div>
              <div className="font-bold" style={{ color: batchProgress.totalSkipped > 0 ? "#fbbf24" : "#555" }}>{batchProgress.totalSkipped}</div>
            </div>
          </div>
          {batchProgress.errors.length > 0 && (
            <div className="mt-3 pt-3" style={{ borderTop: "1px solid #2a2a2e" }}>
              <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: "#f87171" }}>
                Failures (first {Math.min(batchProgress.errors.length, 30)})
              </div>
              <div className="space-y-0.5 max-h-40 overflow-auto">
                {batchProgress.errors.slice(0, 30).map((e, i) => (
                  <div key={i} className="text-[10px] flex gap-2 font-mono">
                    <span style={{ color: "#93c5fd" }}>#{safeRenderable(e.shopId)}</span>
                    <span style={{ color: "#f87171" }} className="flex-1 min-w-0 truncate">{safeRenderable(e.error)}</span>
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
            {history.length > 0 && (
              <span className="ml-2 text-[10px] font-normal" style={{ color: "#666" }}>
                showing {history.length}
              </span>
            )}
          </h4>
          <div className="flex gap-2">
            {currentUser?.role === "admin" && (
              <button
                onClick={handleAudit}
                disabled={auditing}
                title="Check recent FAILED rows against Semrush; flip to SUCCESS for ones the image actually landed on."
                className="px-3 py-1 rounded text-[11px] font-semibold"
                style={{
                  background: "#1c1c1f",
                  border: "1px solid #2a2a2e",
                  color: auditing ? "#666" : "#93c5fd",
                  opacity: auditing ? 0.6 : 1,
                }}
              >
                {auditing ? "Auditing…" : "Audit Failed"}
              </button>
            )}
            <button
              onClick={() => fetchHistory(brandFilter)}
              className="px-3 py-1 rounded text-[11px] font-semibold"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
            >
              Refresh
            </button>
          </div>
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

                  {/* Inline thumbnail. Semrush's storage URL serves the
                      image bytes; rendering via <img> bypasses the
                      Content-Disposition: attachment that makes clicking
                      a link trigger a download. */}
                  {row.semrush_image_url && row.state === "SUCCESS" ? (
                    <a href={row.semrush_image_url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0" title="Open image (browser may download due to Semrush storage headers)">
                      <img
                        src={row.semrush_image_url}
                        alt={`Image for shop ${row.shop_id || row.semrush_new_id}`}
                        style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, background: "#0c0c0e", border: "1px solid #2a2a2e" }}
                        loading="lazy"
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                    </a>
                  ) : (
                    <div className="flex-shrink-0" style={{ width: 48, height: 48, borderRadius: 4, background: "#1a1a1d", border: "1px solid #222" }} />
                  )}

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
                          Open image ↗
                        </a>
                        <span style={{ color: "#555" }} className="ml-2">
                          (browser may download instead of display — that&apos;s a Semrush storage header thing; thumbnail at left is the same image)
                        </span>
                      </div>
                    )}
                    {row.error_message && (
                      <div className="text-[10px] font-mono mt-1" style={{ color: "#f87171" }}>
                        {safeRenderable(row.error_message)}
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
