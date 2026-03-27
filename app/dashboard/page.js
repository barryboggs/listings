"use client";

import { useState, useMemo, useEffect } from "react";
import EditModal from "@/components/EditModal";
import BulkModal from "@/components/BulkModal";

function StatusBadge({ status }) {
  const styles = {
    active: { bg: "#0d2818", color: "#34d399", label: "Active" },
    temp_closed: { bg: "#2d1b00", color: "#fbbf24", label: "Temp Closed" },
  };
  const s = styles[status] || styles.active;
  return (
    <span className="px-2.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide" style={{ background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}

function HoursBadge({ hoursStatus }) {
  const map = {
    standard: { icon: "●", color: "#34d399", label: "Standard" },
    holiday: { icon: "◆", color: "#a78bfa", label: "Holiday" },
    modified: { icon: "▲", color: "#fbbf24", label: "Modified" },
    closed: { icon: "■", color: "#f87171", label: "Closed" },
  };
  const h = map[hoursStatus] || map.standard;
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: h.color }}>
      <span className="text-[8px]">{h.icon}</span> {h.label}
    </span>
  );
}

export default function LocationsPage() {
  const [activeBrands, setActiveBrands] = useState(null); // null until loaded
  const [search, setSearch] = useState("");
  const [editingLocation, setEditingLocation] = useState(null);
  const [bulkBrand, setBulkBrand] = useState(null);
  const [toast, setToast] = useState(null);
  const [locations, setLocations] = useState([]);
  const [brands, setBrands] = useState([]);
  const [dataSource, setDataSource] = useState("loading");
  const [loading, setLoading] = useState(true);

  // Fetch locations from API proxy (which hits Semrush if token is set)
  const fetchLocations = async () => {
    try {
      const res = await fetch("/api/semrush/locations");
      const data = await res.json();
      setLocations(data.locations || []);
      setBrands(data.brands || []);
      setDataSource(data.source || "unknown");
      // First load: activate all brands
      if (!activeBrands && data.brands) {
        setActiveBrands(new Set(data.brands.map((b) => b.id)));
      }
    } catch {
      setDataSource("error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLocations();
  }, []);

  const toggleBrand = (id) => {
    const next = new Set(activeBrands);
    next.has(id) ? next.delete(id) : next.add(id);
    if (next.size > 0) setActiveBrands(next);
  };

  const filteredLocations = useMemo(() => {
    if (!activeBrands) return [];
    return locations.filter(
      (loc) =>
        activeBrands.has(loc.brand) &&
        (search === "" ||
          loc.name.toLowerCase().includes(search.toLowerCase()) ||
          loc.city.toLowerCase().includes(search.toLowerCase()) ||
          loc.state.toLowerCase().includes(search.toLowerCase()) ||
          loc.zip.includes(search))
    );
  }, [activeBrands, search, locations]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  // Save handler — calls the API proxy, then refreshes locations
  const handleSave = async (locationData) => {
    setEditingLocation(null);
    try {
      const res = await fetch(`/api/semrush/locations/${locationData.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(locationData),
      });
      const result = await res.json();
      if (result.success) {
        showToast(
          result.source === "semrush"
            ? "Location updated — pushed to Semrush API"
            : "Location updated (demo mode)"
        );
        fetchLocations(); // Refresh data
      } else {
        showToast(`Error: ${result.error || "Update failed"}`);
      }
    } catch {
      showToast("Network error — please try again");
    }
  };

  // Bulk save handler
  const handleBulkSave = async (data) => {
    setBulkBrand(null);
    try {
      const res = await fetch("/api/semrush/bulk-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (result.success) {
        showToast(
          result.source === "semrush"
            ? `Bulk update pushed — ${result.updated} locations updated`
            : `Bulk update complete — ${data.locationIds.length} locations (demo mode)`
        );
        fetchLocations();
      } else {
        showToast(`Bulk update had ${result.failed} errors`);
      }
    } catch {
      showToast("Network error — please try again");
    }
  };

  return (
    <>
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-slide-up px-5 py-3 rounded-lg text-sm font-medium flex items-center gap-2" style={{ background: "#1a2e1a", border: "1px solid #2d5a2d", color: "#6ee7b7" }}>
          <span>✓</span> {toast}
        </div>
      )}

      {/* Data source banner */}
      {dataSource === "demo" && !loading && (
        <div className="mb-4 px-4 py-2.5 rounded-lg text-xs flex items-center gap-2" style={{ background: "#2d1b0030", border: "1px solid #fbbf2430", color: "#fbbf24" }}>
          <span>⚠</span>
          <span className="font-semibold">Demo Mode</span>
          <span style={{ color: "#fbbf24aa" }}>— Set SEMRUSH_BEARER_TOKEN in .env.local to pull live data</span>
        </div>
      )}
      {dataSource === "semrush" && !loading && (
        <div className="mb-4 px-4 py-2.5 rounded-lg text-xs flex items-center gap-2" style={{ background: "#0d281830", border: "1px solid #2d5a2d30", color: "#34d399" }}>
          <span className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: "#34d399" }} />
          <span className="font-semibold">Live</span>
          <span style={{ color: "#34d399aa" }}>— Pulling from Semrush Listing Management API</span>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-sm" style={{ color: "#666" }}>Fetching locations...</div>
        </div>
      )}

      {!loading && (
        <>
      {/* Summary row */}
      <div className="flex gap-3 mb-5 flex-wrap">
        {brands.map((b) => (
          <div key={b.id} className="px-4 py-3 rounded-lg flex-1 min-w-[160px]" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-sm" style={{ background: b.color }} />
              <span className="text-[11px] font-semibold" style={{ color: "#888" }}>{b.name}</span>
            </div>
            <div className="text-xl font-bold text-white">{b.locationCount}</div>
          </div>
        ))}
      </div>

      {/* Brand filters + Search */}
      <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <div className="flex gap-2 flex-wrap">
          {brands.map((b) => {
            const active = activeBrands?.has(b.id);
            return (
              <button
                key={b.id}
                onClick={() => toggleBrand(b.id)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-md text-xs font-semibold transition-colors"
                style={{
                  background: active ? b.color + "18" : "transparent",
                  border: `1.5px solid ${active ? b.color : "#2a2a2e"}`,
                  color: active ? b.color : "#888",
                }}
              >
                <span className="w-2 h-2 rounded-sm" style={{ background: b.color }} />
                {b.name}
              </button>
            );
          })}
        </div>
        <input
          placeholder="Search by name, city, state, or ZIP..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3.5 py-2 rounded-md text-xs w-64"
          style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
        />
      </div>

      {/* Bulk action row */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {brands.filter((b) => activeBrands?.has(b.id)).map((b) => (
          <button
            key={b.id}
            onClick={() => setBulkBrand(b.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium transition-colors"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
          >
            <span className="w-1.5 h-1.5 rounded-sm" style={{ background: b.color }} />
            Bulk Update {b.name}
          </button>
        ))}
      </div>

      {/* Locations table */}
      <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        {/* Header */}
        <div
          className="hidden lg:grid items-center px-4 py-2.5"
          style={{
            gridTemplateColumns: "4px 1.4fr 1fr 0.65fr 0.55fr 0.6fr 0.55fr 72px",
            borderBottom: "1px solid #1e1e22",
          }}
        >
          <span />
          {["Location", "Address", "Phone", "Status", "Hours", "Updated", ""].map((h, i) => (
            <span key={i} className="text-[10px] font-bold tracking-widest uppercase" style={{ color: "#555" }}>
              {h}
            </span>
          ))}
        </div>

        {/* Rows */}
        {filteredLocations.map((loc, i) => {
          const brandColor = brands.find((b) => b.id === loc.brand)?.color || "#666";
          return (
            <div
              key={loc.id}
              onClick={() => setEditingLocation(loc)}
              className="cursor-pointer transition-colors hover:bg-[#1a1a1d]"
              style={{
                borderBottom: i < filteredLocations.length - 1 ? "1px solid #1a1a1d" : "none",
              }}
            >
              {/* Desktop row */}
              <div
                className="hidden lg:grid items-center px-4 py-3"
                style={{ gridTemplateColumns: "4px 1.4fr 1fr 0.65fr 0.55fr 0.6fr 0.55fr 72px" }}
              >
                <span className="w-[3px] h-7 rounded" style={{ background: brandColor }} />
                <span className="text-sm font-semibold text-white truncate pr-2">{loc.name}</span>
                <span className="text-xs truncate" style={{ color: "#888" }}>{loc.city}, {loc.state} {loc.zip}</span>
                <span className="text-xs font-mono" style={{ color: "#aaa" }}>{loc.phone}</span>
                <StatusBadge status={loc.status} />
                <HoursBadge hoursStatus={loc.hoursStatus} />
                <span className="text-[11px]" style={{ color: "#666" }}>{loc.lastUpdated}</span>
                <button className="px-2.5 py-1 rounded text-[11px] font-semibold" style={{ background: "#222", border: "1px solid #2a2a2e", color: "#888" }}>
                  Edit
                </button>
              </div>

              {/* Mobile row */}
              <div className="lg:hidden p-4 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-[3px] h-5 rounded" style={{ background: brandColor }} />
                  <span className="text-sm font-semibold text-white">{loc.name}</span>
                </div>
                <div className="flex items-center gap-3 text-xs" style={{ color: "#888" }}>
                  <span>{loc.city}, {loc.state}</span>
                  <span>{loc.phone}</span>
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge status={loc.status} />
                  <HoursBadge hoursStatus={loc.hoursStatus} />
                </div>
              </div>
            </div>
          );
        })}

        {filteredLocations.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: "#555" }}>
            No locations match your filters
          </div>
        )}
      </div>

      <div className="mt-2.5 text-[11px] text-right" style={{ color: "#444" }}>
        Showing {filteredLocations.length} of {locations.length} locations
        {dataSource === "demo" && " (demo data)"}
      </div>

      {/* Modals */}
      {editingLocation && (
        <EditModal
          location={editingLocation}
          brands={brands}
          onClose={() => setEditingLocation(null)}
          onSave={handleSave}
        />
      )}
      {bulkBrand && (
        <BulkModal
          brandId={bulkBrand}
          brands={brands}
          locations={locations}
          onClose={() => setBulkBrand(null)}
          onSave={handleBulkSave}
        />
      )}
      </>
      )}
    </>
  );
}
