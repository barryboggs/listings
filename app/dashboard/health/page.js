"use client";

import { useEffect, useMemo, useState } from "react";
import EditModal from "@/components/EditModal";

/**
 * Listing Health page.
 *
 * Filters the full location list to those with sync errors reported by
 * Semrush and surfaces them as a sortable triage view. Clicking a row
 * opens EditModal directly to the Errors tab.
 *
 * The data is the same `semrushErrors` array exposed by /api/semrush/locations
 * — every row in the locations list already carries it. This page just
 * promotes it from a hidden-behind-modal detail to a first-class view so
 * problem locations are visible without having to open them one by one.
 */
export default function HealthPage() {
  const [locations, setLocations] = useState([]);
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [sortBy, setSortBy] = useState("errors"); // errors | brand | name | state
  const [brandFilter, setBrandFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState(null);

  const fetchLocations = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/semrush/locations");
      const data = await res.json();
      setLocations(data.locations || []);
      setBrands(data.brands || []);
    } catch {
      // best-effort — leave whatever's loaded
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLocations();
  }, []);

  // Filter + sort. Recomputed when any input changes.
  const errored = useMemo(() => {
    const withErrors = (locations || []).filter(
      (l) => Array.isArray(l.semrushErrors) && l.semrushErrors.length > 0
    );
    const filtered = withErrors.filter((l) => {
      if (brandFilter !== "all" && l.brand !== brandFilter) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        (l.name || "").toLowerCase().includes(q) ||
        (l.city || "").toLowerCase().includes(q) ||
        (l.state || "").toLowerCase().includes(q) ||
        (l.zip || "").includes(search) ||
        (l.shopId && l.shopId.toString().includes(search))
      );
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case "errors":
          return (b.semrushErrors?.length || 0) - (a.semrushErrors?.length || 0);
        case "brand":
          return (a.brand || "").localeCompare(b.brand || "");
        case "state":
          return (a.state || "").localeCompare(b.state || "") || (a.city || "").localeCompare(b.city || "");
        case "name":
          return (a.name || "").localeCompare(b.name || "");
        default:
          return 0;
      }
    });
    return sorted;
  }, [locations, brandFilter, search, sortBy]);

  const totalErrors = errored.reduce((acc, l) => acc + (l.semrushErrors?.length || 0), 0);
  const showToast = (msg) => {
    setToast(msg);
  };

  // The edit save flow mirrors the main locations page — push to old API,
  // re-fetch on success so the row drops off this list if errors are cleared.
  const handleSave = async (locationData, meta = {}) => {
    setEditing(null);
    const richCount = meta.richFieldsUpdated || 0;
    const richSuffix = richCount > 0 ? ` + ${richCount} extra field${richCount === 1 ? "" : "s"}` : "";
    try {
      const res = await fetch(`/api/semrush/locations/${locationData.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(locationData),
      });
      const result = await res.json();
      if (result.success) {
        showToast(`Saved${richSuffix} — refreshing health view…`);
        fetchLocations();
      } else if (richCount > 0) {
        showToast(`Extras saved, but core update failed: ${result.error || "Update failed"}`);
      } else {
        showToast(`Error: ${result.error || "Update failed"}`);
      }
    } catch {
      showToast("Network error — please try again");
    }
  };

  return (
    <>
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-slide-up px-5 py-3 rounded-lg text-sm font-medium flex items-start gap-3 max-w-lg" style={{ background: "#1a2e1a", border: "1px solid #2d5a2d", color: "#6ee7b7" }}>
          <span className="flex-shrink-0 mt-0.5">✓</span>
          <span className="flex-1">{toast}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="flex-shrink-0 opacity-60 hover:opacity-100" style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}>×</button>
        </div>
      )}

      <div className="flex flex-wrap justify-between items-baseline gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">Listing Health</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>
            Locations with sync errors reported by Semrush. Click a row to view and fix.
          </p>
        </div>
        {!loading && (
          <div className="flex gap-3 items-baseline">
            <div className="text-right">
              <div className="text-2xl font-bold" style={{ color: errored.length > 0 ? "#f87171" : "#34d399" }}>{errored.length}</div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "#888" }}>Locations</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold" style={{ color: totalErrors > 0 ? "#fbbf24" : "#34d399" }}>{totalErrors}</div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "#888" }}>Total Errors</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-white">{locations.length}</div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "#888" }}>All Locations</div>
            </div>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-sm" style={{ color: "#666" }}>Loading…</div>
        </div>
      )}

      {!loading && (
        <>
          {/* Filter row */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <select
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              className="px-3 py-2 rounded-md text-xs"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
            >
              <option value="all">All brands</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="px-3 py-2 rounded-md text-xs"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
            >
              <option value="errors"># of errors (desc)</option>
              <option value="brand">Brand</option>
              <option value="state">State / city</option>
              <option value="name">Location name</option>
            </select>
            <input
              placeholder="Search shop #, name, city, state, or ZIP…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ml-auto px-3 py-2 rounded-md text-xs w-72"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
            />
          </div>

          {errored.length === 0 ? (
            <div className="rounded-xl py-16 text-center" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
              <div className="text-2xl mb-2">✓</div>
              <h3 className="text-sm font-semibold text-white mb-1">No sync errors</h3>
              <p className="text-xs" style={{ color: "#666" }}>
                {brandFilter !== "all" || search
                  ? "No errors match the current filters."
                  : "Every location returned by Semrush is reporting clean. Nice."}
              </p>
            </div>
          ) : (
            <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
              <div
                className="hidden lg:grid items-center px-4 py-2.5"
                style={{
                  gridTemplateColumns: "4px 0.45fr 1.1fr 0.7fr 0.4fr 1.4fr 72px",
                  borderBottom: "1px solid #1e1e22",
                }}
              >
                <span />
                {["Shop #", "Location", "City, State", "# Errors", "First Error", ""].map((h, i) => (
                  <span key={i} className="text-[10px] font-bold tracking-widest uppercase" style={{ color: "#555" }}>{h}</span>
                ))}
              </div>

              {errored.map((loc, i) => {
                const brandColor = brands.find((b) => b.id === loc.brand)?.color || "#666";
                const errorCount = loc.semrushErrors?.length || 0;
                const firstError = loc.semrushErrors?.[0];
                return (
                  <div
                    key={loc.id}
                    onClick={() => setEditing(loc)}
                    className="cursor-pointer transition-colors hover:bg-[#1a1a1d]"
                    style={{ borderBottom: i < errored.length - 1 ? "1px solid #1a1a1d" : "none" }}
                  >
                    {/* Desktop row */}
                    <div
                      className="hidden lg:grid items-center px-4 py-3"
                      style={{ gridTemplateColumns: "4px 0.45fr 1.1fr 0.7fr 0.4fr 1.4fr 72px" }}
                    >
                      <span className="w-[3px] h-7 rounded" style={{ background: brandColor }} />
                      <span className="text-xs font-mono font-semibold" style={{ color: loc.shopId ? "#93c5fd" : "#333" }}>
                        {loc.shopId || "—"}
                      </span>
                      <span className="text-sm font-semibold text-white truncate pr-2">{loc.name}</span>
                      <span className="text-xs truncate" style={{ color: "#888" }}>{loc.city}, {loc.state}</span>
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold" style={{ color: "#f87171" }}>
                        <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a" }}>{errorCount}</span>
                      </span>
                      <span className="text-[11px] truncate" style={{ color: "#bbb" }}>
                        {firstError ? (
                          <>
                            <span className="font-mono px-1.5 py-0.5 rounded text-[10px] mr-1.5" style={{ background: "#2d0a0a", color: "#f87171" }}>{firstError.code}</span>
                            {firstError.message}
                          </>
                        ) : "—"}
                      </span>
                      <button className="px-2.5 py-1 rounded text-[11px] font-semibold" style={{ background: "#222", border: "1px solid #2a2a2e", color: "#888" }}>
                        Fix
                      </button>
                    </div>

                    {/* Mobile row */}
                    <div className="lg:hidden p-4 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-[3px] h-5 rounded" style={{ background: brandColor }} />
                        {loc.shopId && (
                          <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded" style={{ background: "#0c1a2e", color: "#93c5fd" }}>
                            #{loc.shopId}
                          </span>
                        )}
                        <span className="text-sm font-semibold text-white">{loc.name}</span>
                        <span className="w-4 h-4 ml-auto rounded-full flex items-center justify-center text-[9px] font-bold" style={{ background: "#2d0a0a", color: "#f87171", border: "1px solid #5c1a1a" }}>
                          {errorCount}
                        </span>
                      </div>
                      <div className="text-[11px]" style={{ color: "#888" }}>{loc.city}, {loc.state}</div>
                      {firstError && (
                        <div className="flex items-center gap-1.5 text-[11px]">
                          <span className="font-mono px-1.5 py-0.5 rounded text-[10px]" style={{ background: "#2d0a0a", color: "#f87171" }}>{firstError.code}</span>
                          <span className="truncate" style={{ color: "#bbb" }}>{firstError.message}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-2.5 text-[11px] text-right" style={{ color: "#444" }}>
            Showing {errored.length} of {locations.filter((l) => Array.isArray(l.semrushErrors) && l.semrushErrors.length > 0).length} errored locations
          </div>
        </>
      )}

      {editing && (
        <EditModal
          location={editing}
          brands={brands}
          onClose={() => setEditing(null)}
          onSave={handleSave}
          initialTab="errors"
        />
      )}
    </>
  );
}
