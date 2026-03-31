"use client";

import { useState, useRef } from "react";
import { useUser } from "../layout";

export default function HolidayImportPage() {
  const currentUser = useUser();
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [pushResult, setPushResult] = useState(null);
  const [toast, setToast] = useState(null);
  const [csvData, setCsvData] = useState(null);

  const showToast = (msg, isError) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 5000);
  };

  const handleFileSelect = async (file) => {
    if (!file) return;
    if (!file.name.endsWith(".csv")) {
      showToast("Please select a CSV file", true);
      return;
    }

    setLoading(true);
    setPreview(null);
    setPushResult(null);

    try {
      const text = await file.text();
      setCsvData(text);

      // Get locations for matching
      const locRes = await fetch("/api/semrush/locations");
      const locData = await locRes.json();

      // Dry run to preview
      const res = await fetch("/api/holiday-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvData: text,
          locations: locData.locations || [],
          dryRun: true,
        }),
      });

      const result = await res.json();
      if (res.ok) {
        setPreview(result);
      } else {
        showToast(result.error || "Failed to parse CSV", true);
      }
    } catch (error) {
      showToast("Failed to process file: " + error.message, true);
    }

    setLoading(false);
  };

  const handlePush = async () => {
    if (!csvData) return;
    setPushing(true);
    setPushResult(null);

    try {
      const locRes = await fetch("/api/semrush/locations");
      const locData = await locRes.json();

      const res = await fetch("/api/holiday-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvData,
          locations: locData.locations || [],
          dryRun: false,
        }),
      });

      const result = await res.json();
      if (res.ok) {
        setPushResult(result);
        showToast(`Pushed holiday hours to ${result.pushed} locations`);
      } else {
        showToast(result.error || "Push failed", true);
      }
    } catch (error) {
      showToast("Push failed: " + error.message, true);
    }

    setPushing(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFileSelect(e.dataTransfer.files[0]);
  };

  const reset = () => {
    setPreview(null);
    setPushResult(null);
    setCsvData(null);
  };

  return (
    <>
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-slide-up px-5 py-3 rounded-lg text-sm font-medium flex items-center gap-2" style={{ background: toast.isError ? "#2d0a0a" : "#1a2e1a", border: `1px solid ${toast.isError ? "#5c1a1a" : "#2d5a2d"}`, color: toast.isError ? "#f87171" : "#6ee7b7" }}>
          <span>{toast.isError ? "✗" : "✓"}</span> {toast.msg}
        </div>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">Holiday Hours Import</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>Upload a CSV to bulk-update holiday hours across locations</p>
        </div>
        {(preview || pushResult) && (
          <button onClick={reset} className="px-3 py-1.5 rounded-md text-xs font-semibold" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}>
            Upload New File
          </button>
        )}
      </div>

      {/* Upload area — shown when no preview yet */}
      {!preview && !pushResult && (
        <div
          className="rounded-xl p-8 mb-5 text-center transition-colors cursor-pointer"
          style={{
            background: dragOver ? "#0c1a2e" : "#151517",
            border: `2px dashed ${dragOver ? "#93c5fd" : loading ? "#555" : "#2a2a2e"}`,
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !loading && fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={(e) => handleFileSelect(e.target.files[0])} />
          {loading ? (
            <div>
              <div className="text-lg mb-2" style={{ color: "#93c5fd" }}>Processing...</div>
              <p className="text-xs" style={{ color: "#666" }}>Parsing CSV, matching shop IDs to Semrush locations</p>
            </div>
          ) : (
            <div>
              <div className="text-3xl mb-3">📅</div>
              <div className="text-sm font-semibold text-white mb-1">Upload Holiday Hours CSV</div>
              <p className="text-xs" style={{ color: "#666" }}>
                Drag and drop your CSV here, or click to browse
              </p>
              <p className="text-[10px] mt-2" style={{ color: "#555" }}>
                Expected columns: Franchise ID, Holiday (date), Holiday Open, Holiday Close. Optionally: Holiday 2, Holiday Open 2, Holiday Close 2
              </p>
            </div>
          )}
        </div>
      )}

      {/* Preview results */}
      {preview && !pushResult && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {[
              { label: "CSV Rows", value: preview.total, color: "#e8e8e8" },
              { label: "Matched to Semrush", value: preview.matched, color: "#34d399" },
              { label: "Unmatched", value: preview.unmatched, color: preview.unmatched > 0 ? "#fbbf24" : "#34d399" },
              { label: "Closed", value: preview.closed, color: "#f87171" },
            ].map((stat) => (
              <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
                <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
                <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
            <div className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
              <div className="text-[11px] font-semibold" style={{ color: "#888" }}>Special Hours</div>
              <div className="text-2xl font-bold mt-0.5" style={{ color: "#93c5fd" }}>{preview.specialHours}</div>
            </div>
            <div className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
              <div className="text-[11px] font-semibold" style={{ color: "#888" }}>Second Holiday</div>
              <div className="text-2xl font-bold mt-0.5" style={{ color: "#a78bfa" }}>{preview.holiday2Count}</div>
            </div>
            <div className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
              <div className="text-[11px] font-semibold" style={{ color: "#888" }}>Updates to Push</div>
              <div className="text-2xl font-bold mt-0.5" style={{ color: "#34d399" }}>{preview.updates?.length || 0}</div>
            </div>
          </div>

          {/* Unmatched warning */}
          {preview.unmatched > 0 && (
            <div className="rounded-xl p-4 mb-5" style={{ background: "#2d1b0020", border: "1px solid #8b6b2040" }}>
              <div className="text-xs font-semibold mb-1" style={{ color: "#fbbf24" }}>
                {preview.unmatched} shops could not be matched to Semrush locations
              </div>
              <div className="text-[10px] font-mono" style={{ color: "#888" }}>
                {(preview.unmatchedIds || []).join(", ")}
              </div>
              <p className="text-[10px] mt-1.5" style={{ color: "#666" }}>
                These shop IDs don't exist in the Shop Numbers database or aren't linked to a Semrush location. Import shop numbers first on the Shop Numbers page.
              </p>
            </div>
          )}

          {/* Preview table */}
          <div className="rounded-xl overflow-hidden mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="px-4 py-3" style={{ borderBottom: "1px solid #1e1e22" }}>
              <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: "#aaa" }}>
                Preview — First 20 Updates
              </h4>
            </div>
            {(preview.preview || []).map((update, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-4" style={{ borderBottom: "1px solid #1a1a1d", background: i % 2 === 0 ? "#151517" : "#131315" }}>
                <span className="text-xs font-mono font-semibold w-16" style={{ color: "#93c5fd" }}>#{update.shopId}</span>
                <span className="text-xs text-white truncate flex-1">{update.locationName}</span>
                <span className="text-[11px]" style={{ color: "#888" }}>{update.city}, {update.state}</span>
                <div className="flex gap-1.5">
                  {update.holidayHours.map((hh, j) => (
                    <span key={j} className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{
                      background: hh.type === "CLOSED" ? "#2d0a0a20" : "#0d281820",
                      color: hh.type === "CLOSED" ? "#f87171" : "#34d399",
                      border: `1px solid ${hh.type === "CLOSED" ? "#5c1a1a40" : "#2d5a2d40"}`,
                    }}>
                      {hh.day}: {hh.type === "CLOSED" ? "Closed" : `${hh.times[0].from}–${hh.times[0].to}`}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Push button */}
          <div className="flex items-center justify-between p-5 rounded-xl" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div>
              <div className="text-sm font-semibold text-white">Ready to push {preview.updates?.length || 0} holiday hour updates</div>
              <p className="text-[10px] mt-0.5" style={{ color: "#666" }}>
                This will push to Semrush in batches of 50 locations. Rate limit: 5 bulk requests per minute (12s between batches). Estimated time: ~{Math.ceil(Math.ceil((preview.updates?.length || 0) / 50) * 12 / 60)} minutes for {Math.ceil((preview.updates?.length || 0) / 50)} batches.
              </p>
            </div>
            <button
              onClick={handlePush}
              disabled={pushing || (preview.updates?.length || 0) === 0}
              className="px-6 py-2.5 rounded-md text-sm font-semibold text-white transition-opacity"
              style={{ background: "#E31837", opacity: pushing ? 0.6 : 1 }}
            >
              {pushing ? `Pushing... (this may take a few minutes)` : `Push to Semrush`}
            </button>
          </div>
        </>
      )}

      {/* Push results */}
      {pushResult && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Pushed Successfully", value: pushResult.pushed, color: "#34d399" },
              { label: "Push Errors", value: pushResult.pushErrors, color: pushResult.pushErrors > 0 ? "#f87171" : "#34d399" },
              { label: "Batches Sent", value: pushResult.batches || "—", color: "#93c5fd" },
              { label: "Unmatched", value: pushResult.unmatched, color: pushResult.unmatched > 0 ? "#fbbf24" : "#34d399" },
            ].map((stat) => (
              <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
                <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
                <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
              </div>
            ))}
          </div>

          {pushResult.errors && pushResult.errors.length > 0 && (
            <div className="rounded-xl p-4" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40" }}>
              <h4 className="text-xs font-bold mb-2" style={{ color: "#f87171" }}>Errors (first 10)</h4>
              {pushResult.errors.map((err, i) => (
                <div key={i} className="text-[11px] py-1" style={{ color: "#888" }}>
                  <span className="font-mono" style={{ color: "#93c5fd" }}>#{err.shopId}</span>: {err.error}
                </div>
              ))}
            </div>
          )}

          <div className="p-4 rounded-xl" style={{ background: "#0d281830", border: "1px solid #2d5a2d40" }}>
            <p className="text-xs" style={{ color: "#34d399" }}>
              Holiday hours have been pushed to Semrush. Changes will propagate to directories within 24–72 hours.
            </p>
          </div>
        </div>
      )}

      {/* Help text */}
      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <h4 className="text-xs font-bold mb-2" style={{ color: "#aaa" }}>CSV Format</h4>
        <div className="text-xs leading-relaxed space-y-1" style={{ color: "#777" }}>
          <p><strong style={{ color: "#aaa" }}>Required:</strong> Franchise ID (shop number), Holiday (date like 4/5/2026), Holiday Open, Holiday Close</p>
          <p><strong style={{ color: "#aaa" }}>Optional:</strong> Holiday 2, Holiday Open 2, Holiday Close 2 (for a second holiday date)</p>
          <p><strong style={{ color: "#aaa" }}>Closed:</strong> Set Holiday Open and Holiday Close to "Close" or "CLOSED"</p>
          <p><strong style={{ color: "#aaa" }}>Special hours:</strong> Use time format like "9:00:00 AM" or "5:00:00 PM"</p>
          <p><strong style={{ color: "#aaa" }}>Matching:</strong> Franchise ID must match a shop number already imported on the Shop Numbers page</p>
        </div>
      </div>
    </>
  );
}
