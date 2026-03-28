"use client";

import { useState } from "react";
import { DEFAULT_HOURS, getBrandConfig } from "@/lib/data";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const FIELDS = [
  { id: "hours", label: "Business Hours" },
  { id: "phone", label: "Phone" },
  { id: "website", label: "Website" },
  { id: "url_params", label: "URL Parameters" },
  { id: "temp_closure", label: "Temp Closure" },
  { id: "holiday_hours", label: "Holiday Hours" },
];

export default function BulkModal({ brandId, brands: brandsList, locations: liveLocs, onClose, onSave }) {
  const brandData = (brandsList || []).find((b) => b.id === brandId) || getBrandConfig(brandId);
  const brandColor = brandData?.color || "#888";
  const allLocations = liveLocs || [];
  const brandLocations = allLocations.filter((l) => l.brand === brandId);

  const [bulkField, setBulkField] = useState("hours");
  const [selected, setSelected] = useState(new Set(brandLocations.map((l) => l.id)));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Value states for each field type
  const [phoneValue, setPhoneValue] = useState("");
  const [websiteValue, setWebsiteValue] = useState("");
  const [urlParamsValue, setUrlParamsValue] = useState("");
  const [hoursValue, setHoursValue] = useState({ ...DEFAULT_HOURS });
  const [reopenDate, setReopenDate] = useState("");
  const [holidayEntry, setHolidayEntry] = useState({
    type: "CLOSED",
    day: new Date(Date.now() + 86400000).toISOString().split("T")[0],
    times: [{ from: "09:00", to: "17:00" }],
  });

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

    // Build the value payload based on field type
    let value;
    switch (bulkField) {
      case "phone":
        value = phoneValue;
        break;
      case "website":
        value = websiteValue;
        break;
      case "url_params":
        value = urlParamsValue;
        break;
      case "hours":
        value = hoursValue;
        break;
      case "temp_closure":
        value = { reopenDate: reopenDate || null };
        break;
      case "holiday_hours":
        value = [holidayEntry.type === "RANGE"
          ? { type: holidayEntry.type, day: holidayEntry.day, times: holidayEntry.times }
          : { type: holidayEntry.type, day: holidayEntry.day }
        ];
        break;
      default:
        value = null;
    }

    // Include existing location data so required fields are available
    const existingLocations = brandLocations
      .filter((l) => selected.has(l.id))
      .map((l) => ({ id: l.id, name: l.name, city: l.city, address: l.address, phone: l.phone, website: l.website, urlParams: l.urlParams }));

    setTimeout(() => {
      setSaving(false);
      setSaved(true);
      setTimeout(() => {
        onSave({
          field: bulkField,
          value,
          brand: brandId,
          locationIds: Array.from(selected),
          existingLocations,
        });
      }, 600);
    }, 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="animate-fade-scale w-full max-w-[580px] max-h-[80vh] flex flex-col rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
        {/* Header */}
        <div className="px-6 py-5 flex justify-between items-start" style={{ borderBottom: "1px solid #2a2a2e" }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: brandColor }} />
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#888" }}>Bulk Update</span>
            </div>
            <h3 className="text-base font-semibold text-white">{brandData?.name} — {selected.size} locations selected</h3>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-sm" style={{ background: "#222", border: "1px solid #333", color: "#888" }}>×</button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          {/* Field selector */}
          <span className="text-xs block mb-2.5" style={{ color: "#888" }}>Field to update</span>
          <div className="flex gap-1.5 flex-wrap mb-5">
            {FIELDS.map((f) => (
              <button
                key={f.id}
                onClick={() => setBulkField(f.id)}
                className="px-3 py-1.5 rounded text-[11px] font-semibold transition-colors"
                style={{
                  background: bulkField === f.id ? brandColor + "18" : "#1c1c1f",
                  border: `1px solid ${bulkField === f.id ? brandColor + "60" : "#2a2a2e"}`,
                  color: bulkField === f.id ? brandColor : "#888",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* === Value inputs per field type === */}

          {bulkField === "phone" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>New Phone Number</label>
              <input value={phoneValue} onChange={(e) => setPhoneValue(e.target.value)} placeholder="+1 (XXX) XXX-XXXX" className="w-full px-3 py-2.5 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }} />
              <p className="text-[10px] mt-1" style={{ color: "#555" }}>International code required (e.g. +1 for US)</p>
            </div>
          )}

          {bulkField === "website" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>New Website URL</label>
              <input value={websiteValue} onChange={(e) => setWebsiteValue(e.target.value)} placeholder="https://..." className="w-full px-3 py-2.5 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }} />
              <p className="text-[10px] mt-1" style={{ color: "#555" }}>Must start with http:// or https://. This replaces the base URL only — existing URL parameters are preserved.</p>
            </div>
          )}

          {bulkField === "url_params" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#93c5fd" }}>URL Parameters</label>
              <input
                value={urlParamsValue}
                onChange={(e) => setUrlParamsValue(e.target.value)}
                placeholder="utm_source=google&utm_medium=organic&utm_campaign=gbp_website"
                className="w-full px-3 py-2.5 rounded-md text-xs"
                style={{ background: "#0c1a2e", border: "1px solid #1e3a5f", color: "#ddd", fontFamily: "'JetBrains Mono', monospace" }}
              />
              <p className="text-[10px] mt-1.5" style={{ color: "#555" }}>
                This string is appended to each location's base URL as <span className="font-mono" style={{ color: "#93c5fd" }}>?{urlParamsValue || "..."}</span> when sent to Semrush.
              </p>
              <div className="mt-2 px-3 py-2 rounded-md" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
                <p className="text-[10px]" style={{ color: "#666" }}>
                  If a location already has query parameters in its URL, they will be replaced with this value. Leave empty to remove all URL parameters.
                </p>
              </div>

              {/* Preview */}
              {brandLocations.length > 0 && (
                <div className="mt-3">
                  <span className="text-[10px] font-semibold uppercase tracking-wider block mb-1.5" style={{ color: "#555" }}>Preview (first 3 locations)</span>
                  <div className="space-y-1">
                    {brandLocations.filter((l) => selected.has(l.id)).slice(0, 3).map((loc) => (
                      <div key={loc.id} className="text-[10px] font-mono px-2 py-1 rounded" style={{ background: "#111113", color: "#888" }}>
                        <span style={{ color: "#555" }}>{loc.website || "no-url"}</span>
                        {urlParamsValue && <span style={{ color: "#93c5fd" }}>?{urlParamsValue}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {bulkField === "hours" && (
            <div className="mb-5 space-y-1.5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#777" }}>New Business Hours</label>
              {DAYS.map((day) => {
                const val = hoursValue[day];
                return (
                  <div key={day} className="flex items-center gap-3 px-3 py-2 rounded-md" style={{ background: "#1c1c1f", border: "1px solid #222" }}>
                    <span className="w-16 text-xs font-semibold capitalize" style={{ color: val.closed ? "#555" : "#ccc" }}>{day}</span>
                    {val.closed ? (
                      <span className="text-xs italic" style={{ color: "#666" }}>Closed</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <input type="time" value={val.open} onChange={(e) => setHoursValue({ ...hoursValue, [day]: { ...val, open: e.target.value } })} className="px-2 py-1 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                        <span className="text-[11px]" style={{ color: "#555" }}>to</span>
                        <input type="time" value={val.close} onChange={(e) => setHoursValue({ ...hoursValue, [day]: { ...val, close: e.target.value } })} className="px-2 py-1 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                      </div>
                    )}
                    <label className="ml-auto flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: "#666" }}>
                      <input type="checkbox" checked={val.closed} onChange={() => setHoursValue({ ...hoursValue, [day]: { ...val, closed: !val.closed } })} style={{ accentColor: brandColor }} />
                      Closed
                    </label>
                  </div>
                );
              })}
            </div>
          )}

          {bulkField === "temp_closure" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>Reopen Date</label>
              <input type="date" value={reopenDate} onChange={(e) => setReopenDate(e.target.value)} className="px-3 py-2.5 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd", width: "220px" }} />
              <p className="text-[10px] mt-1" style={{ color: "#555" }}>Must be after today and before 2038-01-01. All selected locations will be marked temporarily closed.</p>
            </div>
          )}

          {bulkField === "holiday_hours" && (
            <div className="mb-5 space-y-3">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>Holiday Override</label>
              <div className="flex items-center gap-2">
                <input type="date" value={holidayEntry.day} onChange={(e) => setHolidayEntry({ ...holidayEntry, day: e.target.value })} className="px-2 py-1.5 rounded text-xs font-mono" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }} />
                <select value={holidayEntry.type} onChange={(e) => setHolidayEntry({ ...holidayEntry, type: e.target.value })} className="px-2 py-1.5 rounded text-xs" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}>
                  <option value="CLOSED">Closed</option>
                  <option value="OPENED_ALL_DAY">Open All Day</option>
                  <option value="RANGE">Custom Hours</option>
                  <option value="REGULAR">Regular Hours</option>
                </select>
              </div>
              {holidayEntry.type === "RANGE" && (
                <div className="space-y-1.5 pl-2">
                  {holidayEntry.times.map((t, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input type="time" value={t.from} onChange={(e) => { const next = [...holidayEntry.times]; next[i].from = e.target.value; setHolidayEntry({ ...holidayEntry, times: next }); }} className="px-2 py-1 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                      <span className="text-[11px]" style={{ color: "#555" }}>to</span>
                      <input type="time" value={t.to} onChange={(e) => { const next = [...holidayEntry.times]; next[i].to = e.target.value; setHolidayEntry({ ...holidayEntry, times: next }); }} className="px-2 py-1 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                    </div>
                  ))}
                  {holidayEntry.times.length < 3 && (
                    <button onClick={() => setHolidayEntry({ ...holidayEntry, times: [...holidayEntry.times, { from: "09:00", to: "17:00" }] })} className="text-[11px] px-2 py-1 rounded" style={{ background: "#151517", border: "1px dashed #333", color: "#666" }}>+ Add time range</button>
                  )}
                </div>
              )}
              <p className="text-[10px]" style={{ color: "#555" }}>This override will be applied to all selected locations for the specified date.</p>
            </div>
          )}

          {/* Location selector */}
          <span className="text-xs block mb-2" style={{ color: "#888" }}>Apply to locations</span>
          <div className="space-y-1">
            <label className="flex items-center gap-2 px-2.5 py-2 rounded cursor-pointer" style={{ background: "#1a1a1d" }}>
              <input type="checkbox" checked={selected.size === brandLocations.length} onChange={toggleAll} style={{ accentColor: brandColor }} />
              <span className="text-xs font-semibold" style={{ color: "#aaa" }}>Select All</span>
            </label>
            {brandLocations.map((loc) => (
              <label key={loc.id} className="flex items-center gap-2 px-2.5 py-2 rounded cursor-pointer" style={{ background: selected.has(loc.id) ? "#1c1c1f" : "transparent", border: `1px solid ${selected.has(loc.id) ? "#2a2a2e" : "transparent"}` }}>
                <input type="checkbox" checked={selected.has(loc.id)} onChange={() => toggleLocation(loc.id)} style={{ accentColor: brandColor }} />
                <span className="text-xs" style={{ color: selected.has(loc.id) ? "#ddd" : "#666" }}>{loc.name}</span>
                <span className="ml-auto text-[10px]" style={{ color: "#555" }}>{loc.city}, {loc.state}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-between items-center" style={{ borderTop: "1px solid #2a2a2e" }}>
          <span className="text-[11px]" style={{ color: "#555" }}>
            {bulkField === "hours" ? "UpdateLocations bulk endpoint" : `Updating ${bulkField.replace(/_/g, " ")}`}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-md text-xs font-semibold" style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}>Cancel</button>
            <button onClick={handleSave} disabled={saving || saved || selected.size === 0} className="px-5 py-2 rounded-md text-xs font-semibold text-white transition-opacity" style={{ background: saved ? "#16a34a" : brandColor, opacity: saving || selected.size === 0 ? 0.6 : 1 }}>
              {saved ? "✓ Pushed" : saving ? `Updating ${selected.size} locations...` : `Update ${selected.size} Locations`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
