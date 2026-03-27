"use client";

import { useState } from "react";
import { DEFAULT_HOURS, getBrandConfig } from "@/lib/data";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const HOLIDAY_TYPES = [
  { value: "CLOSED", label: "Closed", desc: "Location is closed all day" },
  { value: "OPENED_ALL_DAY", label: "Open All Day", desc: "Location is open 24 hours" },
  { value: "RANGE", label: "Custom Hours", desc: "Set specific open/close times" },
  { value: "REGULAR", label: "Regular Hours", desc: "Use normal business hours" },
];

/**
 * Convert Semrush businessHours format to our editor format.
 * Semrush: { monday: [{ from: "08:00", to: "18:00" }], ... }
 * Editor:  { monday: { open: "08:00", close: "18:00", closed: false }, ... }
 */
function parseBusinessHours(semrushHours) {
  if (!semrushHours) return { ...DEFAULT_HOURS };

  const parsed = {};
  for (const day of DAYS) {
    const ranges = semrushHours[day];
    if (!ranges || ranges.length === 0) {
      parsed[day] = { open: "00:00", close: "00:00", closed: true };
    } else {
      parsed[day] = { open: ranges[0].from, close: ranges[0].to, closed: false };
    }
  }
  return parsed;
}

export default function EditModal({ location, brands: brandsList, onClose, onSave }) {
  const brandData = (brandsList || []).find((b) => b.id === location.brand) || getBrandConfig(location.brand);
  const brandColor = brandData?.color || "#666";

  const [formData, setFormData] = useState({ ...location });
  const [hours, setHours] = useState(() => parseBusinessHours(location.businessHours));
  const [holidayHours, setHolidayHours] = useState(() => location.holidayHours || []);
  const [activeTab, setActiveTab] = useState("details");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      setSaved(true);
      setTimeout(() => {
        onSave({
          ...formData,
          businessHours: hours,
          holidayHours: holidayHours.length > 0 ? holidayHours : undefined,
        });
      }, 600);
    }, 1500);
  };

  // --- Holiday hours helpers ---

  const addHoliday = () => {
    // Default to tomorrow's date
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split("T")[0];

    setHolidayHours([
      ...holidayHours,
      { type: "CLOSED", day: dateStr },
    ]);
  };

  const updateHoliday = (index, updates) => {
    const next = [...holidayHours];
    next[index] = { ...next[index], ...updates };

    // Clean up times based on type
    if (updates.type && updates.type !== "RANGE") {
      delete next[index].times;
    }
    if (updates.type === "RANGE" && !next[index].times) {
      next[index].times = [{ from: "09:00", to: "17:00" }];
    }

    setHolidayHours(next);
  };

  const removeHoliday = (index) => {
    setHolidayHours(holidayHours.filter((_, i) => i !== index));
  };

  const addTimeRange = (holidayIndex) => {
    const next = [...holidayHours];
    const current = next[holidayIndex];
    if (!current.times) current.times = [];
    if (current.times.length >= 3) return; // Semrush max is 3
    current.times.push({ from: "09:00", to: "17:00" });
    setHolidayHours(next);
  };

  const updateTimeRange = (holidayIndex, timeIndex, field, value) => {
    const next = [...holidayHours];
    next[holidayIndex].times[timeIndex][field] = value;
    setHolidayHours(next);
  };

  const removeTimeRange = (holidayIndex, timeIndex) => {
    const next = [...holidayHours];
    next[holidayIndex].times = next[holidayIndex].times.filter((_, i) => i !== timeIndex);
    if (next[holidayIndex].times.length === 0) {
      next[holidayIndex].times = [{ from: "09:00", to: "17:00" }];
    }
    setHolidayHours(next);
  };

  // --- Field config ---

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

          {/* === DETAILS TAB === */}
          {activeTab === "details" && (
            <div>
              <div className="grid grid-cols-4 gap-3">
                {fields.map((field) => (
                  <div key={field.key} className={field.full ? "col-span-4" : field.small ? "col-span-1" : "col-span-2"}>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                      {field.label}
                    </label>
                    <input
                      value={formData[field.key] || ""}
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

          {/* === HOURS TAB === */}
          {activeTab === "hours" && (
            <div className="space-y-2">
              {/* Business hours */}
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs" style={{ color: "#888" }}>Business Hours</span>
                <button
                  onClick={() => setHours({ ...DEFAULT_HOURS })}
                  className="text-[11px] font-semibold px-3 py-1 rounded"
                  style={{ background: brandColor + "20", border: `1px solid ${brandColor}40`, color: brandColor }}
                >
                  Apply Brand Default
                </button>
              </div>
              {DAYS.map((day) => {
                const val = hours[day];
                return (
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
                );
              })}

              {/* Holiday hours */}
              <div className="mt-5 pt-4" style={{ borderTop: "1px solid #2a2a2e" }}>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-xs" style={{ color: "#888" }}>
                    Holiday Hours
                    {holidayHours.length > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: "#a78bfa20", color: "#a78bfa" }}>
                        {holidayHours.length}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px]" style={{ color: "#555" }}>
                    Overrides regular hours on specific dates
                  </span>
                </div>

                {/* Existing holiday entries */}
                {holidayHours.map((holiday, hIdx) => (
                  <div key={hIdx} className="mb-2.5 p-3 rounded-lg" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e" }}>
                    <div className="flex items-center gap-2 mb-2.5">
                      {/* Date picker */}
                      <input
                        type="date"
                        value={holiday.day}
                        onChange={(e) => updateHoliday(hIdx, { day: e.target.value })}
                        className="px-2 py-1.5 rounded text-xs font-mono"
                        style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }}
                      />

                      {/* Type selector */}
                      <select
                        value={holiday.type}
                        onChange={(e) => updateHoliday(hIdx, { type: e.target.value })}
                        className="px-2 py-1.5 rounded text-xs"
                        style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }}
                      >
                        {HOLIDAY_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>

                      {/* Remove button */}
                      <button
                        onClick={() => removeHoliday(hIdx)}
                        className="ml-auto w-6 h-6 rounded flex items-center justify-center text-xs"
                        style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}
                        title="Remove holiday"
                      >
                        ×
                      </button>
                    </div>

                    {/* Type description */}
                    <div className="text-[10px] mb-2" style={{ color: "#555" }}>
                      {HOLIDAY_TYPES.find((t) => t.value === holiday.type)?.desc}
                    </div>

                    {/* Time ranges — only shown for RANGE type */}
                    {holiday.type === "RANGE" && (
                      <div className="space-y-1.5">
                        {(holiday.times || []).map((time, tIdx) => (
                          <div key={tIdx} className="flex items-center gap-2">
                            <input
                              type="time"
                              value={time.from}
                              onChange={(e) => updateTimeRange(hIdx, tIdx, "from", e.target.value)}
                              className="px-2 py-1 rounded text-xs font-mono"
                              style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }}
                            />
                            <span className="text-[11px]" style={{ color: "#555" }}>to</span>
                            <input
                              type="time"
                              value={time.to}
                              onChange={(e) => updateTimeRange(hIdx, tIdx, "to", e.target.value)}
                              className="px-2 py-1 rounded text-xs font-mono"
                              style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }}
                            />
                            {(holiday.times || []).length > 1 && (
                              <button
                                onClick={() => removeTimeRange(hIdx, tIdx)}
                                className="text-[10px] px-1.5 py-0.5 rounded"
                                style={{ background: "#2d0a0a", color: "#f87171" }}
                              >
                                ×
                              </button>
                            )}
                          </div>
                        ))}
                        {(holiday.times || []).length < 3 && (
                          <button
                            onClick={() => addTimeRange(hIdx)}
                            className="text-[11px] px-2 py-1 rounded"
                            style={{ background: "#151517", border: "1px dashed #333", color: "#666" }}
                          >
                            + Add time range
                          </button>
                        )}
                        <div className="text-[10px]" style={{ color: "#444" }}>
                          Max 3 time ranges per holiday. Ranges must not overlap.
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Add holiday button */}
                <button
                  onClick={addHoliday}
                  className="w-full py-3 rounded-md text-xs transition-colors"
                  style={{ background: "#1c1c1f", border: "1px dashed #333", color: "#888" }}
                >
                  + Add Holiday Override
                </button>

                {holidayHours.length > 0 && (
                  <div className="mt-2 text-[10px]" style={{ color: "#555" }}>
                    Each date must be unique. Holiday hours require business hours to be set.
                    Types: Closed (all day), Open All Day (24h), Custom Hours (specific ranges), Regular (normal hours).
                  </div>
                )}
              </div>
            </div>
          )}

          {/* === STATUS TAB === */}
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
                  <input
                    type="date"
                    value={formData.reopenDate || ""}
                    onChange={(e) => setFormData({ ...formData, reopenDate: e.target.value })}
                    className="px-3 py-2 rounded-md text-sm"
                    style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd", width: "200px" }}
                  />
                  <p className="text-[10px]" style={{ color: "#555" }}>Must be after today and before 2038-01-01</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-between items-center" style={{ borderTop: "1px solid #2a2a2e" }}>
          <span className="text-[11px]" style={{ color: "#555" }}>
            Last updated: {location.lastUpdated || "—"} by {location.updatedBy || "—"}
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
