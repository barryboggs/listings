"use client";

import { useState } from "react";
import { BRANDS, DEFAULT_HOURS } from "@/lib/data";

function getBrandColor(brandId) {
  return BRANDS.find((b) => b.id === brandId)?.color || "#666";
}

export default function EditModal({ location, onClose, onSave }) {
  const [formData, setFormData] = useState({ ...location });
  const [hours, setHours] = useState({ ...DEFAULT_HOURS });
  const [activeTab, setActiveTab] = useState("details");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const brandColor = getBrandColor(location.brand);

  const handleSave = () => {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      setSaved(true);
      setTimeout(() => {
        onSave({ ...formData, businessHours: hours });
      }, 600);
    }, 1500);
  };

  const fields = [
    { label: "Location Name", key: "name", full: true },
    { label: "Address", key: "address", full: true },
    { label: "City", key: "city" },
    { label: "State", key: "state", small: true },
    { label: "ZIP", key: "zip", small: true },
    { label: "Phone", key: "phone", full: true },
    { label: "Website URL", key: "website", full: true },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="animate-fade-scale w-full max-w-[620px] max-h-[85vh] flex flex-col rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
        {/* Header */}
        <div className="px-6 py-5 flex justify-between items-start" style={{ borderBottom: "1px solid #2a2a2e" }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: brandColor }} />
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#888" }}>
                Edit Location
              </span>
            </div>
            <h3 className="text-base font-semibold text-white">{location.name}</h3>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-sm" style={{ background: "#222", border: "1px solid #333", color: "#888" }}>
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-6" style={{ borderBottom: "1px solid #2a2a2e" }}>
          {["details", "hours", "status"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="px-4 py-3 text-xs font-semibold capitalize transition-colors"
              style={{
                color: activeTab === tab ? "#e8e8e8" : "#666",
                borderBottom: activeTab === tab ? `2px solid ${brandColor}` : "2px solid transparent",
                background: "none",
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto flex-1">
          {activeTab === "details" && (
            <div>
              <div className="grid grid-cols-4 gap-3">
                {fields.map((field) => (
                  <div key={field.key} className={field.full ? "col-span-4" : field.small ? "col-span-1" : "col-span-2"}>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                      {field.label}
                    </label>
                    <input
                      value={formData[field.key]}
                      onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-md text-sm"
                      style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 px-3.5 py-2.5 rounded-md" style={{ background: "#1a1a1d", border: "1px solid #2a2a2e" }}>
                <p className="text-xs leading-relaxed" style={{ color: "#888" }}>
                  <span style={{ color: "#fbbf24" }}>⚡</span> Changes push to Semrush via API, then distribute to 70+ directories. Propagation typically takes 24–72 hours.
                </p>
              </div>
            </div>
          )}

          {activeTab === "hours" && (
            <div className="space-y-2">
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs" style={{ color: "#888" }}>Business Hours</span>
                <button className="text-[11px] font-semibold px-3 py-1 rounded" style={{ background: brandColor + "20", border: `1px solid ${brandColor}40`, color: brandColor }}>
                  Apply Brand Default
                </button>
              </div>
              {Object.entries(hours).map(([day, val]) => (
                <div key={day} className="flex items-center gap-3 px-3 py-2 rounded-md" style={{ background: "#1c1c1f", border: "1px solid #222" }}>
                  <span className="w-20 text-xs font-semibold capitalize" style={{ color: val.closed ? "#555" : "#ccc" }}>
                    {day}
                  </span>
                  {val.closed ? (
                    <span className="text-xs italic" style={{ color: "#666" }}>Closed</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input type="time" value={val.open} onChange={(e) => setHours({ ...hours, [day]: { ...val, open: e.target.value } })} className="px-2 py-1 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                      <span className="text-[11px]" style={{ color: "#555" }}>to</span>
                      <input type="time" value={val.close} onChange={(e) => setHours({ ...hours, [day]: { ...val, close: e.target.value } })} className="px-2 py-1 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                    </div>
                  )}
                  <label className="ml-auto flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: "#666" }}>
                    <input type="checkbox" checked={val.closed} onChange={() => setHours({ ...hours, [day]: { ...val, closed: !val.closed } })} style={{ accentColor: brandColor }} />
                    Closed
                  </label>
                </div>
              ))}
              <div className="mt-4">
                <span className="text-xs block mb-2" style={{ color: "#888" }}>Holiday Hours</span>
                <button className="w-full py-3 rounded-md text-xs" style={{ background: "#1c1c1f", border: "1px dashed #333", color: "#666" }}>
                  + Add Holiday Override
                </button>
              </div>
            </div>
          )}

          {activeTab === "status" && (
            <div className="space-y-3">
              <span className="text-xs" style={{ color: "#888" }}>Location Status</span>
              {[
                { value: "active", label: "Active", desc: "Location is open and operating normally" },
                { value: "temp_closed", label: "Temporarily Closed", desc: "Shows reopen date across directories" },
              ].map((opt) => (
                <label key={opt.value} className="flex gap-3 p-3.5 rounded-lg cursor-pointer transition-colors" style={{ background: formData.status === opt.value ? "#1c1c1f" : "transparent", border: `1px solid ${formData.status === opt.value ? brandColor + "60" : "#2a2a2e"}` }}>
                  <input type="radio" name="status" checked={formData.status === opt.value} onChange={() => setFormData({ ...formData, status: opt.value })} style={{ accentColor: brandColor, marginTop: "2px" }} />
                  <div>
                    <div className="text-sm font-semibold text-white">{opt.label}</div>
                    <div className="text-xs mt-0.5" style={{ color: "#777" }}>{opt.desc}</div>
                  </div>
                </label>
              ))}
              {formData.status === "temp_closed" && (
                <div className="pl-7 space-y-1.5">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#777" }}>
                    Expected Reopen Date
                  </label>
                  <input type="date" className="px-3 py-2 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd", width: "200px" }} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-between items-center" style={{ borderTop: "1px solid #2a2a2e" }}>
          <span className="text-[11px]" style={{ color: "#555" }}>
            Last updated: {location.lastUpdated} by {location.updatedBy}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-md text-xs font-semibold" style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving || saved} className="px-5 py-2 rounded-md text-xs font-semibold text-white transition-opacity" style={{ background: saved ? "#16a34a" : brandColor, opacity: saving ? 0.7 : 1 }}>
              {saved ? "✓ Pushed" : saving ? "Pushing to API..." : "Save & Push"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
