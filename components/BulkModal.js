"use client";

import { useState, useEffect } from "react";
import { DEFAULT_HOURS, getBrandConfig } from "@/lib/data";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// `rich: true` routes the save through sequential PATCH /api/semrush/rich/[id]
// calls (the new API has no bulk endpoint). Everything else goes through the
// old-API bulk endpoint via the parent's onSave.
//
// `appendCategories: true` is a special rich case: we GET each location's
// current categoryIds, append any new ones (deduped, capped at 10), then
// PATCH back. Costs two API calls per location instead of one.
const FIELDS = [
  { id: "hours", label: "Business Hours" },
  { id: "phone", label: "Phone" },
  { id: "website", label: "Website" },
  { id: "url_params", label: "URL Parameters" },
  { id: "temp_closure", label: "Temp Closure" },
  { id: "holiday_hours", label: "Holiday Hours" },
  { id: "description", label: "Description", rich: true },
  { id: "featured_message", label: "Featured Message", rich: true },
  { id: "suppress_address", label: "Suppress Address", rich: true },
  { id: "youtube_video", label: "YouTube Video", rich: true },
  { id: "instagram_username", label: "Instagram", rich: true },
  { id: "twitter_username", label: "Twitter / X", rich: true },
  { id: "category_append", label: "Append Categories", rich: true, appendCategories: true },
];

// Throttle between sequential rich-API PATCH requests.
const RICH_BULK_DELAY_MS = 250;

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

  // Rich-field values (Phase 4 — sent via sequential PATCH, not the bulk endpoint)
  const [descriptionValue, setDescriptionValue] = useState("");
  const [featuredMessageValue, setFeaturedMessageValue] = useState("");
  const [featuredMessageUrlValue, setFeaturedMessageUrlValue] = useState("");
  const [suppressAddressValue, setSuppressAddressValue] = useState(false);
  const [youtubeVideoValue, setYoutubeVideoValue] = useState("");
  const [instagramUsernameValue, setInstagramUsernameValue] = useState("");
  const [twitterUsernameValue, setTwitterUsernameValue] = useState("");

  // Category append: list of category IDs the user wants to ADD to every
  // selected location (deduped per-location server-side, capped at 10).
  const [categoriesToAppend, setCategoriesToAppend] = useState([]);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categoryCatalog, setCategoryCatalog] = useState(null); // null = loading, [] = unavailable

  // Country for the category catalog — peek at the first selected location.
  // Bulk operations are brand-scoped, and brands tend to be single-country.
  const catalogCountry = (brandLocations[0]?.countryCode || "US").toUpperCase();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/semrush/categories?country=${encodeURIComponent(catalogCountry)}`)
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
  }, [catalogCountry]);

  const categoryLabel = (id) => {
    if (!categoryCatalog || categoryCatalog.length === 0) return id;
    const hit = categoryCatalog.find((c) => c.id === id || c.category_id === id);
    return hit?.full_name || hit?.name || hit?.label || id;
  };

  const filteredCategories =
    categoryCatalog && categoryQuery
      ? categoryCatalog
          .filter((c) => {
            const text = `${c.full_name || ""} ${c.name || c.label || ""} ${c.id || c.category_id || ""}`.toLowerCase();
            return text.includes(categoryQuery.toLowerCase());
          })
          .slice(0, 10)
      : [];

  const addCategoryToAppend = (id) => {
    if (!id) return;
    if (categoriesToAppend.includes(id)) return;
    if (categoriesToAppend.length >= 10) return;
    setCategoriesToAppend([...categoriesToAppend, id]);
    setCategoryQuery("");
  };

  const removeCategoryFromAppend = (id) => {
    setCategoriesToAppend(categoriesToAppend.filter((c) => c !== id));
  };

  // Progress state for rich-field bulk runs. Replaces the form while running.
  const [richProgress, setRichProgress] = useState(null);
  // { current, total, succeeded, failed, skipped, errors: [{ locationName, message }] }

  const fieldDef = FIELDS.find((f) => f.id === bulkField);
  const isRichField = !!fieldDef?.rich;
  const isAppendCategories = !!fieldDef?.appendCategories;
  // Append-categories costs 2 API calls per location (GET + PATCH) instead of 1,
  // so bump the estimate accordingly.
  const callsPerLoc = isAppendCategories ? 2 : 1;
  const estimatedSeconds = Math.ceil((selected.size * RICH_BULK_DELAY_MS * callsPerLoc) / 1000) + selected.size * callsPerLoc;

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

  // Map a rich-field id to the EditModal-shaped `changes` object the
  // /api/semrush/rich/[id] PATCH route expects. Not used for the
  // append-categories field — that one builds its `changes` per-location
  // inside the loop because it needs to merge with each location's current
  // categoryIds.
  const buildRichChanges = () => {
    switch (bulkField) {
      case "description":
        return { description: descriptionValue };
      case "featured_message":
        return {
          featuredMessage: featuredMessageValue,
          featuredMessageUrl: featuredMessageUrlValue,
        };
      case "suppress_address":
        return { suppressAddress: suppressAddressValue };
      case "youtube_video":
        return { youtubeVideo: youtubeVideoValue };
      case "instagram_username":
        return { instagramUsername: instagramUsernameValue };
      case "twitter_username":
        return { twitterUsername: twitterUsernameValue };
      default:
        return {};
    }
  };

  // Sequential PATCH loop for rich fields. The new API has no bulk endpoint,
  // so we fire one request per location and report progress as we go.
  //
  // Append-categories is a special case: for each location we first GET its
  // current categoryIds, merge in `categoriesToAppend` (deduped, capped at
  // 10 total), then PATCH only if anything actually changed. If nothing
  // changed (every requested category was already present), the location
  // counts as a "success" with no API write.
  const handleRichBulkSave = async () => {
    const ids = Array.from(selected);
    const targets = brandLocations.filter((l) => ids.includes(l.id));
    const sharedChanges = isAppendCategories ? null : buildRichChanges();

    setSaving(true);
    setRichProgress({ current: 0, total: targets.length, succeeded: 0, failed: 0, skipped: 0, errors: [] });

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let noopCount = 0; // append-only: locations already had all requested categories
    const errors = [];

    for (let i = 0; i < targets.length; i++) {
      const loc = targets[i];
      setRichProgress({ current: i + 1, total: targets.length, succeeded, failed, skipped, errors });

      try {
        let perLocChanges = sharedChanges;

        // Append-categories: read current, merge, decide whether to write
        if (isAppendCategories) {
          const getRes = await fetch(`/api/semrush/rich/${loc.id}`);
          const getBody = await getRes.json();

          if (!getRes.ok) {
            failed++;
            if (errors.length < 20) errors.push({ locationName: loc.name, message: getBody.error || `Fetch failed (HTTP ${getRes.status})` });
            if (i < targets.length - 1) await new Promise((r) => setTimeout(r, RICH_BULK_DELAY_MS));
            continue;
          }
          if (!getBody.rich) {
            skipped++;
            if (errors.length < 20) errors.push({ locationName: loc.name, message: getBody.reason === "no_mapping" ? "No new-API mapping (run sync)" : (getBody.message || "Rich data unavailable") });
            if (i < targets.length - 1) await new Promise((r) => setTimeout(r, RICH_BULK_DELAY_MS));
            continue;
          }

          const current = Array.isArray(getBody.rich.categoryIds) ? getBody.rich.categoryIds : [];
          const merged = [...current];
          for (const cid of categoriesToAppend) {
            if (!merged.includes(cid) && merged.length < 10) merged.push(cid);
          }

          if (merged.length === current.length) {
            // Already had all requested categories — nothing to write.
            noopCount++;
            succeeded++;
            if (i < targets.length - 1) await new Promise((r) => setTimeout(r, RICH_BULK_DELAY_MS));
            continue;
          }

          perLocChanges = { categoryIds: merged };
        }

        const res = await fetch(`/api/semrush/rich/${loc.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: perLocChanges, locationName: loc.name }),
        });
        const body = await res.json();
        if (res.ok) {
          succeeded++;
        } else if (res.status === 404 && body.reason === "no_mapping") {
          skipped++;
          if (errors.length < 20) errors.push({ locationName: loc.name, message: "No new-API mapping (run sync)" });
        } else {
          failed++;
          if (errors.length < 20) errors.push({ locationName: loc.name, message: body.error || `HTTP ${res.status}` });
        }
      } catch (e) {
        failed++;
        if (errors.length < 20) errors.push({ locationName: loc.name, message: e.message });
      }

      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, RICH_BULK_DELAY_MS));
      }
    }

    setRichProgress({ current: targets.length, total: targets.length, succeeded, failed, skipped, errors, noopCount });
    setSaving(false);
    setSaved(true);

    // Fire onSave with metadata for the toast + activity log. For append
    // mode the "value" is the list of category IDs the user requested.
    onSave({
      field: bulkField,
      value: isAppendCategories ? { categoryIdsAppended: categoriesToAppend } : sharedChanges,
      brand: brandId,
      locationIds: ids,
      richBulk: { succeeded, failed, skipped, total: targets.length, noopCount },
    });
  };

  const handleSave = () => {
    if (isRichField) {
      handleRichBulkSave();
      return;
    }

    setSaving(true);

    // Build the value payload based on field type (old-API bulk path)
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

          {bulkField === "description" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                Description <span style={{ color: "#555" }}>(10–750 chars, applied to every selected location)</span>
              </label>
              <textarea
                value={descriptionValue}
                onChange={(e) => setDescriptionValue(e.target.value)}
                rows={4}
                maxLength={750}
                placeholder="Describe these locations (same text used for all)..."
                className="w-full px-3 py-2.5 rounded-md text-xs leading-relaxed"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd", resize: "vertical" }}
              />
              <div className="text-[10px] mt-1 text-right" style={{ color: descriptionValue.length > 750 ? "#f87171" : "#555" }}>
                {descriptionValue.length} / 750
              </div>
            </div>
          )}

          {bulkField === "featured_message" && (
            <div className="mb-5 space-y-2">
              <label className="block text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#777" }}>
                Featured Message <span style={{ color: "#555" }}>(max 50 chars)</span>
              </label>
              <input
                value={featuredMessageValue}
                maxLength={50}
                onChange={(e) => setFeaturedMessageValue(e.target.value)}
                placeholder="Promotional banner text"
                className="w-full px-3 py-2 rounded-md text-xs"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
              />
              <input
                value={featuredMessageUrlValue}
                onChange={(e) => setFeaturedMessageUrlValue(e.target.value)}
                placeholder="Call-to-action URL (optional)"
                className="w-full px-3 py-2 rounded-md text-xs font-mono"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
              />
              <p className="text-[10px]" style={{ color: "#555" }}>Leave both empty to clear the featured message from all selected locations.</p>
            </div>
          )}

          {bulkField === "suppress_address" && (
            <div className="mb-5">
              <label className="flex items-center gap-2.5 px-3 py-2 rounded-md cursor-pointer" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e" }}>
                <input
                  type="checkbox"
                  checked={suppressAddressValue}
                  onChange={(e) => setSuppressAddressValue(e.target.checked)}
                  style={{ accentColor: brandColor }}
                />
                <div>
                  <div className="text-xs" style={{ color: "#ccc" }}>
                    {suppressAddressValue ? "Hide" : "Show"} physical addresses across selected locations
                  </div>
                  <div className="text-[10px]" style={{ color: "#555" }}>For service-area businesses without storefronts</div>
                </div>
              </label>
            </div>
          )}

          {bulkField === "youtube_video" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                YouTube Video URL <span style={{ color: "#555" }}>(max 150 chars, applied to every selected location)</span>
              </label>
              <input
                value={youtubeVideoValue}
                maxLength={150}
                onChange={(e) => setYoutubeVideoValue(e.target.value)}
                placeholder="https://youtube.com/watch?v=…"
                className="w-full px-3 py-2 rounded-md text-xs font-mono"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
              />
              <p className="text-[10px] mt-1" style={{ color: "#555" }}>Leave empty to clear the YouTube video from all selected locations.</p>
            </div>
          )}

          {bulkField === "instagram_username" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                Instagram Handle <span style={{ color: "#555" }}>(max 30 chars; omit the @)</span>
              </label>
              <input
                value={instagramUsernameValue}
                maxLength={30}
                onChange={(e) => setInstagramUsernameValue(e.target.value.replace(/^@/, ""))}
                placeholder="brandhandle"
                className="w-full px-3 py-2 rounded-md text-xs font-mono"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
              />
            </div>
          )}

          {bulkField === "twitter_username" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                Twitter / X Handle <span style={{ color: "#555" }}>(max 15 chars; omit the @)</span>
              </label>
              <input
                value={twitterUsernameValue}
                maxLength={15}
                onChange={(e) => setTwitterUsernameValue(e.target.value.replace(/^@/, ""))}
                placeholder="brandhandle"
                className="w-full px-3 py-2 rounded-md text-xs font-mono"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
              />
            </div>
          )}

          {bulkField === "category_append" && (
            <div className="mb-5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#777" }}>
                Categories to add <span style={{ color: "#555" }}>(appended to each location's existing list, never removes)</span>
              </label>

              {/* Chips for the queue */}
              <div className="flex flex-wrap gap-1.5 mb-2 min-h-[24px]">
                {categoriesToAppend.length === 0 && (
                  <span className="text-[11px] italic" style={{ color: "#555" }}>No categories queued for append</span>
                )}
                {categoriesToAppend.map((cid) => (
                  <span key={cid} className="inline-flex items-center px-2 py-0.5 rounded text-[11px]" style={{ background: "#151517", border: "1px solid #2a2a2e", color: "#aaa" }}>
                    <span className={categoryCatalog && categoryCatalog.length > 0 ? "" : "font-mono"} style={{ marginRight: "6px" }}>{categoryLabel(cid)}</span>
                    <button type="button" onClick={() => removeCategoryFromAppend(cid)} className="hover:opacity-100 opacity-70" style={{ color: "#888" }}>×</button>
                  </span>
                ))}
              </div>

              {categoryCatalog === null && (
                <div className="text-[11px]" style={{ color: "#555" }}>Loading categories ({catalogCountry})…</div>
              )}

              {categoryCatalog && categoryCatalog.length === 0 && (
                <div className="flex gap-2">
                  <input
                    value={categoryQuery}
                    onChange={(e) => setCategoryQuery(e.target.value)}
                    placeholder="Enter category ID"
                    className="flex-1 px-3 py-2 rounded-md text-xs font-mono"
                    style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                  />
                  <button
                    type="button"
                    onClick={() => addCategoryToAppend(categoryQuery.trim())}
                    disabled={!categoryQuery.trim() || categoriesToAppend.length >= 10}
                    className="px-3 py-2 rounded-md text-xs font-semibold"
                    style={{ background: "#222", border: "1px solid #2a2a2e", color: "#aaa", opacity: !categoryQuery.trim() || categoriesToAppend.length >= 10 ? 0.5 : 1 }}
                  >
                    Add
                  </button>
                </div>
              )}

              {categoryCatalog && categoryCatalog.length > 0 && (
                <div className="relative">
                  <input
                    value={categoryQuery}
                    onChange={(e) => setCategoryQuery(e.target.value)}
                    placeholder={`Search ${catalogCountry} categories…`}
                    className="w-full px-3 py-2 rounded-md text-xs"
                    style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
                  />
                  {categoryQuery && filteredCategories.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 z-10 max-h-48 overflow-auto rounded-md" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e" }}>
                      {filteredCategories.map((c) => {
                        const id = c.id || c.category_id;
                        const primary = c.full_name || c.name || c.label || id;
                        const secondary = c.full_name && c.name && c.full_name !== c.name ? c.name : null;
                        const already = categoriesToAppend.includes(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => !already && addCategoryToAppend(id)}
                            disabled={already}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[#222]"
                            style={{ color: already ? "#555" : "#ddd" }}
                          >
                            <div>{primary}</div>
                            {secondary && <div className="text-[10px]" style={{ color: "#666" }}>{secondary}</div>}
                            {already && <span className="text-[10px] ml-2" style={{ color: "#555" }}>(queued)</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <p className="text-[10px] mt-2" style={{ color: "#555" }}>
                Each location can have up to 10 categories total. If a location already has one of these,
                or is already at the 10-category cap, the extra entry will be quietly skipped — nothing is removed.
              </p>
            </div>
          )}

          {/* Estimated-time warning for rich-field bulk runs */}
          {isRichField && !richProgress && selected.size > 0 && (
            <div className="mb-4 px-3 py-2 rounded-md text-[11px] flex items-start gap-2" style={{ background: "#2d1b00", border: "1px solid #5c3a00", color: "#fbbf24" }}>
              <span>⚠</span>
              <div>
                <div className="font-semibold mb-0.5">Rich fields don't have a bulk endpoint</div>
                <div style={{ color: "#fbbf24cc" }}>
                  Each location is updated with its own PATCH request, throttled to {RICH_BULK_DELAY_MS}ms apart.
                  Estimated runtime: {selected.size} requests · ~{estimatedSeconds}s. Keep this tab open until it finishes.
                </div>
              </div>
            </div>
          )}

          {/* Rich-bulk progress display */}
          {richProgress && (
            <div className="mb-5 px-4 py-3 rounded-lg" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e" }}>
              <div className="flex justify-between items-baseline mb-2">
                <span className="text-xs font-semibold" style={{ color: "#aaa" }}>
                  {richProgress.current < richProgress.total ? "Updating…" : "Done"}
                </span>
                <span className="text-[11px] font-mono" style={{ color: "#888" }}>
                  {richProgress.current} / {richProgress.total}
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full overflow-hidden mb-3" style={{ background: "#111113" }}>
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${richProgress.total > 0 ? (richProgress.current / richProgress.total) * 100 : 0}%`,
                    background: brandColor,
                  }}
                />
              </div>
              <div className={`grid ${isAppendCategories ? "grid-cols-4" : "grid-cols-3"} gap-2 text-[11px]`}>
                <div>
                  <div style={{ color: "#888" }}>Succeeded</div>
                  <div className="font-bold" style={{ color: "#34d399" }}>{richProgress.succeeded}</div>
                </div>
                <div>
                  <div style={{ color: "#888" }}>Failed</div>
                  <div className="font-bold" style={{ color: richProgress.failed > 0 ? "#f87171" : "#555" }}>{richProgress.failed}</div>
                </div>
                <div>
                  <div style={{ color: "#888" }}>Skipped (no mapping)</div>
                  <div className="font-bold" style={{ color: richProgress.skipped > 0 ? "#fbbf24" : "#555" }}>{richProgress.skipped}</div>
                </div>
                {isAppendCategories && (
                  <div>
                    <div style={{ color: "#888" }}>Already had all</div>
                    <div className="font-bold" style={{ color: (richProgress.noopCount || 0) > 0 ? "#93c5fd" : "#555" }}>{richProgress.noopCount || 0}</div>
                  </div>
                )}
              </div>
              {richProgress.errors.length > 0 && (
                <div className="mt-3 pt-3" style={{ borderTop: "1px solid #2a2a2e" }}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#f87171" }}>
                    Failures (first {Math.min(richProgress.errors.length, 20)})
                  </div>
                  <div className="space-y-0.5 max-h-32 overflow-auto">
                    {richProgress.errors.map((e, i) => (
                      <div key={i} className="text-[10px] flex gap-2">
                        <span style={{ color: "#ccc" }}>{e.locationName}</span>
                        <span className="font-mono" style={{ color: "#f87171" }}>{e.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md text-xs font-semibold"
              style={{
                background: saved ? "#1c1c1f" : "#222",
                border: `1px solid ${saved ? brandColor + "60" : "#333"}`,
                color: saved ? brandColor : "#aaa",
              }}
            >
              {saved ? "Close" : "Cancel"}
            </button>
            {!saved && (
              <button
                onClick={handleSave}
                disabled={saving || selected.size === 0 || (isAppendCategories && categoriesToAppend.length === 0)}
                className="px-5 py-2 rounded-md text-xs font-semibold text-white transition-opacity"
                style={{
                  background: brandColor,
                  opacity: saving || selected.size === 0 || (isAppendCategories && categoriesToAppend.length === 0) ? 0.6 : 1,
                }}
              >
                {saving ? `Updating ${selected.size} locations...` : `Update ${selected.size} Locations`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
