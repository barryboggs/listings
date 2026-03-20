"use client";

import { useState } from "react";
import { BRANDS, LOCATIONS } from "@/lib/data";

export default function BulkModal({ brandId, onClose, onSave }) {
  const brandData = BRANDS.find((b) => b.id === brandId);
  const brandColor = brandData?.color || "#888";
  const brandLocations = LOCATIONS.filter((l) => l.brand === brandId);

  const [bulkField, setBulkField] = useState("hours");
  const [selected, setSelected] = useState(new Set(brandLocations.map((l) => l.id)));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const toggleLocation = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    setSelected(
      selected.size === brandLocations.length
        ? new Set()
        : new Set(brandLocations.map((l) => l.id))
    );
  };

  const handleSave = () => {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      setSaved(true);
      setTimeout(() => {
        onSave({ field: bulkField, locationIds: Array.from(selected) });
      }, 600);
    }, 2000);
  };

  const FIELDS = ["hours", "phone", "website", "temp_closure", "holiday_hours"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="animate-fade-scale w-full max-w-[580px] max-h-[80vh] flex flex-col rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
        {/* Header */}
        <div className="px-6 py-5 flex justify-between items-start" style={{ borderBottom: "1px solid #2a2a2e" }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: brandColor }} />
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#888" }}>
                Bulk Update
              </span>
            </div>
            <h3 className="text-base font-semibold text-white">
              {brandData?.name} — {selected.size} locations selected
            </h3>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-sm" style={{ background: "#222", border: "1px solid #333", color: "#888" }}>
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          <span className="text-xs block mb-2.5" style={{ color: "#888" }}>Field to update</span>
          <div className="flex gap-1.5 flex-wrap mb-5">
            {FIELDS.map((f) => (
              <button
                key={f}
                onClick={() => setBulkField(f)}
                className="px-3 py-1.5 rounded text-[11px] font-semibold capitalize transition-colors"
                style={{
                  background: bulkField === f ? brandColor + "18" : "#1c1c1f",
                  border: `1px solid ${bulkField === f ? brandColor + "60" : "#2a2a2e"}`,
                  color: bulkField === f ? brandColor : "#888",
                }}
              >
                {f.replace(/_/g, " ")}
              </button>
            ))}
          </div>

          {/* Bulk value input */}
          {bulkField === "phone" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                New Phone Number
              </label>
              <input placeholder="(XXX) XXX-XXXX" className="w-full px-3 py-2.5 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }} />
            </div>
          )}
          {bulkField === "website" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                New Website URL
              </label>
              <input placeholder="https://..." className="w-full px-3 py-2.5 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }} />
            </div>
          )}

          <span className="text-xs block mb-2" style={{ color: "#888" }}>Apply to locations</span>
          <div className="space-y-1">
            <label className="flex items-center gap-2 px-2.5 py-2 rounded cursor-pointer" style={{ background: "#1a1a1d" }}>
              <input type="checkbox" checked={selected.size === brandLocations.length} onChange={toggleAll} style={{ accentColor: brandColor }} />
              <span className="text-xs font-semibold" style={{ color: "#aaa" }}>Select All</span>
            </label>
            {brandLocations.map((loc) => (
              <label key={loc.id} className="flex items-center gap-2 px-2.5 py-2 rounded cursor-pointer" style={{ background: selected.has(loc.id) ? "#1c1c1f" : "transparent", border: `1px solid ${selected.has(loc.id) ? "#2a2a2e" : "transparent"}` }}>
                <input type="checkbox" checked={selected.has(loc.id)} onChange={() => toggleLocation(loc.id)} style={{ accentColor: brandColor }} />
                <span className="text-xs" style={{ color: selected.has(loc.id) ? "#ddd" : "#666" }}>
                  {loc.name}
                </span>
                <span className="ml-auto text-[10px]" style={{ color: "#555" }}>
                  {loc.city}, {loc.state}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-between items-center" style={{ borderTop: "1px solid #2a2a2e" }}>
          <span className="text-[11px]" style={{ color: "#555" }}>
            Uses UpdateLocations bulk endpoint
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-md text-xs font-semibold" style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving || saved || selected.size === 0} className="px-5 py-2 rounded-md text-xs font-semibold text-white transition-opacity" style={{ background: saved ? "#16a34a" : brandColor, opacity: saving || selected.size === 0 ? 0.6 : 1 }}>
              {saved ? "✓ Pushed" : saving ? `Updating ${selected.size} locations...` : `Update ${selected.size} Locations`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
