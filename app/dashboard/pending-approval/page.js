"use client";

import { useEffect, useMemo, useState } from "react";
import { useUser } from "../layout";
import { getBrandConfig } from "@/lib/data";

/**
 * Pending Approval queue.
 *
 * Semrush's API doesn't expose its moderation queue ("Updates" tab in their
 * UI), so we log every successful push from this app into lm_pending_pushes
 * and surface it here. Each row gets a deep link straight to that shop's
 * Updates tab in Semrush — the user clicks Accept there, then clicks
 * "Mark Done" here so the queue stops surfacing it.
 *
 * Honest limitations: this only knows about pushes that went through this
 * app. Updates someone made directly in Semrush's UI are invisible to us.
 * "Mark Done" is user-attested, not Semrush-verified — Semrush has no
 * "was this approved?" endpoint we can poll.
 */
export default function PendingApprovalPage() {
  const currentUser = useUser();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [includeDone, setIncludeDone] = useState(false);
  const [brandFilter, setBrandFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [marking, setMarking] = useState(null); // location id currently marking
  const [markingAll, setMarkingAll] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (msg, isError) => {
    setToast({ msg, isError });
  };

  const fetchRows = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (includeDone) params.set("includeDone", "true");
      const res = await fetch(`/api/pending-pushes?${params.toString()}`);
      const data = await res.json();
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (e) {
      showToast("Failed to load queue: " + e.message, true);
    }
    setLoading(false);
  };

  useEffect(() => { fetchRows(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [includeDone]);

  // Dedupe by location — the API returns one row per push event, but the
  // user thinks per-shop. Aggregate push count and field list, keep most
  // recent pushed_at (rows come back ordered DESC, so the first hit wins).
  const groupedAll = useMemo(() => {
    const byLoc = new Map();
    for (const r of rows) {
      const key = r.semrush_location_id;
      if (!key) continue;
      const existing = byLoc.get(key);
      if (!existing) {
        byLoc.set(key, {
          semrush_location_id: r.semrush_location_id,
          semrush_new_id: r.semrush_new_id || null,
          location_name: r.location_name || "",
          shop_id: r.shop_id || "",
          brand: r.brand || "",
          pushedAt: r.pushed_at,
          pushedBy: r.pushed_by || "",
          fields: new Set(r.fields ? [r.fields] : []),
          pushCount: 1,
        });
      } else {
        existing.pushCount++;
        if (r.fields) existing.fields.add(r.fields);
      }
    }
    return Array.from(byLoc.values());
  }, [rows]);

  // Brands present in the queue, with counts — drives the chip row
  const byBrand = useMemo(() => {
    const acc = {};
    for (const g of groupedAll) {
      const b = g.brand || "unknown";
      acc[b] = (acc[b] || 0) + 1;
    }
    return acc;
  }, [groupedAll]);

  const visible = useMemo(() => {
    let list = groupedAll;
    if (brandFilter !== "all") list = list.filter((g) => g.brand === brandFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((g) =>
        (g.location_name && g.location_name.toLowerCase().includes(q)) ||
        (g.shop_id && String(g.shop_id).toLowerCase().includes(q))
      );
    }
    return list;
  }, [groupedAll, brandFilter, search]);

  const buildDeepLink = (newId) =>
    newId ? `https://www.semrush.com/gbp-optimization/location/${newId}/updates/?type=DIFF&status=NEW` : null;

  const handleMarkDone = async (group) => {
    setMarking(group.semrush_location_id);
    try {
      const res = await fetch("/api/pending-pushes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_done", semrushLocationId: group.semrush_location_id }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Marked ${data.marked} push${data.marked === 1 ? "" : "es"} done — ${group.location_name}`);
        fetchRows();
      } else {
        showToast(data.error || "Mark done failed", true);
      }
    } catch (e) {
      showToast("Network error: " + e.message, true);
    }
    setMarking(null);
  };

  const handleMarkAllDone = async () => {
    const scopeLabel = brandFilter === "all"
      ? `all ${groupedAll.length} shop(s)`
      : `${visible.length} ${getBrandConfig(brandFilter).name} shop(s)`;
    if (!confirm(`Mark ${scopeLabel} as done? You should only do this once you've accepted them in Semrush.`)) return;

    setMarkingAll(true);
    try {
      const body = brandFilter === "all"
        ? { action: "mark_all_done" }
        : { action: "mark_all_done", brand: brandFilter };
      const res = await fetch("/api/pending-pushes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`Marked ${data.marked} push${data.marked === 1 ? "" : "es"} done`);
        fetchRows();
      } else {
        showToast(data.error || "Mark all failed", true);
      }
    } catch (e) {
      showToast("Network error: " + e.message, true);
    }
    setMarkingAll(false);
  };

  if (currentUser?.role === "viewer") {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-3xl mb-3">🔒</div>
          <h2 className="text-base font-bold text-white mb-1">Viewers can&apos;t access the push queue</h2>
        </div>
      </div>
    );
  }

  return (
    <>
      {toast && (
        <div className="fixed bottom-6 right-6 z-[60] animate-slide-up px-5 py-3 rounded-lg text-sm font-medium flex items-start gap-3 max-w-lg" style={{ background: toast.isError ? "#2d0a0a" : "#1a2e1a", border: `1px solid ${toast.isError ? "#5c1a1a" : "#2d5a2d"}`, color: toast.isError ? "#f87171" : "#6ee7b7" }}>
          <span className="flex-shrink-0 mt-0.5">{toast.isError ? "✗" : "✓"}</span>
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="flex-shrink-0 opacity-60 hover:opacity-100" style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}>×</button>
        </div>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">Pending Approval in Semrush</h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>
            Shops you&apos;ve pushed to that may still be waiting in Semrush&apos;s Updates queue. Click &ldquo;Open in Semrush&rdquo; to accept, then &ldquo;Mark Done&rdquo; here to clear it.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "#aaa" }}>
            <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} style={{ accentColor: "#93c5fd" }} />
            Show done
          </label>
          {visible.length > 0 && !includeDone && (
            <button
              onClick={handleMarkAllDone}
              disabled={markingAll}
              className="px-3 py-1.5 rounded-md text-xs font-semibold"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa", opacity: markingAll ? 0.6 : 1 }}
            >
              {markingAll ? "Marking…" : `Mark ${visible.length} Done`}
            </button>
          )}
          <button
            onClick={fetchRows}
            className="px-3 py-1.5 rounded-md text-xs font-semibold"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="flex gap-3 mb-4">
        <div className="px-4 py-3 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="text-[11px] font-semibold" style={{ color: "#888" }}>{includeDone ? "Done" : "Open"}</div>
          <div className="text-2xl font-bold mt-0.5" style={{ color: includeDone ? "#34d399" : "#fbbf24" }}>{groupedAll.length}</div>
          <div className="text-[10px] mt-0.5" style={{ color: "#555" }}>{rows.length} push event{rows.length === 1 ? "" : "s"} total</div>
        </div>
      </div>

      {/* Brand filter chips */}
      {Object.keys(byBrand).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          <button
            onClick={() => setBrandFilter("all")}
            className="px-2.5 py-1 rounded text-[11px] font-semibold"
            style={{
              background: brandFilter === "all" ? "#1c1c1f" : "transparent",
              border: `1px solid ${brandFilter === "all" ? "#2a2a2e" : "transparent"}`,
              color: brandFilter === "all" ? "#ddd" : "#666",
            }}
          >
            All ({groupedAll.length})
          </button>
          {Object.entries(byBrand)
            .sort((a, b) => b[1] - a[1])
            .map(([bid, count]) => {
              const cfg = getBrandConfig(bid);
              const active = brandFilter === bid;
              return (
                <button
                  key={bid}
                  onClick={() => setBrandFilter(active ? "all" : bid)}
                  className="px-2.5 py-1 rounded text-[11px] font-semibold"
                  style={{
                    background: active ? cfg.color + "25" : cfg.color + "10",
                    border: `1px solid ${active ? cfg.color : cfg.color + "30"}`,
                    color: cfg.color,
                  }}
                >
                  {cfg.name} ({count})
                </button>
              );
            })}
        </div>
      )}

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by shop # or location name…"
        className="w-full px-3 py-2 mb-3 rounded-md text-xs"
        style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#ddd" }}
      />

      {/* Rows */}
      <div className="rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        {loading ? (
          <div className="py-10 text-center text-sm" style={{ color: "#666" }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: "#666" }}>
            {groupedAll.length === 0 ? (
              includeDone
                ? "No completed pushes yet."
                : "No shops waiting for approval. Push some updates and they'll show up here."
            ) : (
              "No shops match the current filter."
            )}
          </div>
        ) : (
          visible.map((g, i) => {
            const cfg = getBrandConfig(g.brand);
            const link = buildDeepLink(g.semrush_new_id);
            const busy = marking === g.semrush_location_id;
            const fieldList = Array.from(g.fields).filter(Boolean).join(", ");
            const date = g.pushedAt ? new Date(g.pushedAt).toLocaleString() : "—";
            return (
              <div key={g.semrush_location_id} className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: i < visible.length - 1 ? "1px solid #1a1a1d" : "none", background: i % 2 === 0 ? "#151517" : "#131315" }}>
                <span className="w-1 h-8 rounded-sm flex-shrink-0" style={{ background: cfg.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {g.shop_id && (
                      <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded" style={{ background: "#0c1a2e", color: "#93c5fd" }}>#{g.shop_id}</span>
                    )}
                    <span className="text-sm text-white truncate">{g.location_name || g.semrush_location_id}</span>
                    {g.pushCount > 1 && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: "#2d1b00", color: "#fbbf24", border: "1px solid #5c3a00" }}>
                        {g.pushCount} pushes
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] mt-0.5 truncate" style={{ color: "#666" }}>
                    <span style={{ color: cfg.color }}>{cfg.name}</span>
                    {fieldList && <> · {fieldList}</>}
                    {" · "}{date}
                    {g.pushedBy && <> · by {g.pushedBy}</>}
                  </div>
                </div>
                {link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded text-[11px] font-semibold flex-shrink-0"
                    style={{ background: "#0c1a2e", border: "1px solid #1e3a5f", color: "#93c5fd", textDecoration: "none" }}
                  >
                    Open in Semrush ↗
                  </a>
                ) : (
                  <span
                    className="px-3 py-1.5 rounded text-[11px] font-semibold flex-shrink-0"
                    style={{ background: "#1a1a1d", border: "1px solid #2a2a2e", color: "#666", cursor: "not-allowed" }}
                    title="No rich-API mapping for this shop. Run /api/db/sync-rich-mappings (admin) to enable the deep link."
                  >
                    No mapping
                  </span>
                )}
                {!includeDone && (
                  <button
                    onClick={() => handleMarkDone(g)}
                    disabled={busy}
                    className="px-3 py-1.5 rounded text-[11px] font-semibold flex-shrink-0"
                    style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa", opacity: busy ? 0.5 : 1 }}
                  >
                    {busy ? "Saving…" : "Mark Done"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Help text */}
      <div className="mt-5 p-4 rounded-lg" style={{ background: "#1a1a1d", border: "1px solid #222" }}>
        <h4 className="text-xs font-bold mb-2" style={{ color: "#aaa" }}>How this works</h4>
        <div className="text-xs leading-relaxed space-y-1.5" style={{ color: "#777" }}>
          <p>Every successful push from this app (single edit, bulk update, holiday import) is logged here. Semrush&apos;s API doesn&apos;t let us see their actual Updates queue, so this is our inferred view.</p>
          <p><strong style={{ color: "#aaa" }}>Workflow:</strong> Click <em>Open in Semrush</em> on a row → accept/reject in Semrush&apos;s UI → come back and click <em>Mark Done</em>.</p>
          <p><strong style={{ color: "#aaa" }}>Limits:</strong> Updates made directly in Semrush&apos;s UI aren&apos;t tracked here. &ldquo;Mark Done&rdquo; is user-attested — we can&apos;t verify Semrush actually accepted the change.</p>
          <p><strong style={{ color: "#aaa" }}>No deep link?</strong> The shop hasn&apos;t been mapped to the rich API yet. Admin: run the rich-mappings sync from the Admin page to enable Open-in-Semrush links.</p>
        </div>
      </div>
    </>
  );
}
