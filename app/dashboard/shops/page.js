"use client";

import { useState, useEffect, useRef } from "react";
import { useUser } from "../layout";
import { getBrandConfig } from "@/lib/data";

export default function ShopsPage() {
  const currentUser = useUser();
  const fileInputRef = useRef(null);
  const [shops, setShops] = useState([]);
  const [stats, setStats] = useState({ total: 0, matched: 0, unmatched: 0 });
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [toast, setToast] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [filter, setFilter] = useState("all"); // all, matched, unmatched
  const [searchTerm, setSearchTerm] = useState("");

  const showToast = (msg, isError) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 5000);
  };

  const fetchShops = () => {
    fetch("/api/shops")
      .then((r) => r.json())
      .then((data) => {
        setShops(data.shops || []);
        setStats({ total: data.total || 0, matched: data.matched || 0, unmatched: data.unmatched || 0 });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchShops();
  }, []);

  const handleFileSelect = async (file) => {
    if (!file) return;
    if (!file.name.endsWith(".csv")) {
      showToast("Please select a CSV file", true);
      return;
    }

    setImporting(true);
    setImportResult(null);

    try {
      const csvData = await file.text();

      // Get current locations for auto-matching
      const locRes = await fetch("/api/semrush/locations");
      const locData = await locRes.json();

      const res = await fetch("/api/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import",
          csvData,
          locations: locData.locations || [],
        }),
      });

      const result = await res.json();
      if (res.ok) {
        setImportResult(result);
        showToast(`Imported ${result.imported} shop numbers, matched ${result.matched} to Semrush locations`);
        fetchShops();
      } else {
        showToast(result.error || "Import failed", true);
      }
    } catch (error) {
      showToast("Import failed — " + error.message, true);
    }

    setImporting(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    handleFileSelect(file);
  };

  const handleReMatch = async () => {
    setMatching(true);
    try {
      const locRes = await fetch("/api/semrush/locations");
      const locData = await locRes.json();

      const res = await fetch("/api/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "match",
          locations: locData.locations || [],
        }),
      });

      const result = await res.json();
      if (res.ok) {
        showToast(`Re-matched: ${result.matched} matched, ${result.unmatched} unmatched`);
        fetchShops();
      }
    } catch {
      showToast("Re-match failed", true);
    }
    setMatching(false);
  };

  const handleClear = async () => {
    if (!confirm("Delete all shop number data? This cannot be undone.")) return;
    try {
      await fetch("/api/shops", { method: "DELETE" });
      showToast("All shop numbers cleared");
      fetchShops();
    } catch {}
  };

  // Filter and search
  const filteredShops = shops.filter((s) => {
    if (filter === "matched" && !s.semrush_location_id) return false;
    if (filter === "unmatched" && s.semrush_location_id) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      return (
        (s.shop_id && s.shop_id.toLowerCase().includes(term)) ||
        (s.street_address && s.street_address.toLowerCase().includes(term)) ||
        (s.city && s.city.toLowerCase().includes(term)) ||
        (s.brand && s.brand.toLowerCase().includes(term)) ||
        (s.phone && s.phone.includes(term))
      );
    }
    return true;
  });

  // Group by brand for summary
  const brandSummary = shops.reduce((acc, s) => {
    if (!acc[s.brand]) acc[s.brand] = { total: 0, matched: 0 };
    acc[s.brand].total++;
    if (s.semrush_location_id) acc[s.brand].matched++;
    return acc;
  }, {});

  if (currentUser?.role !== "admin") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-3xl mb-3">🔒</div>
          <h2 className="text-base font-bold text-white mb-1">Access Restricted</h2>
          <p className="text-sm" style={{ color: "#666" }}>Only admin users can manage shop numbers.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="flex items-center justify-center py-20"><span className="text-sm" style={{ color: "#666" }}>Loading shop numbers...</span></div>;
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
          <h2 className="text-lg font-bold text-white">Shop Numbers</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>Import and match shop IDs to Semrush locations</p>
        </div>
        <div className="flex gap-2">
          {stats.total > 0 && (
            <>
              <button onClick={handleReMatch} disabled={matching} className="px-3 py-1.5 rounded-md text-xs font-semibold" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa", opacity: matching ? 0.6 : 1 }}>
                {matching ? "Matching..." : "Re-Match All"}
              </button>
              <button onClick={handleClear} className="px-3 py-1.5 rounded-md text-xs font-semibold" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}>
                Clear All
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Total Shops", value: stats.total, color: "#e8e8e8" },
          { label: "Matched", value: stats.matched, color: "#34d399" },
          { label: "Unmatched", value: stats.unmatched, color: "#fbbf24" },
          { label: "Match Rate", value: stats.total > 0 ? `${Math.round((stats.matched / stats.total) * 100)}%` : "—", color: "#93c5fd" },
        ].map((stat) => (
          <div key={stat.label} className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{stat.label}</div>
            <div className="text-2xl font-bold mt-0.5" style={{ color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* CSV Upload area */}
      <div
        className="rounded-xl p-6 mb-5 text-center transition-colors cursor-pointer"
        style={{
          background: dragOver ? "#0c1a2e" : "#151517",
          border: `2px dashed ${dragOver ? "#93c5fd" : importing ? "#555" : "#2a2a2e"}`,
        }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !importing && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => handleFileSelect(e.target.files[0])}
        />
        {importing ? (
          <div>
            <div className="text-lg mb-2" style={{ color: "#93c5fd" }}>Importing...</div>
            <p className="text-xs" style={{ color: "#666" }}>Parsing CSV, importing to database, and auto-matching to Semrush locations</p>
          </div>
        ) : (
          <div>
            <div className="text-2xl mb-2">{stats.total > 0 ? "📋" : "📤"}</div>
            <div className="text-sm font-semibold text-white mb-1">
              {stats.total > 0 ? "Upload Updated CSV" : "Upload Shop Numbers CSV"}
            </div>
            <p className="text-xs" style={{ color: "#666" }}>
              Drag and drop your CSV here, or click to browse. Expected columns: Shop ID, Brand Name, Street Address, City, Phone, Website
            </p>
            {stats.total > 0 && (
              <p className="text-[10px] mt-2" style={{ color: "#555" }}>
                Re-importing will update existing records and add new ones (matched by Shop ID)
              </p>
            )}
          </div>
        )}
      </div>

      {/* Import results */}
      {importResult && (
        <div className="rounded-xl p-4 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: "#aaa" }}>Import Results</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="text-center">
              <div className="text-lg font-bold" style={{ color: "#34d399" }}>{importResult.imported}</div>
              <div className="text-[10px]" style={{ color: "#666" }}>Imported</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold" style={{ color: importResult.importErrors > 0 ? "#f87171" : "#34d399" }}>{importResult.importErrors}</div>
              <div className="text-[10px]" style={{ color: "#666" }}>Import Errors</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold" style={{ color: "#93c5fd" }}>{importResult.matched}</div>
              <div className="text-[10px]" style={{ color: "#666" }}>Auto-Matched</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold" style={{ color: importResult.unmatched > 0 ? "#fbbf24" : "#34d399" }}>{importResult.unmatched}</div>
              <div className="text-[10px]" style={{ color: "#666" }}>Unmatched</div>
            </div>
          </div>
          {importResult.unmatchedIds && importResult.unmatchedIds.length > 0 && (
            <div className="mt-3 p-3 rounded" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
              <div className="text-[10px] font-semibold mb-1" style={{ color: "#fbbf24" }}>
                Unmatched Shop IDs (first {Math.min(importResult.unmatchedIds.length, 50)}):
              </div>
              <div className="text-[10px] font-mono" style={{ color: "#888" }}>
                {importResult.unmatchedIds.join(", ")}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Brand summary */}
      {Object.keys(brandSummary).length > 0 && (
        <div className="rounded-xl p-4 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <h4 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: "#aaa" }}>By Brand</h4>
          <div className="flex flex-wrap gap-2">
            {Object.entries(brandSummary)
              .sort((a, b) => b[1].total - a[1].total)
              .map(([brandId, data]) => {
                const config = getBrandConfig(brandId);
                const pct = data.total > 0 ? Math.round((data.matched / data.total) * 100) : 0;
                return (
                  <div key={brandId} className="px-3 py-2 rounded-lg" style={{ background: config.color + "10", border: `1px solid ${config.color}30` }}>
                    <div className="text-xs font-semibold" style={{ color: config.color }}>{config.name}</div>
                    <div className="text-[10px] mt-0.5" style={{ color: "#888" }}>
                      {data.matched}/{data.total} matched ({pct}%)
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Shop numbers list */}
      {stats.total > 0 && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by shop ID, address, city, brand..."
              className="flex-1 px-3 py-2 rounded-md text-xs"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
            />
            {["all", "matched", "unmatched"].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="px-3 py-2 rounded-md text-[11px] font-semibold capitalize"
                style={{
                  background: filter === f ? "#1c1c1f" : "transparent",
                  border: `1px solid ${filter === f ? "#2a2a2e" : "transparent"}`,
                  color: filter === f ? "#ddd" : "#666",
                }}
              >
                {f} {f === "all" ? `(${stats.total})` : f === "matched" ? `(${stats.matched})` : `(${stats.unmatched})`}
              </button>
            ))}
          </div>

          <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            {/* Header */}
            <div className="hidden sm:grid items-center px-4 py-2.5" style={{ gridTemplateColumns: "80px 100px 1.2fr 0.8fr 0.6fr 0.6fr 60px", borderBottom: "1px solid #1e1e22" }}>
              {["Shop ID", "Brand", "Address", "City, State", "Phone", "Website", "Status"].map((h) => (
                <span key={h} className="text-[10px] font-bold tracking-widest uppercase" style={{ color: "#555" }}>{h}</span>
              ))}
            </div>

            {/* Rows */}
            {filteredShops.slice(0, 100).map((shop, i) => {
              const config = getBrandConfig(shop.brand);
              const isMatched = !!shop.semrush_location_id;
              return (
                <div key={shop.shop_id} className="hidden sm:grid items-center px-4 py-2.5" style={{ gridTemplateColumns: "80px 100px 1.2fr 0.8fr 0.6fr 0.6fr 60px", borderBottom: i < filteredShops.length - 1 ? "1px solid #1a1a1d" : "none", background: i % 2 === 0 ? "#151517" : "#131315" }}>
                  <span className="text-xs font-mono font-semibold" style={{ color: "#93c5fd" }}>{shop.shop_id}</span>
                  <span className="text-[10px] font-semibold truncate" style={{ color: config.color }}>{config.name}</span>
                  <span className="text-xs truncate" style={{ color: "#888" }}>{shop.street_address}{shop.address2 ? `, ${shop.address2}` : ""}</span>
                  <span className="text-xs truncate" style={{ color: "#888" }}>{shop.city}, {shop.state}</span>
                  <span className="text-[11px] font-mono" style={{ color: "#777" }}>{shop.phone || "—"}</span>
                  <span className="text-[10px] truncate" style={{ color: "#555" }}>{shop.website ? "✓" : "—"}</span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-center" style={{ background: isMatched ? "#0d281820" : "#2d1b0020", color: isMatched ? "#34d399" : "#fbbf24" }}>
                    {isMatched ? "Linked" : "—"}
                  </span>
                </div>
              );
            })}

            {filteredShops.length > 100 && (
              <div className="py-3 text-center text-[11px]" style={{ color: "#555" }}>
                Showing first 100 of {filteredShops.length} results
              </div>
            )}

            {filteredShops.length === 0 && (
              <div className="py-8 text-center text-sm" style={{ color: "#555" }}>
                No shop numbers match your search
              </div>
            )}
          </div>
        </>
      )}

      {/* Help text */}
      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <h4 className="text-xs font-bold mb-2" style={{ color: "#aaa" }}>How It Works</h4>
        <div className="text-xs leading-relaxed space-y-1.5" style={{ color: "#777" }}>
          <p>1. Upload your CSV with Shop ID, Brand Name, Street Address, City, Phone, and Website columns.</p>
          <p>2. The system imports all records and auto-matches them to Semrush locations using three strategies: shop ID found in the location's URL (strongest), phone number match, or street address + city match.</p>
          <p>3. Matched shop numbers appear as a blue badge in the location table and edit modal. You can search by shop ID from the main dashboard.</p>
          <p>4. Use "Re-Match All" after adding new locations in Semrush to pick up any previously unmatched shops.</p>
          <p>5. Re-importing the same CSV updates existing records without creating duplicates (matched by Shop ID).</p>
        </div>
      </div>
    </>
  );
}
