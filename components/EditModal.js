"use client";

import { useState, useEffect } from "react";
import { DEFAULT_HOURS, getBrandConfig } from "@/lib/data";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const HOLIDAY_TYPES = [
  { value: "CLOSED", label: "Closed", desc: "Location is closed all day" },
  { value: "OPENED_ALL_DAY", label: "Open All Day", desc: "Location is open 24 hours" },
  { value: "RANGE", label: "Custom Hours", desc: "Set specific open/close times" },
  { value: "REGULAR", label: "Regular Hours", desc: "Use normal business hours" },
];

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

function SemrushStatusBadge({ status }) {
  if (!status) return null;
  const map = {
    COMPLETE: { bg: "#0d2818", color: "#34d399" },
    PROCESSING: { bg: "#1a1a3d", color: "#93c5fd" },
    PENDING: { bg: "#2d1b00", color: "#fbbf24" },
    ERROR: { bg: "#2d0a0a", color: "#f87171" },
  };
  const s = map[status] || map.PROCESSING;
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide" style={{ background: s.bg, color: s.color }}>
      {status}
    </span>
  );
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

  // Rich fields (description / categories / coordinates / social) come from
  // the new Semrush API via /api/semrush/rich/[id]. Lazy-fetched on mount.
  // Editable in Phase 3 — diff against richInitial for the update_mask.
  const [rich, setRich] = useState(null);            // current editable values
  const [richInitial, setRichInitial] = useState(null); // baseline for dirty check
  const [richState, setRichState] = useState("loading"); // loading | ready | unavailable | error
  const [richReason, setRichReason] = useState(null);
  const [richSaveError, setRichSaveError] = useState(null);

  // Category catalog for the picker. Loaded once on mount; falls back to
  // raw-ID free-text if the upstream endpoint isn't available.
  const [categoryCatalog, setCategoryCatalog] = useState(null); // null = loading, [] = unavailable
  const [categoryQuery, setCategoryQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    const oldId = location.semrushId || location.id;
    if (!oldId) {
      setRichState("unavailable");
      setRichReason("no_id");
      return;
    }
    setRichState("loading");
    fetch(`/api/semrush/rich/${oldId}`)
      .then((r) => r.json().then((b) => ({ ok: r.ok, body: b })))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) {
          setRichState("error");
          setRichReason(body?.error || "Failed to fetch rich fields");
          return;
        }
        if (body.rich) {
          setRich(body.rich);
          setRichInitial(body.rich);
          setRichState("ready");
        } else {
          setRichState("unavailable");
          setRichReason(body.reason || "unavailable");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setRichState("error");
        setRichReason(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [location.semrushId, location.id]);

  // Load category catalog for this location's country. Categories differ
  // between US/CA/etc, so we scope the fetch to the location. Server
  // caches per-country for 24h so subsequent opens are free.
  useEffect(() => {
    let cancelled = false;
    const country = (location.countryCode || "US").toUpperCase();
    setCategoryCatalog(null); // reset to loading state when country changes
    fetch(`/api/semrush/categories?country=${encodeURIComponent(country)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setCategoryCatalog(Array.isArray(data.categories) ? data.categories : []);
      })
      .catch(() => {
        if (!cancelled) setCategoryCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [location.countryCode]);

  // Helpers for rich-field editing
  const updateRich = (key, value) => setRich((prev) => ({ ...prev, [key]: value }));

  // Compute which rich fields changed since load. Returns an object suitable
  // for the PATCH route's `changes` param (only dirty keys present).
  const richDirtyChanges = () => {
    if (!rich || !richInitial) return {};
    const out = {};
    const keys = [
      "description",
      "categoryIds",
      "coordinates",
      "suppressAddress",
      "featuredMessage",
      "featuredMessageUrl",
      "youtubeVideo",
      "instagramUsername",
      "twitterUsername",
    ];
    for (const k of keys) {
      // Deep-equal via JSON for object/array fields (coordinates, categoryIds)
      const a = JSON.stringify(rich[k] ?? null);
      const b = JSON.stringify(richInitial[k] ?? null);
      if (a !== b) out[k] = rich[k];
    }
    return out;
  };

  // Resolve a category id → human name from the loaded catalog, falling
  // back to the raw id when the catalog is empty/unavailable. Prefers
  // full_name (hierarchical e.g. "Food > Fast Food Restaurant") over name.
  const categoryLabel = (id) => {
    if (!categoryCatalog || categoryCatalog.length === 0) return id;
    const hit = categoryCatalog.find((c) => c.id === id || c.category_id === id);
    return hit?.full_name || hit?.name || hit?.label || id;
  };

  // Filter catalog for the picker — search across name, full_name, and id.
  const filteredCategories =
    categoryCatalog && categoryQuery
      ? categoryCatalog
          .filter((c) => {
            const text = `${c.full_name || ""} ${c.name || c.label || ""} ${c.id || c.category_id || ""}`.toLowerCase();
            return text.includes(categoryQuery.toLowerCase());
          })
          .slice(0, 10)
      : [];

  const addCategory = (id) => {
    if (!id || !rich) return;
    const current = rich.categoryIds || [];
    if (current.includes(id)) return;
    if (current.length >= 10) return; // API limit
    updateRich("categoryIds", [...current, id]);
    setCategoryQuery("");
  };

  const removeCategory = (id) => {
    if (!rich) return;
    updateRich("categoryIds", (rich.categoryIds || []).filter((c) => c !== id));
  };

  const hasErrors = (location.semrushErrors || []).length > 0;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setRichSaveError(null);

    // 1. Rich save first, if anything in the Extras tab changed. We do this
    //    before calling onSave because onSave closes the modal immediately
    //    in the parent — if rich save fails we want the modal to stay open
    //    so the user can see the error and decide what to do.
    let richFieldsUpdated = 0;
    const changes = richDirtyChanges();
    if (Object.keys(changes).length > 0 && richState === "ready") {
      const oldId = location.semrushId || location.id;
      try {
        const res = await fetch(`/api/semrush/rich/${oldId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes, locationName: location.name }),
        });
        const body = await res.json();
        if (!res.ok) {
          setRichSaveError(body.error || `Rich save failed (HTTP ${res.status})`);
          setSaving(false);
          return; // halt — don't fire core save
        }
        if (body.rich) {
          setRich(body.rich);
          setRichInitial(body.rich);
        }
        richFieldsUpdated = Array.isArray(body.updateMask) ? body.updateMask.length : Object.keys(changes).length;
      } catch (e) {
        setRichSaveError(`Rich save failed: ${e.message}`);
        setSaving(false);
        return;
      }
    }

    // 2. Core save — onSave triggers PUT /api/semrush/locations/[id] in
    //    the parent and closes the modal. The second arg lets the parent's
    //    toast acknowledge rich fields that already saved successfully.
    setSaved(true);
    setTimeout(() => {
      onSave(
        {
          ...formData,
          businessHours: hours,
          holidayHours: holidayHours.length > 0 ? holidayHours : undefined,
        },
        { richFieldsUpdated }
      );
    }, 400);
  };

  // Holiday hours helpers
  const addHoliday = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setHolidayHours([...holidayHours, { type: "CLOSED", day: tomorrow.toISOString().split("T")[0] }]);
  };

  const updateHoliday = (index, updates) => {
    const next = [...holidayHours];
    next[index] = { ...next[index], ...updates };
    if (updates.type && updates.type !== "RANGE") delete next[index].times;
    if (updates.type === "RANGE" && !next[index].times) next[index].times = [{ from: "09:00", to: "17:00" }];
    setHolidayHours(next);
  };

  const removeHoliday = (index) => setHolidayHours(holidayHours.filter((_, i) => i !== index));

  const addTimeRange = (hIdx) => {
    const next = [...holidayHours];
    if (!next[hIdx].times) next[hIdx].times = [];
    if (next[hIdx].times.length >= 3) return;
    next[hIdx].times.push({ from: "09:00", to: "17:00" });
    setHolidayHours(next);
  };

  const updateTimeRange = (hIdx, tIdx, field, value) => {
    const next = [...holidayHours];
    next[hIdx].times[tIdx][field] = value;
    setHolidayHours(next);
  };

  const removeTimeRange = (hIdx, tIdx) => {
    const next = [...holidayHours];
    next[hIdx].times = next[hIdx].times.filter((_, i) => i !== tIdx);
    if (next[hIdx].times.length === 0) next[hIdx].times = [{ from: "09:00", to: "17:00" }];
    setHolidayHours(next);
  };

  const tabs = ["details", "hours", "status", "extras"];
  if (hasErrors) tabs.push("errors");

  const fields = [
    { label: "Location Name", key: "name", full: true },
    { label: "Address", key: "address", full: true },
    { label: "Address Line 2", key: "additionalAddressInfo", full: true },
    { label: "City", key: "city" },
    { label: "State / Region", key: "state", small: true },
    { label: "ZIP / Postal Code", key: "zip", small: true },
    { label: "Phone", key: "phone", full: true },
    { label: "Website URL", key: "website", full: true },
    { label: "URL Parameters", key: "urlParams", full: true, placeholder: "utm_source=google&utm_medium=organic&utm_campaign=gbp_website", hint: "Query string appended to the URL when sent to Semrush (no leading ?)" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="animate-fade-scale w-full max-w-[640px] max-h-[85vh] flex flex-col rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
        {/* Header */}
        <div className="px-6 py-5 flex justify-between items-start" style={{ borderBottom: "1px solid #2a2a2e" }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: brandColor }} />
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#888" }}>Edit Location</span>
              {location.semrushStatus && <SemrushStatusBadge status={location.semrushStatus} />}
              {location.countryCode && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: "#1c1c1f", color: "#666" }}>
                  {location.countryCode}
                </span>
              )}
            </div>
            <h3 className="text-base font-semibold text-white">{location.name}</h3>
            {hasErrors && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: "#2d0a0a", color: "#f87171" }}>
                  {location.semrushErrors.length} sync {location.semrushErrors.length === 1 ? "error" : "errors"}
                </span>
              </div>
            )}
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center text-sm" style={{ background: "#222", border: "1px solid #333", color: "#888" }}>×</button>
        </div>

        {/* Tabs */}
        <div className="flex px-6" style={{ borderBottom: "1px solid #2a2a2e" }}>
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="px-4 py-3 text-xs font-semibold capitalize transition-colors relative"
              style={{
                color: activeTab === tab ? "#e8e8e8" : tab === "errors" ? "#f87171" : "#666",
                borderBottom: activeTab === tab ? `2px solid ${tab === "errors" ? "#f87171" : brandColor}` : "2px solid transparent",
                background: "none",
              }}
            >
              {tab === "errors" ? `Errors (${location.semrushErrors.length})` : tab}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto flex-1">

          {/* DETAILS TAB */}
          {activeTab === "details" && (
            <div>
              <div className="grid grid-cols-4 gap-3">
                {fields.map((field) => (
                  <div key={field.key} className={field.full ? "col-span-4" : field.small ? "col-span-1" : "col-span-2"}>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: field.key === "urlParams" ? "#93c5fd" : "#777" }}>{field.label}</label>
                    <input
                      value={formData[field.key] || ""}
                      onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                      placeholder={field.placeholder || ""}
                      className="w-full px-3 py-2.5 rounded-md text-sm"
                      style={{
                        background: field.key === "urlParams" ? "#0c1a2e" : "#1c1c1f",
                        border: `1px solid ${field.key === "urlParams" ? "#1e3a5f" : "#2a2a2e"}`,
                        color: "#ddd",
                        fontFamily: field.key === "urlParams" ? "'JetBrains Mono', monospace" : "inherit",
                        fontSize: field.key === "urlParams" ? "12px" : undefined,
                      }}
                    />
                    {field.hint && (
                      <p className="text-[10px] mt-1" style={{ color: "#555" }}>{field.hint}</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Read-only Semrush metadata */}
              <div className="mt-4 grid grid-cols-2 gap-3">
                {location.countryCode && (
                  <div className="px-3 py-2 rounded-md" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
                    <span className="text-[10px] font-semibold uppercase tracking-wider block" style={{ color: "#555" }}>Country</span>
                    <span className="text-xs font-mono" style={{ color: "#aaa" }}>{location.countryCode}</span>
                  </div>
                )}
                {location.semrushStatus && (
                  <div className="px-3 py-2 rounded-md" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
                    <span className="text-[10px] font-semibold uppercase tracking-wider block" style={{ color: "#555" }}>Semrush Status</span>
                    <SemrushStatusBadge status={location.semrushStatus} />
                  </div>
                )}
              </div>

              <div className="mt-3 px-3.5 py-2.5 rounded-md" style={{ background: "#1a1a1d", border: "1px solid #2a2a2e" }}>
                <p className="text-xs leading-relaxed" style={{ color: "#888" }}>
                  <span style={{ color: "#fbbf24" }}>⚡</span> Changes push to Semrush via API, then distribute to 70+ directories. Propagation typically takes 24–72 hours.
                </p>
              </div>
            </div>
          )}

          {/* HOURS TAB */}
          {activeTab === "hours" && (
            <div className="space-y-2">
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs" style={{ color: "#888" }}>Business Hours</span>
                <button onClick={() => setHours({ ...DEFAULT_HOURS })} className="text-[11px] font-semibold px-3 py-1 rounded" style={{ background: brandColor + "20", border: `1px solid ${brandColor}40`, color: brandColor }}>
                  Apply Brand Default
                </button>
              </div>
              {DAYS.map((day) => {
                const val = hours[day];
                return (
                  <div key={day} className="flex items-center gap-3 px-3 py-2 rounded-md" style={{ background: "#1c1c1f", border: "1px solid #222" }}>
                    <span className="w-20 text-xs font-semibold capitalize" style={{ color: val.closed ? "#555" : "#ccc" }}>{day}</span>
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
                    {holidayHours.length > 0 && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: "#a78bfa20", color: "#a78bfa" }}>{holidayHours.length}</span>}
                  </span>
                </div>
                {holidayHours.map((holiday, hIdx) => (
                  <div key={hIdx} className="mb-2.5 p-3 rounded-lg" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e" }}>
                    <div className="flex items-center gap-2 mb-2">
                      <input type="date" value={holiday.day} onChange={(e) => updateHoliday(hIdx, { day: e.target.value })} className="px-2 py-1.5 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                      <select value={holiday.type} onChange={(e) => updateHoliday(hIdx, { type: e.target.value })} className="px-2 py-1.5 rounded text-xs" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }}>
                        {HOLIDAY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      <button onClick={() => removeHoliday(hIdx)} className="ml-auto w-6 h-6 rounded flex items-center justify-center text-xs" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}>×</button>
                    </div>
                    <div className="text-[10px] mb-2" style={{ color: "#555" }}>{HOLIDAY_TYPES.find((t) => t.value === holiday.type)?.desc}</div>
                    {holiday.type === "RANGE" && (
                      <div className="space-y-1.5">
                        {(holiday.times || []).map((time, tIdx) => (
                          <div key={tIdx} className="flex items-center gap-2">
                            <input type="time" value={time.from} onChange={(e) => updateTimeRange(hIdx, tIdx, "from", e.target.value)} className="px-2 py-1 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                            <span className="text-[11px]" style={{ color: "#555" }}>to</span>
                            <input type="time" value={time.to} onChange={(e) => updateTimeRange(hIdx, tIdx, "to", e.target.value)} className="px-2 py-1 rounded text-xs font-mono" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#ddd" }} />
                            {(holiday.times || []).length > 1 && <button onClick={() => removeTimeRange(hIdx, tIdx)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "#2d0a0a", color: "#f87171" }}>×</button>}
                          </div>
                        ))}
                        {(holiday.times || []).length < 3 && <button onClick={() => addTimeRange(hIdx)} className="text-[11px] px-2 py-1 rounded" style={{ background: "#151517", border: "1px dashed #333", color: "#666" }}>+ Add time range</button>}
                      </div>
                    )}
                  </div>
                ))}
                <button onClick={addHoliday} className="w-full py-3 rounded-md text-xs" style={{ background: "#1c1c1f", border: "1px dashed #333", color: "#888" }}>+ Add Holiday Override</button>
              </div>
            </div>
          )}

          {/* STATUS TAB */}
          {activeTab === "status" && (
            <div className="space-y-3">
              <span className="text-xs" style={{ color: "#888" }}>Location Status</span>
              {[
                { value: "active", label: "Active", desc: "Location is open and operating normally" },
                { value: "temp_closed", label: "Temporarily Closed", desc: "Shows reopen date across directories" },
              ].map((opt) => (
                <label key={opt.value} className="flex gap-3 p-3.5 rounded-lg cursor-pointer transition-colors" style={{ background: formData.status === opt.value ? "#1c1c1f" : "transparent", border: `1px solid ${formData.status === opt.value ? brandColor + "60" : "#2a2a2e"}` }}>
                  <input type="radio" name="status" checked={formData.status === opt.value} onChange={() => setFormData({ ...formData, status: opt.value, reopenDate: opt.value === "active" ? null : formData.reopenDate })} style={{ accentColor: brandColor, marginTop: "2px" }} />
                  <div>
                    <div className="text-sm font-semibold text-white">{opt.label}</div>
                    <div className="text-xs mt-0.5" style={{ color: "#777" }}>{opt.desc}</div>
                  </div>
                </label>
              ))}
              {formData.status === "temp_closed" && (
                <div className="pl-7 space-y-1.5">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#777" }}>Expected Reopen Date</label>
                  <input type="date" value={formData.reopenDate || ""} onChange={(e) => setFormData({ ...formData, reopenDate: e.target.value })} className="px-3 py-2 rounded-md text-sm" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd", width: "200px" }} />
                  <p className="text-[10px]" style={{ color: "#555" }}>Must be after today and before 2038-01-01</p>
                </div>
              )}
            </div>
          )}

          {/* EXTRAS TAB — rich fields from the new local API (read-only in Phase 2) */}
          {activeTab === "extras" && (
            <div className="space-y-4">
              {richState === "loading" && (
                <div className="py-8 text-center text-xs" style={{ color: "#666" }}>Loading rich fields…</div>
              )}

              {richState === "unavailable" && (
                <div className="px-4 py-3 rounded-lg" style={{ background: "#2d1b00", border: "1px solid #5c3a00" }}>
                  <div className="text-xs font-semibold mb-1" style={{ color: "#fbbf24" }}>Rich fields unavailable</div>
                  <p className="text-[11px]" style={{ color: "#a78bfa99" }}>
                    {richReason === "no_apikey"
                      ? "SEMRUSH_API_KEY is not set on this deployment — extras can't load."
                      : richReason === "no_mapping"
                      ? "No new-API mapping for this location yet. An admin needs to run the rich-field mapping sync on /dashboard/admin."
                      : "Rich fields are not available for this location."}
                  </p>
                </div>
              )}

              {richState === "error" && (
                <div className="px-4 py-3 rounded-lg" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40" }}>
                  <div className="text-xs font-semibold mb-1" style={{ color: "#f87171" }}>Couldn't load rich fields</div>
                  <p className="text-[11px] font-mono" style={{ color: "#ccc" }}>{richReason}</p>
                </div>
              )}

              {richState === "ready" && rich && (
                <>
                  {richSaveError && (
                    <div className="px-3 py-2 rounded-lg text-[11px]" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}>
                      <span className="font-semibold">Rich save failed:</span> {richSaveError}
                    </div>
                  )}

                  {/* Description */}
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                      Description <span style={{ color: "#555" }}>(10–750 chars)</span>
                    </label>
                    <textarea
                      value={rich.description || ""}
                      onChange={(e) => updateRich("description", e.target.value)}
                      rows={4}
                      maxLength={750}
                      placeholder="Describe this location..."
                      className="w-full px-3 py-2.5 rounded-md text-xs leading-relaxed"
                      style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd", fontFamily: "inherit", resize: "vertical" }}
                    />
                    <div className="text-[10px] mt-1 text-right" style={{ color: (rich.description || "").length > 750 ? "#f87171" : "#555" }}>
                      {(rich.description || "").length} / 750
                    </div>
                  </div>

                  {/* Categories picker */}
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                      Categories <span style={{ color: "#555" }}>(primary + up to 9 secondary, max 10)</span>
                    </label>
                    <div className="text-[10px] mb-2 px-2.5 py-1.5 rounded" style={{ background: "#1a1a1d", border: "1px solid #222", color: "#888" }}>
                      <span style={{ color: "#fbbf24" }}>ⓘ</span> Semrush's API currently only returns the primary category. Any secondary categories set in the Semrush dashboard exist but aren't visible here. Categories you add and save below will persist via the API.
                    </div>

                    {/* Currently-selected chips */}
                    <div className="flex flex-wrap gap-1.5 mb-2 min-h-[24px]">
                      {(rich.categoryIds || []).length === 0 && (
                        <span className="text-[11px] italic" style={{ color: "#555" }}>No categories selected</span>
                      )}
                      {(rich.categoryIds || []).map((cid, idx) => (
                        <span key={cid} className="inline-flex items-center px-2 py-0.5 rounded text-[11px]" style={{ background: idx === 0 ? "#a78bfa20" : "#151517", border: `1px solid ${idx === 0 ? "#a78bfa" : "#2a2a2e"}`, color: idx === 0 ? "#c4b5fd" : "#aaa" }}>
                          {idx === 0 && <span className="text-[9px] font-bold uppercase" style={{ marginRight: "6px" }}>Primary</span>}
                          <span className={categoryCatalog && categoryCatalog.length > 0 ? "" : "font-mono"} style={{ marginRight: "6px" }}>{categoryLabel(cid)}</span>
                          <button type="button" onClick={() => removeCategory(cid)} className="hover:opacity-100 opacity-70" style={{ color: idx === 0 ? "#c4b5fd" : "#888" }}>×</button>
                        </span>
                      ))}
                    </div>

                    {/* Picker — typeahead if catalog is available, free-form input as fallback */}
                    {categoryCatalog === null && (
                      <div className="text-[11px]" style={{ color: "#555" }}>Loading categories…</div>
                    )}
                    {categoryCatalog && categoryCatalog.length === 0 && (
                      <div className="flex gap-2">
                        <input
                          value={categoryQuery}
                          onChange={(e) => setCategoryQuery(e.target.value)}
                          placeholder="Enter category ID (e.g. food.fast_food)"
                          className="flex-1 px-3 py-2 rounded-md text-xs font-mono"
                          style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                        />
                        <button type="button" onClick={() => addCategory(categoryQuery.trim())} disabled={!categoryQuery.trim() || (rich.categoryIds || []).length >= 10} className="px-3 py-2 rounded-md text-xs font-semibold" style={{ background: "#222", border: "1px solid #2a2a2e", color: "#aaa", opacity: !categoryQuery.trim() || (rich.categoryIds || []).length >= 10 ? 0.5 : 1 }}>Add</button>
                      </div>
                    )}
                    {categoryCatalog && categoryCatalog.length > 0 && (
                      <div className="relative">
                        <input
                          value={categoryQuery}
                          onChange={(e) => setCategoryQuery(e.target.value)}
                          placeholder="Search categories…"
                          className="w-full px-3 py-2 rounded-md text-xs"
                          style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                        />
                        {categoryQuery && filteredCategories.length > 0 && (
                          <div className="absolute top-full left-0 right-0 mt-1 z-10 max-h-48 overflow-auto rounded-md" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e" }}>
                            {filteredCategories.map((c) => {
                              const id = c.id || c.category_id;
                              const primary = c.full_name || c.name || c.label || id;
                              const secondary = c.full_name && c.name && c.full_name !== c.name ? c.name : null;
                              const already = (rich.categoryIds || []).includes(id);
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() => !already && addCategory(id)}
                                  disabled={already}
                                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[#222]"
                                  style={{ color: already ? "#555" : "#ddd" }}
                                >
                                  <div>{primary}</div>
                                  {secondary && (
                                    <div className="text-[10px]" style={{ color: "#666" }}>{secondary}</div>
                                  )}
                                  {already && <span className="text-[10px] ml-2" style={{ color: "#555" }}>(selected)</span>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    {(rich.categoryIds || []).length >= 10 && (
                      <div className="text-[10px] mt-1" style={{ color: "#fbbf24" }}>Maximum of 10 categories reached</div>
                    )}
                  </div>

                  {/* Coordinates */}
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                      Map Coordinates Override <span style={{ color: "#555" }}>(blank = auto-geocode from address)</span>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="number"
                        step="any"
                        min="-90"
                        max="90"
                        value={rich.coordinates?.latitude ?? ""}
                        onChange={(e) => {
                          const v = e.target.value === "" ? null : Number(e.target.value);
                          if (v === null && rich.coordinates?.longitude == null) {
                            updateRich("coordinates", null);
                          } else {
                            updateRich("coordinates", { ...(rich.coordinates || {}), latitude: v });
                          }
                        }}
                        placeholder="Latitude (e.g. 33.5602)"
                        className="px-3 py-2 rounded-md text-xs font-mono"
                        style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                      />
                      <input
                        type="number"
                        step="any"
                        min="-180"
                        max="180"
                        value={rich.coordinates?.longitude ?? ""}
                        onChange={(e) => {
                          const v = e.target.value === "" ? null : Number(e.target.value);
                          if (v === null && rich.coordinates?.latitude == null) {
                            updateRich("coordinates", null);
                          } else {
                            updateRich("coordinates", { ...(rich.coordinates || {}), longitude: v });
                          }
                        }}
                        placeholder="Longitude (e.g. -81.7196)"
                        className="px-3 py-2 rounded-md text-xs font-mono"
                        style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                      />
                    </div>
                  </div>

                  {/* Featured message */}
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                      Featured Message <span style={{ color: "#555" }}>(max 50 chars)</span>
                    </label>
                    <input
                      value={rich.featuredMessage || ""}
                      maxLength={50}
                      onChange={(e) => updateRich("featuredMessage", e.target.value)}
                      placeholder="Promotional message (optional)"
                      className="w-full px-3 py-2 rounded-md text-xs"
                      style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                    />
                    <input
                      value={rich.featuredMessageUrl || ""}
                      onChange={(e) => updateRich("featuredMessageUrl", e.target.value)}
                      placeholder="Call-to-action URL (optional)"
                      className="w-full px-3 py-2 mt-1.5 rounded-md text-xs font-mono"
                      style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                    />
                  </div>

                  {/* Social */}
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>Social</label>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "#555" }}>Instagram</div>
                        <input
                          value={rich.instagramUsername || ""}
                          maxLength={30}
                          onChange={(e) => updateRich("instagramUsername", e.target.value.replace(/^@/, ""))}
                          placeholder="handle"
                          className="w-full px-2 py-1.5 rounded-md text-xs font-mono"
                          style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                        />
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "#555" }}>Twitter / X</div>
                        <input
                          value={rich.twitterUsername || ""}
                          maxLength={15}
                          onChange={(e) => updateRich("twitterUsername", e.target.value.replace(/^@/, ""))}
                          placeholder="handle"
                          className="w-full px-2 py-1.5 rounded-md text-xs font-mono"
                          style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                        />
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "#555" }}>YouTube</div>
                        <input
                          value={rich.youtubeVideo || ""}
                          maxLength={150}
                          onChange={(e) => updateRich("youtubeVideo", e.target.value)}
                          placeholder="https://youtube.com/..."
                          className="w-full px-2 py-1.5 rounded-md text-xs font-mono"
                          style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Suppress address */}
                  <div className="flex items-center gap-2.5 px-3 py-2 rounded-md" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
                    <input
                      type="checkbox"
                      id="suppress-address"
                      checked={!!rich.suppressAddress}
                      onChange={(e) => updateRich("suppressAddress", e.target.checked)}
                      style={{ accentColor: brandColor }}
                    />
                    <label htmlFor="suppress-address" className="text-xs cursor-pointer" style={{ color: "#ccc" }}>
                      Hide physical address from public listings
                      <span className="text-[10px] block" style={{ color: "#555" }}>For service-area businesses without a storefront</span>
                    </label>
                  </div>

                  {rich.locationStatus && (
                    <div className="px-3 py-2 rounded-md flex items-center gap-2" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
                      <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#555" }}>New-API Status</span>
                      <span className="text-xs font-mono" style={{ color: "#aaa" }}>{rich.locationStatus}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ERRORS TAB */}
          {activeTab === "errors" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-semibold" style={{ color: "#f87171" }}>Semrush Sync Errors</span>
                <span className="text-[10px]" style={{ color: "#555" }}>These are reported by Semrush after pushing to directories</span>
              </div>
              {(location.semrushErrors || []).map((err, i) => (
                <div key={i} className="px-4 py-3 rounded-lg" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40" }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ background: "#2d0a0a", color: "#f87171" }}>
                      {err.code}
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: "#ccc" }}>{err.message}</p>
                </div>
              ))}
              {(location.semrushErrors || []).length === 0 && (
                <div className="py-8 text-center text-sm" style={{ color: "#555" }}>No sync errors for this location</div>
              )}
              <div className="px-3 py-2 rounded-md" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
                <p className="text-[11px]" style={{ color: "#666" }}>
                  Errors typically resolve after correcting the flagged data and pushing an update. Some directory-specific errors (like Google processing issues) may take additional time.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 flex justify-between items-center" style={{ borderTop: "1px solid #2a2a2e" }}>
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color: "#555" }}>
              {location.semrushId ? `ID: ${location.semrushId.slice(0, 8)}...` : ""}
            </span>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-md text-xs font-semibold" style={{ background: "#222", border: "1px solid #333", color: "#aaa" }}>Cancel</button>
            <button onClick={handleSave} disabled={saving || saved} className="px-5 py-2 rounded-md text-xs font-semibold text-white transition-opacity" style={{ background: saved ? "#16a34a" : brandColor, opacity: saving ? 0.7 : 1 }}>
              {saved ? "✓ Pushed" : saving ? "Pushing to API..." : "Save & Push"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
