"use client";

import { useEffect, useMemo, useState } from "react";
import { useUser } from "../layout";
import { getBrandConfig } from "@/lib/data";

/**
 * Monthly review report — brand-level aggregation of Google Business
 * Profile reviews. Per AGN team requirements (2026-08-11):
 *   1. Show top things customers are saying, positive AND negative
 *   2. Monthly cadence; first target period is July 2026
 *   3. Brand-level, not per-location
 *
 * Admin-only. Reads from lm_reviews (populated by /api/gbp/sync-reviews)
 * and lm_review_enrichments (populated by /api/gbp/enrich-reviews).
 * Report data comes from /api/gbp/reviews-report which stitches both.
 */

const THEME_LABELS = {
  quality: "Quality of work",
  price: "Pricing",
  staff: "Staff",
  wait_time: "Wait time",
  communication: "Communication",
  location: "Location / access",
  cleanliness: "Cleanliness",
  scheduling: "Scheduling",
  value: "Value",
  other: "Other",
};

const themeLabel = (tag) => THEME_LABELS[tag] || tag;

// Build the last 12 month options ending at the previous complete month.
// If today is 2026-08-11, the default is 2026-07 and the list runs
// back to 2025-08.
function buildMonthOptions(now = new Date()) {
  const opts = [];
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed; last COMPLETE month is (m - 1)
  for (let i = 1; i <= 12; i++) {
    const d = new Date(Date.UTC(y, m - i, 1));
    const monthStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    opts.push({ value: monthStr, label });
  }
  return opts;
}

function fmtPct(n) {
  return `${Math.round((n || 0) * 100)}%`;
}

function formatDelta(cur, prev, formatter) {
  if (prev == null || cur == null) return null;
  const delta = cur - prev;
  if (Math.abs(delta) < 0.005) return { text: "no change", color: "#666" };
  const arrow = delta > 0 ? "↑" : "↓";
  const color = delta > 0 ? "#34d399" : "#f87171";
  return { text: `${arrow} ${formatter(Math.abs(delta))}`, color };
}

export default function ReviewsPage() {
  const currentUser = useUser();
  const monthOptions = useMemo(() => buildMonthOptions(), []);
  const defaultMonth = monthOptions[0]?.value; // previous complete month

  const [shops, setShops] = useState([]);
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState("");
  const [month, setMonth] = useState(defaultMonth);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg, isError) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 5000);
  };

  const isAdmin = currentUser?.role === "admin";

  // Load shops once — used to derive the eligible brand list
  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/shops")
      .then((r) => r.json())
      .then((data) => {
        setShops(data.shops || []);
        // Brands with at least one mapped GBP location can appear in reviews
        const byBrand = new Map();
        for (const s of data.shops || []) {
          if (!s.gbp_location_id) continue;
          const b = s.brand || "unknown";
          byBrand.set(b, (byBrand.get(b) || 0) + 1);
        }
        const list = [...byBrand.entries()]
          .map(([id, count]) => ({ id, count, ...(getBrandConfig(id) || {}) }))
          .sort((a, b) => b.count - a.count);
        setBrands(list);
        // Default brand to Auto Glass Now if present (the AGN team is
        // the initial audience), otherwise the largest brand.
        if (!brand) {
          const agn = list.find((b) => b.id === "autoglass");
          setBrand((agn || list[0])?.id || "");
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // Fetch report whenever brand or month changes
  useEffect(() => {
    if (!brand || !month || !isAdmin) return;
    setLoading(true);
    setReport(null);
    fetch(`/api/gbp/reviews-report?brand=${encodeURIComponent(brand)}&month=${month}`)
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) {
          showToast(body.error || "Failed to load report", true);
          return;
        }
        setReport(body);
      })
      .catch((e) => showToast(`Failed: ${e.message}`, true))
      .finally(() => setLoading(false));
  }, [brand, month, isAdmin]);

  const brandLabel = (id) => brands.find((b) => b.id === id)?.name || id;

  const handleSync = async () => {
    if (syncing || !brand) return;
    if (!confirm(`Sync reviews for ${brandLabel(brand)}? This may take a few minutes for large brands.`)) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/gbp/sync-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand }),
      });
      const data = await res.json();
      if (res.ok) {
        setSyncResult(data);
        showToast(`Synced ${data.reviewsFetched} reviews across ${data.shopsProcessed} shops`);
        // Re-fetch report so numbers refresh
        setTimeout(() => {
          fetch(`/api/gbp/reviews-report?brand=${encodeURIComponent(brand)}&month=${month}`)
            .then((r) => r.json())
            .then(setReport)
            .catch(() => {});
        }, 500);
      } else {
        showToast(data.error || "Sync failed", true);
      }
    } catch (e) {
      showToast(e.message, true);
    }
    setSyncing(false);
  };

  // Scope enrichment to the CURRENTLY-VIEWED month. Matches the AGN
  // team's use case (monthly reports) and keeps cost/time proportional
  // to a single month's reviews (~5-15% of all-time). If they want all
  // months enriched later, we can add an "Enrich all months" secondary
  // button; for now, per-month matches the report shape.
  const handleEnrich = async () => {
    if (enriching || !brand || !month) return;
    setEnriching(true);
    setEnrichResult(null);
    try {
      const res = await fetch("/api/gbp/enrich-reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand, month }),
      });
      const data = await res.json();
      if (res.ok) {
        setEnrichResult(data);
        const remainingNote = data.remaining && data.remaining !== 0
          ? ` — more remain, re-run to continue`
          : "";
        const label = monthOptions.find((o) => o.value === month)?.label || month;
        showToast(`Enriched ${data.enriched} reviews for ${label}${remainingNote}`);
        setTimeout(() => {
          fetch(`/api/gbp/reviews-report?brand=${encodeURIComponent(brand)}&month=${month}`)
            .then((r) => r.json())
            .then(setReport)
            .catch(() => {});
        }, 500);
      } else {
        showToast(data.error || "Enrichment failed", true);
      }
    } catch (e) {
      showToast(e.message, true);
    }
    setEnriching(false);
  };

  const brandColor = brands.find((b) => b.id === brand)?.color || "#888";

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-3xl mb-3">🔒</div>
          <h2 className="text-base font-bold text-white mb-1">Access Restricted</h2>
          <p className="text-sm" style={{ color: "#666" }}>Admin access required.</p>
        </div>
      </div>
    );
  }

  const stats = report?.stats;
  const prev = report?.prevStats;
  const themes = report?.themes || { positive: [], negative: [] };
  const monthLabel = monthOptions.find((o) => o.value === month)?.label || month;
  const hasEnrichment = (themes.positive?.length || 0) + (themes.negative?.length || 0) > 0;
  const hasReviews = (stats?.total || 0) > 0;

  return (
    <>
      {toast && (
        <div className="fixed top-6 right-6 z-50 px-4 py-3 rounded-lg text-sm font-medium max-w-md" style={{
          background: toast.isError ? "#2d0a0a" : "#0d2818",
          border: `1px solid ${toast.isError ? "#5c1a1a" : "#2d5a2d"}`,
          color: toast.isError ? "#f87171" : "#34d399",
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header + pickers + sync buttons */}
      <div className="mb-5 flex flex-wrap justify-between items-end gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">
            {brandLabel(brand)} — Review Report for {monthLabel}
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "#666" }}>
            Brand-level aggregation of Google Business Profile reviews. Admin-only.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="px-3 py-2 rounded-md text-xs font-semibold"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
          >
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.count})</option>
            ))}
          </select>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-2 rounded-md text-xs font-semibold"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
          >
            {monthOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={handleSync}
            disabled={syncing || !brand}
            className="px-3 py-2 rounded-md text-xs font-semibold text-white"
            style={{ background: "#0ea5e9", opacity: syncing ? 0.5 : 1 }}
          >
            {syncing ? "Syncing…" : "Sync reviews"}
          </button>
          <button
            onClick={handleEnrich}
            disabled={enriching || !brand}
            className="px-3 py-2 rounded-md text-xs font-semibold"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#a78bfa", opacity: enriching ? 0.5 : 1 }}
            title={`Analyzes only the reviews shown in the current month (${monthLabel}). Cheap and fast.`}
          >
            {enriching ? "Analyzing…" : `Analyze themes for ${monthLabel}`}
          </button>
          <a
            href={brand && month ? `/api/gbp/reviews-export?brand=${encodeURIComponent(brand)}&month=${month}` : "#"}
            className="px-3 py-2 rounded-md text-xs font-semibold"
            style={{
              background: "#1c1c1f",
              border: "1px solid #2a2a2e",
              color: hasReviews ? "#6ee7b7" : "#555",
              textDecoration: "none",
              pointerEvents: hasReviews ? "auto" : "none",
              opacity: hasReviews ? 1 : 0.5,
            }}
            title={hasReviews ? `Download the ${monthLabel} report as XLSX (4 sheets: Summary, Top Positive, Top Negative, All Reviews)` : "Sync + analyze reviews first"}
          >
            ⬇ Download XLSX
          </a>
        </div>
      </div>

      {loading && (
        <div className="text-center py-12 text-xs" style={{ color: "#666" }}>Loading report…</div>
      )}

      {!loading && !hasReviews && (
        <div className="rounded-xl p-8 text-center" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
          <div className="text-2xl mb-2">📭</div>
          <div className="text-sm font-semibold text-white mb-1">No reviews found for this brand and month</div>
          <div className="text-xs" style={{ color: "#666" }}>
            Click <strong>Sync reviews</strong> to pull the latest reviews from Google Business Profile.
          </div>
        </div>
      )}

      {!loading && hasReviews && (
        <>
          {/* Hero: top themes */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
            <ThemesCard
              title="Top Positive Themes"
              accentColor="#34d399"
              accentBg="#0d2818"
              accentBorder="#2d5a2d"
              themes={themes.positive || []}
              emptyMessage={hasEnrichment ? "No positive themes for this month." : "Analyze themes to populate this panel."}
            />
            <ThemesCard
              title="Top Negative Themes"
              accentColor="#f87171"
              accentBg="#2d0a0a"
              accentBorder="#5c1a1a"
              themes={themes.negative || []}
              emptyMessage={hasEnrichment ? "No negative themes for this month." : "Analyze themes to populate this panel."}
            />
          </div>

          {!hasEnrichment && (
            <div className="mb-5 p-3 rounded-md text-xs" style={{ background: "#1a1a1d", border: "1px solid #2a2a2e", color: "#a78bfa" }}>
              <strong>Themes not yet analyzed for this brand.</strong> Click <strong>Analyze themes</strong> to have Claude read the reviews and extract what customers are saying. Runs in batches; may take a few minutes on the first run.
            </div>
          )}

          {/* Supporting metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <MetricCard
              label="Reviews"
              value={stats.total}
              delta={formatDelta(stats.total, prev?.total, (n) => `${n}`)}
              detail={prev ? `vs ${prev.total} in ${report.prevMonth}` : null}
            />
            <MetricCard
              label="Avg Rating"
              value={stats.avg_rating != null ? stats.avg_rating.toFixed(2) : "—"}
              suffix="★"
              delta={formatDelta(stats.avg_rating, prev?.avg_rating, (n) => n.toFixed(2))}
              detail={prev?.avg_rating != null ? `vs ${prev.avg_rating.toFixed(2)} in ${report.prevMonth}` : null}
            />
            <MetricCard
              label="Response Rate"
              value={fmtPct(stats.response_rate)}
              delta={formatDelta(stats.response_rate, prev?.response_rate, (n) => fmtPct(n))}
              detail={prev ? `vs ${fmtPct(prev.response_rate)} in ${report.prevMonth}` : null}
            />
            <RatingDistribution distribution={stats.distribution} total={stats.total} />
          </div>

          {syncResult && (
            <div className="mb-5 p-3 rounded text-xs" style={{ background: "#1a1a1d", border: "1px solid #222", color: "#aaa" }}>
              Last sync: {syncResult.shopsProcessed}/{syncResult.shopsProcessed + syncResult.shopsSkipped} shops · {syncResult.reviewsFetched} reviews fetched
              {syncResult.errors && ` · ${syncResult.errors.length} shops errored`}
            </div>
          )}

          {enrichResult && (
            <div className="mb-5 p-3 rounded text-xs" style={{ background: "#1a1a1d", border: "1px solid #222", color: "#aaa" }}>
              Last analysis: {enrichResult.enriched} reviews analyzed{enrichResult.remaining > 0 ? ` · ${enrichResult.remaining} still to process` : ""}
              {enrichResult.errors && ` · ${enrichResult.errors.length} errors`}
            </div>
          )}
        </>
      )}
    </>
  );
}

function ThemesCard({ title, accentColor, accentBg, accentBorder, themes, emptyMessage }) {
  return (
    <div className="rounded-xl p-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
      <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: accentColor }}>{title}</h3>
      {themes.length === 0 ? (
        <div className="text-xs py-4" style={{ color: "#666" }}>{emptyMessage}</div>
      ) : (
        <div className="space-y-2">
          {themes.map((t) => (
            <div key={t.tag} className="p-3 rounded-md" style={{ background: accentBg, border: `1px solid ${accentBorder}` }}>
              <div className="flex justify-between items-baseline mb-1.5">
                <div className="text-sm font-semibold" style={{ color: accentColor }}>{themeLabel(t.tag)}</div>
                <div className="text-[11px] font-mono" style={{ color: `${accentColor}cc` }}>{t.count} mentions</div>
              </div>
              {t.sample_quotes && t.sample_quotes.length > 0 && (
                <div className="space-y-1">
                  {t.sample_quotes.slice(0, 2).map((q, i) => (
                    <div key={i} className="text-[11px] leading-snug italic" style={{ color: "#aaa" }}>
                      &ldquo;{q}&rdquo;
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, suffix, delta, detail }) {
  return (
    <div className="p-4 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#888" }}>{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <div className="text-2xl font-bold text-white">{value}</div>
        {suffix && <div className="text-sm" style={{ color: "#888" }}>{suffix}</div>}
      </div>
      {delta && (
        <div className="text-[11px] mt-1" style={{ color: delta.color }}>{delta.text}</div>
      )}
      {detail && (
        <div className="text-[10px] mt-0.5" style={{ color: "#555" }}>{detail}</div>
      )}
    </div>
  );
}

function RatingDistribution({ distribution, total }) {
  const max = Math.max(1, ...Object.values(distribution));
  return (
    <div className="p-4 rounded-lg" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#888" }}>Rating Distribution</div>
      <div className="space-y-1">
        {[5, 4, 3, 2, 1].map((r) => {
          const count = distribution[r] || 0;
          const pctOfMax = (count / max) * 100;
          const color = r >= 4 ? "#34d399" : r === 3 ? "#fbbf24" : "#f87171";
          return (
            <div key={r} className="flex items-center gap-2 text-[10px]">
              <div style={{ color: "#888", width: 12 }}>{r}★</div>
              <div className="flex-1 h-3 rounded overflow-hidden" style={{ background: "#1a1a1d" }}>
                <div className="h-full" style={{ width: `${pctOfMax}%`, background: color }} />
              </div>
              <div className="font-mono" style={{ color: "#aaa", width: 30, textAlign: "right" }}>{count}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
