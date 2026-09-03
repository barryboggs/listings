"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const [syncProgress, setSyncProgress] = useState(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState(null);
  const [enrichProgress, setEnrichProgress] = useState(null);
  const [toast, setToast] = useState(null);

  // Refs so the Stop button can flip a flag that in-flight loops poll.
  // Set to true when user hits Stop; loops check between chunks/batches
  // and exit gracefully — everything already written stays in the DB.
  const syncCancelRef = useRef(false);
  const enrichCancelRef = useRef(false);

  const showToast = (msg, isError) => {
    setToast({ msg, isError });
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

  // Chunk shops on the client side so each server call processes a
  // manageable slice (30 shops) that comfortably fits in Vercel's 5-min
  // maxDuration. Live progress panel updates after every chunk. Stop
  // button flips a ref the loop polls between chunks.
  const SYNC_CHUNK_SIZE = 30;
  const SYNC_INTER_CHUNK_DELAY_MS = 500;

  const handleSync = async ({ fullResync = false } = {}) => {
    if (syncing || !brand) return;
    const msg = fullResync
      ? `Full re-sync of ${brandLabel(brand)}? Bypasses the incremental optimization — walks every shop's full review history from Google. Slower but catches deletions.`
      : `Sync new/updated reviews for ${brandLabel(brand)}? Uses incremental optimization (skips reviews we already have).`;
    if (!confirm(msg)) return;

    // Grab the target shop_ids up front so we can chunk. If the brand's
    // shop list somehow shifts mid-sync (unlikely), the chunks stay
    // pinned to the initial snapshot.
    const brandEligibleShopIds = shops
      .filter((s) => s.brand === brand && s.gbp_location_id)
      .map((s) => s.shop_id);

    if (brandEligibleShopIds.length === 0) {
      showToast(`No mapped shops for ${brandLabel(brand)} — run mapping sync first`, true);
      return;
    }

    const chunks = [];
    for (let i = 0; i < brandEligibleShopIds.length; i += SYNC_CHUNK_SIZE) {
      chunks.push(brandEligibleShopIds.slice(i, i + SYNC_CHUNK_SIZE));
    }

    setSyncing(true);
    setSyncResult(null);
    syncCancelRef.current = false;

    let totalShopsProcessed = 0;
    let totalShopsSkipped = 0;
    let totalReviewsFetched = 0;
    let totalInserted = 0;
    let totalShortCircuited = 0;
    const errors = [];

    setSyncProgress({
      phase: "starting",
      chunk: 0, totalChunks: chunks.length,
      totalShops: brandEligibleShopIds.length,
      shopsProcessed: 0, shopsSkipped: 0,
      reviewsFetched: 0, inserted: 0, shortCircuited: 0,
      errors: [],
    });

    for (let i = 0; i < chunks.length; i++) {
      if (syncCancelRef.current) {
        setSyncProgress((p) => ({ ...p, phase: "cancelled", chunk: i }));
        break;
      }
      setSyncProgress((p) => ({ ...p, phase: "fetching", chunk: i + 1 }));

      try {
        const res = await fetch("/api/gbp/sync-reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brand, shopIds: chunks[i], fullResync }),
        });
        const data = await res.json();
        if (res.ok) {
          totalShopsProcessed += data.shopsProcessed || 0;
          totalShopsSkipped += data.shopsSkipped || 0;
          totalReviewsFetched += data.reviewsFetched || 0;
          totalInserted += data.inserted || 0;
          totalShortCircuited += data.shortCircuited || 0;
          if (Array.isArray(data.errors)) {
            for (const e of data.errors) {
              if (errors.length < 30) errors.push(e);
            }
          }
        } else {
          totalShopsSkipped += chunks[i].length;
          if (errors.length < 30) errors.push({ shopId: "chunk", error: data.error || `HTTP ${res.status}` });
        }
      } catch (e) {
        totalShopsSkipped += chunks[i].length;
        if (errors.length < 30) errors.push({ shopId: "chunk", error: e.message });
      }

      setSyncProgress({
        phase: "fetching",
        chunk: i + 1, totalChunks: chunks.length,
        totalShops: brandEligibleShopIds.length,
        shopsProcessed: totalShopsProcessed,
        shopsSkipped: totalShopsSkipped,
        reviewsFetched: totalReviewsFetched,
        inserted: totalInserted,
        shortCircuited: totalShortCircuited,
        errors,
      });

      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, SYNC_INTER_CHUNK_DELAY_MS));
      }
    }

    setSyncProgress((p) => ({
      ...(p || {}),
      phase: syncCancelRef.current ? "cancelled" : "done",
    }));
    setSyncResult({
      shopsProcessed: totalShopsProcessed,
      shopsSkipped: totalShopsSkipped,
      reviewsFetched: totalReviewsFetched,
      inserted: totalInserted,
      shortCircuited: totalShortCircuited,
      errors,
    });
    setSyncing(false);

    const cancelSuffix = syncCancelRef.current ? " (stopped)" : "";
    const shortNote = totalShortCircuited > 0 ? ` · ${totalShortCircuited} shops short-circuited by incremental` : "";
    showToast(`Synced ${totalReviewsFetched} reviews across ${totalShopsProcessed} shops${shortNote}${cancelSuffix}`);

    fetch(`/api/gbp/reviews-report?brand=${encodeURIComponent(brand)}&month=${month}`)
      .then((r) => r.json())
      .then(setReport)
      .catch(() => {});
  };

  const requestSyncStop = () => {
    syncCancelRef.current = true;
    setSyncProgress((p) => (p ? { ...p, phase: "stopping" } : p));
  };

  // Enrichment auto-continues until remaining=0 or user hits Stop.
  // Server returns the exact remaining count (via countUnenrichedReviews)
  // so the progress bar is accurate instead of "1+" indeterminate.
  const handleEnrich = async () => {
    if (enriching || !brand || !month) return;
    setEnriching(true);
    setEnrichResult(null);
    enrichCancelRef.current = false;

    let totalEnriched = 0;
    let iterations = 0;
    const errors = [];
    let initialRemaining = null;

    setEnrichProgress({
      phase: "starting",
      iterations: 0,
      totalEnriched: 0,
      remaining: null,
      initialRemaining: null,
      errors: [],
    });

    while (true) {
      if (enrichCancelRef.current) break;
      iterations++;
      setEnrichProgress((p) => ({ ...(p || {}), phase: "analyzing", iterations }));

      try {
        const res = await fetch("/api/gbp/enrich-reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brand, month }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (errors.length < 10) errors.push({ iteration: iterations, error: data.error || `HTTP ${res.status}` });
          break;
        }
        totalEnriched += data.enriched || 0;
        if (Array.isArray(data.errors)) {
          for (const e of data.errors) {
            if (errors.length < 10) errors.push({ iteration: iterations, ...e });
          }
        }
        // First iteration's total = initial estimate (enriched + remaining)
        // so the progress bar has a meaningful denominator.
        if (initialRemaining == null) {
          initialRemaining = (data.enriched || 0) + (typeof data.remaining === "number" ? data.remaining : 0);
        }
        setEnrichProgress({
          phase: "analyzing",
          iterations,
          totalEnriched,
          remaining: data.remaining,
          initialRemaining,
          errors,
        });

        // Done — no more unenriched rows in scope.
        if (typeof data.remaining === "number" && data.remaining === 0) break;
        // Safety: if the server reports it didn't enrich anything but says
        // rows remain, something's stuck. Bail rather than loop forever.
        if ((data.enriched || 0) === 0) {
          if (errors.length < 10) errors.push({ iteration: iterations, error: "Iteration enriched 0 rows despite remaining>0 — stopping to avoid infinite loop" });
          break;
        }
      } catch (e) {
        if (errors.length < 10) errors.push({ iteration: iterations, error: e.message });
        break;
      }
    }

    setEnrichProgress((p) => ({ ...(p || {}), phase: enrichCancelRef.current ? "cancelled" : "done" }));
    setEnrichResult({ enriched: totalEnriched, iterations, errors });
    setEnriching(false);

    const label = monthOptions.find((o) => o.value === month)?.label || month;
    const cancelSuffix = enrichCancelRef.current ? " (stopped)" : "";
    showToast(`Enriched ${totalEnriched} reviews for ${label}${cancelSuffix}`);

    fetch(`/api/gbp/reviews-report?brand=${encodeURIComponent(brand)}&month=${month}`)
      .then((r) => r.json())
      .then(setReport)
      .catch(() => {});
  };

  const requestEnrichStop = () => {
    enrichCancelRef.current = true;
    setEnrichProgress((p) => (p ? { ...p, phase: "stopping" } : p));
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
        <div className="fixed top-6 right-6 z-50 px-4 py-3 rounded-lg text-sm font-medium max-w-md flex items-start gap-3" style={{
          background: toast.isError ? "#2d0a0a" : "#0d2818",
          border: `1px solid ${toast.isError ? "#5c1a1a" : "#2d5a2d"}`,
          color: toast.isError ? "#f87171" : "#34d399",
        }}>
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)} aria-label="Dismiss" className="flex-shrink-0 opacity-60 hover:opacity-100" style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}>×</button>
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
          {syncing ? (
            <button
              onClick={requestSyncStop}
              className="px-3 py-2 rounded-md text-xs font-semibold"
              style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}
            >
              Stop sync
            </button>
          ) : (
            <>
              <button
                onClick={() => handleSync({ fullResync: false })}
                disabled={!brand}
                className="px-3 py-2 rounded-md text-xs font-semibold text-white"
                style={{ background: "#0ea5e9" }}
                title="Fast incremental sync — skips reviews we already have. Use for regular refreshes."
              >
                Sync reviews
              </button>
              <button
                onClick={() => handleSync({ fullResync: true })}
                disabled={!brand}
                className="px-2 py-2 rounded-md text-xs"
                style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#888" }}
                title="Full re-sync — walks every review from scratch. Slow, but catches deletions on Google's side."
              >
                Full
              </button>
            </>
          )}
          {enriching ? (
            <button
              onClick={requestEnrichStop}
              className="px-3 py-2 rounded-md text-xs font-semibold"
              style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}
            >
              Stop analysis
            </button>
          ) : (
            <button
              onClick={handleEnrich}
              disabled={!brand}
              className="px-3 py-2 rounded-md text-xs font-semibold"
              style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#a78bfa" }}
              title={`Analyzes all reviews for ${monthLabel} that aren't already enriched. Auto-continues across batches.`}
            >
              {`Analyze themes for ${monthLabel}`}
            </button>
          )}
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

      {/* Live progress panels — shown while sync or enrich is running,
          then remain visible with final state until the user re-triggers. */}
      {syncProgress && (
        <SyncProgressPanel progress={syncProgress} />
      )}
      {enrichProgress && (
        <EnrichProgressPanel progress={enrichProgress} />
      )}

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

          {/* Progress panels above now show the same info live during
              the run and the final counts after completion; the small
              "last sync" / "last analysis" rows are redundant. */}
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

// -------- Progress panels for sync + enrich --------

function ProgressBar({ value, max, color = "#0ea5e9" }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 rounded overflow-hidden" style={{ background: "#1a1a1d" }}>
      <div className="h-full transition-all duration-300" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function SyncProgressPanel({ progress }) {
  const {
    phase, chunk, totalChunks, totalShops,
    shopsProcessed, shopsSkipped, reviewsFetched,
    inserted, shortCircuited, errors,
  } = progress;
  const isRunning = phase === "starting" || phase === "fetching";
  const done = phase === "done";
  const cancelled = phase === "cancelled" || phase === "stopping";
  const accent = cancelled ? "#f87171" : done ? "#34d399" : "#0ea5e9";
  const label = phase === "stopping" ? "Stopping…"
    : cancelled ? "Sync cancelled"
    : done ? "Sync complete"
    : `Syncing… chunk ${chunk}/${totalChunks}`;

  return (
    <div className="rounded-xl p-4 mb-3" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
      <div className="flex justify-between items-center mb-2">
        <div className="text-xs font-bold" style={{ color: accent }}>{label}</div>
        <div className="text-[10px]" style={{ color: "#666" }}>
          {shopsProcessed + shopsSkipped}/{totalShops} shops · {reviewsFetched} reviews landed
          {shortCircuited > 0 && ` · ${shortCircuited} short-circuited by incremental`}
          {shopsSkipped > 0 && ` · ${shopsSkipped} skipped`}
        </div>
      </div>
      <ProgressBar value={chunk} max={totalChunks} color={accent} />
      {isRunning && (
        <div className="text-[10px] mt-1" style={{ color: "#555" }}>
          Client is chunking shops so each server call fits under the 5-min function timeout. Safe to leave the tab open.
        </div>
      )}
      {errors && errors.length > 0 && (
        <div className="mt-2 p-2 rounded max-h-24 overflow-y-auto text-[10px] font-mono" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40", color: "#f87171" }}>
          {errors.slice(0, 10).map((e, i) => (
            <div key={i}>{e.shopId}: {e.error}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function EnrichProgressPanel({ progress }) {
  const {
    phase, iterations, totalEnriched, remaining, initialRemaining, errors,
  } = progress;
  const isRunning = phase === "starting" || phase === "analyzing";
  const done = phase === "done";
  const cancelled = phase === "cancelled" || phase === "stopping";
  const accent = cancelled ? "#f87171" : done ? "#34d399" : "#a78bfa";
  const label = phase === "stopping" ? "Stopping…"
    : cancelled ? "Analysis cancelled"
    : done ? "Analysis complete"
    : `Analyzing… batch ${iterations}`;

  const target = initialRemaining || (totalEnriched + (typeof remaining === "number" ? remaining : 0));

  return (
    <div className="rounded-xl p-4 mb-3" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
      <div className="flex justify-between items-center mb-2">
        <div className="text-xs font-bold" style={{ color: accent }}>{label}</div>
        <div className="text-[10px]" style={{ color: "#666" }}>
          {totalEnriched}{target ? `/${target}` : ""} enriched
          {typeof remaining === "number" && ` · ${remaining} remaining`}
        </div>
      </div>
      <ProgressBar value={totalEnriched} max={target || 1} color={accent} />
      {isRunning && (
        <div className="text-[10px] mt-1" style={{ color: "#555" }}>
          Auto-continues across batches until all reviews for this month are analyzed. Each batch commits to the DB as it completes.
        </div>
      )}
      {errors && errors.length > 0 && (
        <div className="mt-2 p-2 rounded max-h-24 overflow-y-auto text-[10px] font-mono" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40", color: "#f87171" }}>
          {errors.slice(0, 10).map((e, i) => (
            <div key={i}>batch {e.iteration}: {e.error}</div>
          ))}
        </div>
      )}
    </div>
  );
}
