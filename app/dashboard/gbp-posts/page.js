"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "../layout";
import { getBrandConfig } from "@/lib/data";

/**
 * Bulk-post to every Google Business Profile in a brand.
 *
 * Post types (v1 scope): STANDARD (with optional image + CTA), OFFER
 * (with title + date range + optional coupon/redeem/terms).
 *
 * Batching mirrors the listings-photos page: client chunks selected
 * shops into BATCH_SIZE-sized groups, POSTs each chunk to
 * /api/gbp/bulk-post, sleeps INTER_BATCH_DELAY_MS between chunks. A
 * single batchId (client-generated) stitches all chunks in the audit
 * table so the history panel treats one bulk run as one row.
 *
 * Only shops with gbp_location_id populated are eligible; unmapped
 * shops surface as "N unmapped" so admins know to re-run the GBP
 * mapping sync on /dashboard/admin.
 */

const BATCH_SIZE = 30;
// Between chunks. Kept generous because GBP's per-project quota (300 QPM)
// is easy to burn when several admins run pushes concurrently, and
// posts-per-profile quota (~10/min) is enforced per shop, but only
// matters if we're posting more than once to the same profile in the
// same window — which we aren't.
const INTER_BATCH_DELAY_MS = 8000;

// CTA options for STANDARD posts. Google restricts to this set.
const CTA_ACTIONS = [
  { value: "", label: "None" },
  { value: "LEARN_MORE", label: "Learn more" },
  { value: "BOOK", label: "Book" },
  { value: "ORDER", label: "Order online" },
  { value: "SHOP", label: "Shop" },
  { value: "SIGN_UP", label: "Sign up" },
  { value: "CALL", label: "Call (uses shop's primary phone)" },
];

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function safeRenderable(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return "[unrenderable]";
  }
}

export default function GbpPostsPage() {
  const currentUser = useUser();
  const cancelRef = useRef(false);
  const fileInputRef = useRef(null);

  // Shop list — needed for brand picker + per-brand eligibility counts.
  const [shops, setShops] = useState([]);
  const [shopsLoading, setShopsLoading] = useState(true);

  // Selection
  const [brandFilter, setBrandFilter] = useState("");
  const [deselectedShopIds, setDeselectedShopIds] = useState(() => new Set());
  const [showShopList, setShowShopList] = useState(false);
  const [shopSearch, setShopSearch] = useState("");
  // Batch controls — supports the "post one version to 50 shops, then
  // a different version to the next 50" workflow. Batch size default 50
  // aligns with the server-side chunk cap on /api/gbp/bulk-post.
  const [batchSize, setBatchSize] = useState(50);

  // Composer
  const [topicType, setTopicType] = useState("STANDARD");
  const [summary, setSummary] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [uploadMeta, setUploadMeta] = useState(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  // STANDARD CTA
  const [ctaAction, setCtaAction] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [ctaUrlMode, setCtaUrlMode] = useState("same"); // "same" | "shop"
  // Pre-filled with the sensible default so the admin can push a
  // shop-URL-mode post without having to type UTMs every time. Editable.
  const [ctaUtm, setCtaUtm] = useState("?utm_source=google&utm_medium=organic&utm_campaign=gbp_post");

  // OFFER fields
  const [offerTitle, setOfferTitle] = useState("");
  const [offerStartDate, setOfferStartDate] = useState("");
  const [offerEndDate, setOfferEndDate] = useState("");
  const [offerCoupon, setOfferCoupon] = useState("");
  const [offerRedeemUrl, setOfferRedeemUrl] = useState("");
  const [offerRedeemMode, setOfferRedeemMode] = useState("same"); // "same" | "shop"
  const [offerRedeemUtm, setOfferRedeemUtm] = useState("?utm_source=google&utm_medium=organic&utm_campaign=gbp_offer_post");
  const [offerTerms, setOfferTerms] = useState("");

  // Push flow
  const [pushing, setPushing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // History
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Per-batch verification state. Keyed by batch_id. Values:
  //   { verifying: bool, verified, missing, errored, results: [...] }
  // Set when admin clicks Verify on a history row; the panel below
  // that row expands to show the outcome.
  const [verifyByBatch, setVerifyByBatch] = useState({});

  const [toast, setToast] = useState(null);

  const showToast = (msg, isError) => {
    setToast({ msg, isError });
  };

  const canPush = currentUser?.role === "admin" || currentUser?.role === "manager";

  // Load shops once on mount. Reuse /api/shops which returns
  // lm_shop_numbers with gbp_location_id populated where the mapping
  // sync has run.
  useEffect(() => {
    fetch("/api/shops")
      .then((r) => r.json())
      .then((data) => setShops(data.shops || []))
      .catch(() => {})
      .finally(() => setShopsLoading(false));
  }, []);

  const fetchHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/gbp/bulk-post?limit=50");
      const data = await res.json();
      setHistory(Array.isArray(data.batches) ? data.batches : []);
    } catch {
      setHistory([]);
    }
    setHistoryLoading(false);
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  // Group shops by brand for the picker. Only brands where at least
  // one shop has a gbp_location_id are worth showing.
  const brandStats = useMemo(() => {
    const byBrand = new Map();
    for (const s of shops) {
      const brand = s.brand || "unknown";
      if (!byBrand.has(brand)) {
        byBrand.set(brand, { brand, total: 0, eligible: 0 });
      }
      const b = byBrand.get(brand);
      b.total++;
      if (s.gbp_location_id) b.eligible++;
    }
    return [...byBrand.values()]
      .filter((b) => b.eligible > 0)
      .sort((a, b) => b.eligible - a.eligible);
  }, [shops]);

  const brandShops = useMemo(() => {
    if (!brandFilter) return [];
    return shops.filter((s) => s.brand === brandFilter);
  }, [shops, brandFilter]);

  const eligibleShops = useMemo(
    () => brandShops.filter((s) => s.gbp_location_id),
    [brandShops]
  );

  // Search-filtered subset. Substring match on shop_id / city / state,
  // case-insensitive. Empty search = whole list. The batch selector
  // and Select/Deselect all operate on THIS list, so the admin can
  // narrow to a region ("TX") and batch-select within it.
  const filteredShops = useMemo(() => {
    if (!shopSearch.trim()) return eligibleShops;
    const q = shopSearch.trim().toLowerCase();
    return eligibleShops.filter((s) =>
      (s.shop_id || "").toLowerCase().includes(q) ||
      (s.city || "").toLowerCase().includes(q) ||
      (s.state || "").toLowerCase().includes(q)
    );
  }, [eligibleShops, shopSearch]);

  const selectedShops = useMemo(
    () => eligibleShops.filter((s) => !deselectedShopIds.has(s.shop_id)),
    [eligibleShops, deselectedShopIds]
  );

  // Batches computed from the filtered (or full) list. Each batch is a
  // slice of `batchSize` shops. The dropdown shows one entry per batch
  // with human-readable range labels ("Shops 1-50", "Shops 51-100", ...).
  // Sort is stable (shops arrive already ordered by shop_id from
  // /api/shops), so batch #N always contains the same shops until the
  // brand's shop set changes.
  const batches = useMemo(() => {
    const size = Math.max(1, batchSize);
    const out = [];
    for (let i = 0; i < filteredShops.length; i += size) {
      const chunk = filteredShops.slice(i, i + size);
      out.push({
        index: out.length + 1,
        startPos: i + 1,
        endPos: i + chunk.length,
        shopIds: chunk.map((s) => s.shop_id),
      });
    }
    return out;
  }, [filteredShops, batchSize]);

  const unmappedCount = brandShops.length - eligibleShops.length;

  // Reset deselection when brand changes
  useEffect(() => {
    setDeselectedShopIds(new Set());
    setShopSearch("");
  }, [brandFilter]);

  // Selecting a batch clears any existing selection and picks JUST that
  // batch's shops. Handles the "post version A to shops 1-50, then a
  // different version to 51-100" workflow directly.
  const selectBatch = (batchIndex) => {
    const b = batches.find((x) => x.index === batchIndex);
    if (!b) return;
    const idsInBatch = new Set(b.shopIds);
    // Deselect everything NOT in this batch (deselection set is the inverse
    // of selection — anything not in this set is selected).
    const nextDeselected = new Set(eligibleShops.map((s) => s.shop_id).filter((id) => !idsInBatch.has(id)));
    setDeselectedShopIds(nextDeselected);
    // If the list is collapsed, no visual confirmation — pop it open.
    setShowShopList(true);
  };

  // --- Image upload (reuse the same endpoint as listings-photos) ---

  const handleFileUpload = async (file) => {
    if (!file) return;
    setUploadingFile(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload-image-blob", { method: "POST", body: fd });
      const data = await res.json();
      if (res.ok && data.url) {
        setMediaUrl(data.url);
        setUploadMeta(data);
      } else {
        setUploadError(data.error || `Upload failed (HTTP ${res.status})`);
      }
    } catch (e) {
      setUploadError(e.message);
    }
    setUploadingFile(false);
  };

  const onFileInput = (e) => {
    const f = e.target.files?.[0];
    if (f) handleFileUpload(f);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFileUpload(f);
  };

  const clearMedia = () => {
    setMediaUrl("");
    setUploadMeta(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // --- Validation ---

  // Shops in the current selection that lack a website — surfaces as a
  // warning when the user has chosen "each shop's URL" mode, since those
  // shops will skip. Not blocking; just informational.
  const selectedNoWebsiteCount = useMemo(
    () => selectedShops.filter((s) => !s.website).length,
    [selectedShops]
  );

  const validationError = useMemo(() => {
    if (!brandFilter) return "Choose a brand.";
    if (selectedShops.length === 0) return "No shops selected.";
    if (!summary.trim()) return "Summary is required.";
    if (summary.length > 1500) return `Summary is ${summary.length}/1500 chars — trim to fit.`;
    if (topicType === "STANDARD") {
      if (ctaAction && ctaAction !== "CALL") {
        if (ctaUrlMode === "same" && !ctaUrl.trim()) {
          return "CTA URL is required unless the CTA action is Call.";
        }
        // In "shop" mode, missing shop websites become per-shop SKIPPED
        // rather than a whole-request error. Only block if EVERY selected
        // shop lacks a website — nothing would go out.
        if (ctaUrlMode === "shop" && selectedNoWebsiteCount === selectedShops.length) {
          return "None of the selected shops have a website in the DB — can't use shop-URL mode.";
        }
      }
    }
    if (topicType === "OFFER") {
      if (!offerTitle.trim()) return "Offer title is required.";
      if (!offerStartDate) return "Offer start date is required.";
      if (!offerEndDate) return "Offer end date is required.";
      if (offerEndDate < offerStartDate) return "Offer end date must be on or after start date.";
      if (offerRedeemMode === "shop" && selectedNoWebsiteCount === selectedShops.length) {
        return "None of the selected shops have a website in the DB — can't use shop-URL mode for Redeem.";
      }
    }
    return null;
  }, [brandFilter, selectedShops.length, selectedNoWebsiteCount, summary, topicType, ctaAction, ctaUrl, ctaUrlMode, offerTitle, offerStartDate, offerEndDate, offerRedeemMode]);

  // --- Push ---

  const buildPostPayload = () => {
    const post = { summary };
    if (mediaUrl) post.mediaUrl = mediaUrl;
    if (topicType === "STANDARD") {
      if (ctaAction) {
        post.cta = { actionType: ctaAction };
        if (ctaAction !== "CALL") {
          if (ctaUrlMode === "shop") {
            post.cta.useShopWebsite = true;
            if (ctaUtm.trim()) post.cta.utmSuffix = ctaUtm.trim();
          } else {
            post.cta.url = ctaUrl.trim();
          }
        }
      }
    } else {
      post.title = offerTitle.trim();
      post.startDate = offerStartDate;
      post.endDate = offerEndDate;
      if (offerCoupon.trim()) post.couponCode = offerCoupon.trim();
      if (offerTerms.trim()) post.termsConditions = offerTerms.trim();
      if (offerRedeemMode === "shop") {
        post.useShopWebsite = true;
        if (offerRedeemUtm.trim()) post.utmSuffix = offerRedeemUtm.trim();
      } else if (offerRedeemUrl.trim()) {
        post.redeemUrl = offerRedeemUrl.trim();
      }
    }
    return post;
  };

  // `overrideShopIds` — used by the "Retry failed" button to re-run
  // the push against just the shops that failed on the previous run,
  // reusing the currently-composed post payload. When omitted, uses
  // the checkbox selection (the normal Post-to-N-shops flow).
  const runPush = async (overrideShopIds = null) => {
    setConfirmOpen(false);
    if (validationError && !overrideShopIds) {
      showToast(validationError, true);
      return;
    }
    setPushing(true);
    setStopping(false);
    cancelRef.current = false;

    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const shopIdList = overrideShopIds && overrideShopIds.length > 0
      ? overrideShopIds
      : selectedShops.map((s) => s.shop_id);
    const chunks = chunkArray(shopIdList, BATCH_SIZE);
    const totalBatches = chunks.length;
    const totalEligible = shopIdList.length;

    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalRejected = 0;
    let totalSkipped = 0;
    // Every non-success outcome, unbounded — the previous 40-cap
    // silently dropped failures on large brands (AGN hit ~90 failed
    // with only 40 surfaced). Includes both FAILED and REJECTED so
    // admin can see the full picture; only FAILED entries are retryable.
    const postPayload = buildPostPayload();

    for (let i = 0; i < chunks.length; i++) {
      if (cancelRef.current) {
        setBatchProgress({
          phase: "cancelled", batch: i, totalBatches, totalEligible,
          totalSucceeded, totalFailed, totalRejected, totalSkipped, failures: [...failures],
        });
        break;
      }

      if (i > 0) {
        setBatchProgress({
          phase: "waiting", batch: i + 1, totalBatches, totalEligible,
          totalSucceeded, totalFailed, totalRejected, totalSkipped, failures: [...failures],
        });
        // Poll cancelRef during the sleep so a cancel click doesn't
        // have to wait a full 8s to take effect.
        const start = Date.now();
        while (Date.now() - start < INTER_BATCH_DELAY_MS) {
          if (cancelRef.current) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (cancelRef.current) continue;
      }

      setBatchProgress({
        phase: "sending", batch: i + 1, totalBatches, totalEligible,
        totalSucceeded, totalFailed, totalRejected, totalSkipped, failures: [...failures],
      });

      try {
        const res = await fetch("/api/gbp/bulk-post", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand: brandFilter,
            shopIds: chunks[i],
            topicType,
            post: postPayload,
            batchId,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          totalSucceeded += data.succeeded || 0;
          totalFailed += data.failed || 0;
          totalRejected += data.rejected || 0;
          totalSkipped += data.skipped || 0;
          // Walk the full per-shop results array so nothing gets
          // silently dropped — we specifically capture FAILED and
          // REJECTED with their shop_id + error so the retry list
          // (and audit panel) has the complete picture.
          if (Array.isArray(data.results)) {
            for (const r of data.results) {
              if (r.state === "FAILED" || r.state === "REJECTED") {
                failures.push({
                  shopId: r.shopId,
                  state: r.state,
                  error: r.error?.message || r.error || (r.state === "REJECTED" ? "Google's automated review rejected the post content" : "Unknown error"),
                });
              }
            }
          }
        } else {
          // Whole chunk failed at the transport level — mark every
          // shop in the chunk as failed so retry re-tries all of them.
          totalFailed += chunks[i].length;
          for (const sid of chunks[i]) {
            failures.push({ shopId: sid, state: "FAILED", error: data.error || `HTTP ${res.status}` });
          }
        }
      } catch (e) {
        totalFailed += chunks[i].length;
        for (const sid of chunks[i]) {
          failures.push({ shopId: sid, state: "FAILED", error: e.message });
        }
      }
    }

    setBatchProgress({
      phase: cancelRef.current ? "cancelled" : "done",
      batch: chunks.length, totalBatches, totalEligible,
      totalSucceeded, totalFailed, totalRejected, totalSkipped, failures,
    });
    setPushing(false);
    setStopping(false);

    showToast(
      cancelRef.current
        ? `Cancelled — ${totalSucceeded}/${totalEligible} posted before stop`
        : `Posted to ${totalSucceeded}/${totalEligible} shops${totalFailed > 0 ? ` (${totalFailed} failed)` : ""}${totalRejected > 0 ? ` (${totalRejected} rejected by Google)` : ""}`,
      totalFailed > 0
    );

    // Refresh history so the run appears at the top
    fetchHistory();
  };

  const requestStop = () => {
    cancelRef.current = true;
    setStopping(true);
  };

  // Verify a batch: for each SUCCESS/REJECTED row in the batch, check
  // whether the post name is actually present on the shop's GBP profile.
  // Chunks 30 shops per server call so each call fits under Vercel's
  // function timeout. Aggregates results into verifyByBatch keyed by
  // batchId so the history panel can render the outcome inline.
  // Chunk-loop through however many shops the batch has. First call
  // sends just batchId; server returns first 50 results + remainingShopIds
  // for the rest. Subsequent calls send remainingShopIds. Loop exits
  // when remainingShopIds is empty. Live progress updates after each
  // chunk so admin sees the panel filling in for large batches.
  const runVerify = async (batchId) => {
    if (!batchId) return;

    setVerifyByBatch((s) => ({
      ...s,
      [batchId]: { verifying: true, verified: 0, missing: 0, errored: 0, total: 0, results: [] },
    }));

    let totalVerified = 0;
    let totalMissing = 0;
    let totalErrored = 0;
    const combinedResults = [];
    let nextShopIds = null; // null = first call, [] = done, [ids] = continue
    let firstNote = undefined;

    try {
      while (true) {
        const body = nextShopIds === null ? { batchId } : { batchId, shopIds: nextShopIds };
        const res = await fetch("/api/gbp/verify-batch-posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setVerifyByBatch((s) => ({
            ...s,
            [batchId]: { verifying: false, error: data.error || `HTTP ${res.status}` },
          }));
          showToast(data.error || "Verify failed", true);
          return;
        }

        totalVerified += data.verified || 0;
        totalMissing += data.missing || 0;
        totalErrored += data.errored || 0;
        if (Array.isArray(data.results)) combinedResults.push(...data.results);
        if (data.note && firstNote === undefined) firstNote = data.note;

        // Live update as chunks complete
        setVerifyByBatch((s) => ({
          ...s,
          [batchId]: {
            verifying: (data.remainingShopIds || []).length > 0,
            verified: totalVerified,
            missing: totalMissing,
            errored: totalErrored,
            total: combinedResults.length,
            results: [...combinedResults],
            note: firstNote,
          },
        }));

        nextShopIds = Array.isArray(data.remainingShopIds) ? data.remainingShopIds : [];
        if (nextShopIds.length === 0) break;
        // Small breather between chunks so the browser can paint the
        // updated state before the next call blocks.
        await new Promise((r) => setTimeout(r, 250));
      }

      showToast(
        `Verified batch — ${totalVerified} present · ${totalMissing} missing on GBP · ${totalErrored} errored`
      );
    } catch (e) {
      setVerifyByBatch((s) => ({
        ...s,
        [batchId]: { verifying: false, error: e.message },
      }));
      showToast(e.message, true);
    }
  };

  // Retry a batch's missing shops via the normal runPush flow. Reuses
  // the currently-composed post payload; if admin has edited fields
  // since the original push, the retry uses the NEW content (matches
  // the mental model of "post whatever's in the composer right now").
  const retryMissingFromVerify = (batchId) => {
    const v = verifyByBatch[batchId];
    if (!v || !Array.isArray(v.results)) return;
    const missingShopIds = v.results
      .filter((r) => r.state === "MISSING")
      .map((r) => r.shopId);
    if (missingShopIds.length === 0) {
      showToast("No missing shops to retry", true);
      return;
    }
    runPush(missingShopIds);
  };

  // --- Render ---

  if (!canPush) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="text-3xl mb-3">🔒</div>
          <h2 className="text-base font-bold text-white mb-1">Access Restricted</h2>
          <p className="text-sm" style={{ color: "#666" }}>Only admin and manager users can bulk-post to Google Business Profile.</p>
        </div>
      </div>
    );
  }

  const brandCfg = brandFilter ? getBrandConfig(brandFilter) : null;

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

      <div className="mb-6">
        <h2 className="text-lg font-bold text-white">Bulk Post to Google Business Profile</h2>
        <p className="text-xs mt-0.5" style={{ color: "#666" }}>
          Push one post to every mapped shop in a brand. Goes directly to Google — visible on the shop's GBP within a few minutes.
        </p>
      </div>

      {/* Brand picker */}
      <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <label className="block text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#888" }}>
          Brand
        </label>
        {shopsLoading ? (
          <div className="text-xs" style={{ color: "#666" }}>Loading shops…</div>
        ) : brandStats.length === 0 ? (
          <div className="text-xs p-3 rounded" style={{ background: "#2d1b00", border: "1px solid #5c3a00", color: "#fbbf24" }}>
            No brands have GBP-mapped shops yet. Run the GBP mapping sync on <a href="/dashboard/admin" style={{ color: "#93c5fd" }}>/dashboard/admin</a> first.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {brandStats.map((b) => {
              const cfg = getBrandConfig(b.brand);
              const isActive = brandFilter === b.brand;
              return (
                <button
                  key={b.brand}
                  onClick={() => setBrandFilter(b.brand)}
                  className="px-3 py-2 rounded-md text-xs font-semibold transition-colors"
                  style={{
                    background: isActive ? cfg.color + "20" : "#1a1a1d",
                    border: `1px solid ${isActive ? cfg.color : "#2a2a2e"}`,
                    color: isActive ? cfg.color : "#aaa",
                  }}
                >
                  {cfg.name} <span style={{ color: isActive ? cfg.color + "cc" : "#666" }}>({b.eligible}/{b.total})</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {brandFilter && (
        <>
          {/* Post type toggle */}
          <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: "#888" }}>
              Post type
            </label>
            <div className="flex gap-2">
              {[
                { value: "STANDARD", label: "Standard update", desc: "Text + optional image + optional CTA button" },
                { value: "OFFER", label: "Offer", desc: "Date-bounded promo, optional coupon code" },
              ].map((t) => (
                <button
                  key={t.value}
                  onClick={() => setTopicType(t.value)}
                  className="flex-1 px-4 py-3 rounded-md text-left transition-colors"
                  style={{
                    background: topicType === t.value ? "#0d2818" : "#1a1a1d",
                    border: `1px solid ${topicType === t.value ? "#2d5a2d" : "#2a2a2e"}`,
                    color: topicType === t.value ? "#6ee7b7" : "#aaa",
                  }}
                >
                  <div className="text-xs font-bold">{t.label}</div>
                  <div className="text-[10px] mt-1" style={{ color: topicType === t.value ? "#6ee7b7aa" : "#666" }}>{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Composer */}
          <div className="rounded-xl p-5 mb-5 space-y-4" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            {/* Summary */}
            <div>
              <div className="flex justify-between items-baseline mb-1.5">
                <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#888" }}>
                  Summary
                </label>
                <span className="text-[10px]" style={{ color: summary.length > 1500 ? "#f87171" : "#666" }}>
                  {summary.length}/1500
                </span>
              </div>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={5}
                placeholder={topicType === "OFFER"
                  ? "Describe the offer. e.g. \"20% off any paint job through Labor Day. Bring in this post.\""
                  : "What do you want to say? e.g. \"Now offering free brake inspections all summer.\""}
                className="w-full px-3 py-2 rounded-md text-sm"
                style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8", fontFamily: "inherit" }}
              />
            </div>

            {/* Media */}
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                Image (optional)
              </label>
              {mediaUrl ? (
                <div className="flex items-center gap-3 p-3 rounded-md" style={{ background: "#0c0c0e", border: "1px solid #2a2a2e" }}>
                  <img src={mediaUrl} alt="Preview" className="w-16 h-16 object-cover rounded" style={{ border: "1px solid #2a2a2e" }} />
                  <div className="flex-1 text-xs" style={{ color: "#aaa" }}>
                    <div className="font-mono text-[10px] truncate" style={{ color: "#888" }}>{mediaUrl}</div>
                    {uploadMeta && uploadMeta.wasResized && (
                      <div className="text-[10px] mt-0.5" style={{ color: "#6ee7b7" }}>
                        Resized {Math.round(uploadMeta.originalSize / 1024)}KB → {Math.round(uploadMeta.resizedSize / 1024)}KB
                      </div>
                    )}
                  </div>
                  <button onClick={clearMedia} className="text-xs px-2 py-1 rounded" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}>
                    Remove
                  </button>
                </div>
              ) : (
                <div
                  onDrop={onDrop}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  className="p-4 rounded-md text-center text-xs transition-colors cursor-pointer"
                  style={{
                    background: dragOver ? "#0d2818" : "#0c0c0e",
                    border: `1px dashed ${dragOver ? "#2d5a2d" : "#2a2a2e"}`,
                    color: "#888",
                  }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadingFile
                    ? "Uploading…"
                    : "Drag an image here or click to browse. Auto-resized under 500KB before push."}
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileInput} style={{ display: "none" }} />
                </div>
              )}
              {uploadError && (
                <div className="mt-2 text-xs p-2 rounded" style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171" }}>
                  {safeRenderable(uploadError)}
                </div>
              )}
              <div className="mt-2 text-xs">
                <span style={{ color: "#666" }}>Or paste a URL: </span>
                <input
                  type="url"
                  value={mediaUrl}
                  onChange={(e) => { setMediaUrl(e.target.value); setUploadMeta(null); }}
                  placeholder="https://…"
                  className="ml-1 px-2 py-1 rounded text-xs w-96 max-w-full"
                  style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                />
              </div>
            </div>

            {/* Standard-specific: CTA */}
            {topicType === "STANDARD" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                      Call-to-action button
                    </label>
                    <select
                      value={ctaAction}
                      onChange={(e) => setCtaAction(e.target.value)}
                      className="w-full px-3 py-2 rounded-md text-sm"
                      style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                    >
                      {CTA_ACTIONS.map((a) => (
                        <option key={a.value} value={a.value}>{a.label}</option>
                      ))}
                    </select>
                  </div>
                  {ctaAction && ctaAction !== "CALL" && (
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                        Button URL source
                      </label>
                      <select
                        value={ctaUrlMode}
                        onChange={(e) => setCtaUrlMode(e.target.value)}
                        className="w-full px-3 py-2 rounded-md text-sm"
                        style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                      >
                        <option value="same">Same URL for all shops</option>
                        <option value="shop">Each shop's location page URL</option>
                      </select>
                    </div>
                  )}
                </div>
                {ctaAction && ctaAction !== "CALL" && ctaUrlMode === "same" && (
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                      Button URL
                    </label>
                    <input
                      type="url"
                      value={ctaUrl}
                      onChange={(e) => setCtaUrl(e.target.value)}
                      placeholder="https://…"
                      className="w-full px-3 py-2 rounded-md text-sm"
                      style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                    />
                  </div>
                )}
                {ctaAction && ctaAction !== "CALL" && ctaUrlMode === "shop" && (
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                      UTM suffix to append to each shop URL <span style={{ color: "#555" }}>(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={ctaUtm}
                      onChange={(e) => setCtaUtm(e.target.value)}
                      placeholder="?utm_source=google&utm_medium=organic&utm_campaign=gbp_post"
                      className="w-full px-3 py-2 rounded-md text-sm font-mono"
                      style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                    />
                    {selectedNoWebsiteCount > 0 && (
                      <div className="mt-1 text-[11px]" style={{ color: "#fbbf24" }}>
                        {selectedNoWebsiteCount} of the selected shops have no website in the DB and will be skipped.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Offer-specific fields */}
            {topicType === "OFFER" && (
              <div className="space-y-3">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                    Offer title
                  </label>
                  <input
                    type="text"
                    value={offerTitle}
                    onChange={(e) => setOfferTitle(e.target.value)}
                    placeholder="e.g. Summer Paint Special"
                    className="w-full px-3 py-2 rounded-md text-sm"
                    style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                      Start date
                    </label>
                    <input
                      type="date"
                      value={offerStartDate}
                      onChange={(e) => setOfferStartDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-md text-sm"
                      style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                      End date
                    </label>
                    <input
                      type="date"
                      value={offerEndDate}
                      onChange={(e) => setOfferEndDate(e.target.value)}
                      className="w-full px-3 py-2 rounded-md text-sm"
                      style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                    Coupon code <span style={{ color: "#555" }}>(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={offerCoupon}
                    onChange={(e) => setOfferCoupon(e.target.value)}
                    placeholder="e.g. SUMMER20"
                    className="w-full px-3 py-2 rounded-md text-sm"
                    style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                    Redeem URL source <span style={{ color: "#555" }}>(optional)</span>
                  </label>
                  <select
                    value={offerRedeemMode}
                    onChange={(e) => setOfferRedeemMode(e.target.value)}
                    className="w-full px-3 py-2 rounded-md text-sm"
                    style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                  >
                    <option value="same">Same URL for all shops</option>
                    <option value="shop">Each shop's location page URL</option>
                  </select>
                </div>
                {offerRedeemMode === "same" ? (
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                      Redeem URL <span style={{ color: "#555" }}>(optional)</span>
                    </label>
                    <input
                      type="url"
                      value={offerRedeemUrl}
                      onChange={(e) => setOfferRedeemUrl(e.target.value)}
                      placeholder="https://…"
                      className="w-full px-3 py-2 rounded-md text-sm"
                      style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                      UTM suffix to append to each shop URL <span style={{ color: "#555" }}>(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={offerRedeemUtm}
                      onChange={(e) => setOfferRedeemUtm(e.target.value)}
                      placeholder="?utm_source=google&utm_medium=organic&utm_campaign=gbp_offer_post"
                      className="w-full px-3 py-2 rounded-md text-sm font-mono"
                      style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                    />
                    {selectedNoWebsiteCount > 0 && (
                      <div className="mt-1 text-[11px]" style={{ color: "#fbbf24" }}>
                        {selectedNoWebsiteCount} of the selected shops have no website in the DB and will be skipped.
                      </div>
                    )}
                  </div>
                )}
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "#888" }}>
                    Terms & conditions <span style={{ color: "#555" }}>(optional)</span>
                  </label>
                  <textarea
                    value={offerTerms}
                    onChange={(e) => setOfferTerms(e.target.value)}
                    rows={2}
                    placeholder="e.g. Valid on services $200+. Not combinable with other offers."
                    className="w-full px-3 py-2 rounded-md text-sm"
                    style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8", fontFamily: "inherit" }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Selected shops */}
          <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            <div className="flex justify-between items-center mb-3">
              <div>
                <div className="text-sm font-semibold text-white">
                  {selectedShops.length} of {eligibleShops.length} {brandCfg?.name} shops selected
                  {shopSearch.trim() && (
                    <span className="ml-2 text-[11px] font-normal" style={{ color: "#93c5fd" }}>
                      ({filteredShops.length} match &ldquo;{shopSearch.trim()}&rdquo;)
                    </span>
                  )}
                </div>
                {unmappedCount > 0 && (
                  <div className="text-[11px] mt-0.5" style={{ color: "#fbbf24" }}>
                    {unmappedCount} unmapped shop{unmappedCount === 1 ? "" : "s"} skipped — <a href="/dashboard/admin" style={{ color: "#93c5fd" }}>run GBP mapping sync</a>
                  </div>
                )}
              </div>
              <div className="flex gap-2 flex-wrap justify-end">
                <button
                  onClick={() => {
                    // Select-all respects the search filter: unfilters
                    // shops stay in their current state, filtered shops
                    // all become selected.
                    const next = new Set(deselectedShopIds);
                    for (const s of filteredShops) next.delete(s.shop_id);
                    setDeselectedShopIds(next);
                  }}
                  disabled={filteredShops.every((s) => !deselectedShopIds.has(s.shop_id))}
                  className="text-xs px-3 py-1.5 rounded"
                  style={{
                    background: "#1c1c1f",
                    border: "1px solid #2a2a2e",
                    color: "#aaa",
                  }}
                  title={shopSearch.trim() ? "Selects only shops matching the search" : "Selects every eligible shop"}
                >
                  {shopSearch.trim() ? "Select matches" : "Select all"}
                </button>
                <button
                  onClick={() => {
                    // Deselect-all also respects the filter — narrows to
                    // "deselect the matches" when a search is active.
                    const next = new Set(deselectedShopIds);
                    for (const s of filteredShops) next.add(s.shop_id);
                    setDeselectedShopIds(next);
                  }}
                  disabled={filteredShops.every((s) => deselectedShopIds.has(s.shop_id))}
                  className="text-xs px-3 py-1.5 rounded"
                  style={{
                    background: "#1c1c1f",
                    border: "1px solid #2a2a2e",
                    color: "#aaa",
                  }}
                  title={shopSearch.trim() ? "Deselects only shops matching the search" : "Deselects every shop"}
                >
                  {shopSearch.trim() ? "Deselect matches" : "Deselect all"}
                </button>
                <button
                  onClick={() => setShowShopList(!showShopList)}
                  className="text-xs px-3 py-1.5 rounded"
                  style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
                >
                  {showShopList ? "Hide list" : "Show list"}
                </button>
              </div>
            </div>

            {/* Batch controls — for the "post version A to 50 shops, then a
                different version to the next 50" workflow. */}
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 mb-3 pt-3" style={{ borderTop: "1px solid #2a2a2e" }}>
              <div className="sm:col-span-6">
                <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#666" }}>
                  Search shops
                </label>
                <input
                  type="text"
                  value={shopSearch}
                  onChange={(e) => setShopSearch(e.target.value)}
                  placeholder="Shop ID, city, or state"
                  className="w-full px-3 py-2 rounded-md text-xs"
                  style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#666" }}>
                  Batch size
                </label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={batchSize}
                  onChange={(e) => setBatchSize(Math.max(1, Math.min(50, Number(e.target.value) || 50)))}
                  className="w-full px-3 py-2 rounded-md text-xs font-mono"
                  style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                />
              </div>
              <div className="sm:col-span-4">
                <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "#666" }}>
                  Jump to batch (replaces selection)
                </label>
                <select
                  value=""
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (n) selectBatch(n);
                  }}
                  disabled={batches.length === 0}
                  className="w-full px-3 py-2 rounded-md text-xs"
                  style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#e8e8e8" }}
                >
                  <option value="">— Select batch —</option>
                  {batches.map((b) => (
                    <option key={b.index} value={b.index}>
                      Batch {b.index} · shops {b.startPos}-{b.endPos} of {filteredShops.length}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {showShopList && (
              <div className="max-h-72 overflow-y-auto space-y-1" style={{ borderTop: "1px solid #2a2a2e", paddingTop: 12 }}>
                {filteredShops.length === 0 && (
                  <div className="text-[11px] py-3 text-center" style={{ color: "#666" }}>
                    No shops match &ldquo;{shopSearch.trim()}&rdquo;.
                  </div>
                )}
                {filteredShops.map((s, i) => {
                  const on = !deselectedShopIds.has(s.shop_id);
                  return (
                    <label key={s.shop_id} className="flex items-center gap-2 text-xs py-1 cursor-pointer" style={{ color: on ? "#e8e8e8" : "#555" }}>
                      <span className="font-mono text-[10px] text-right" style={{ color: "#555", minWidth: 32 }}>{i + 1}.</span>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const next = new Set(deselectedShopIds);
                          if (e.target.checked) next.delete(s.shop_id);
                          else next.add(s.shop_id);
                          setDeselectedShopIds(next);
                        }}
                      />
                      <span className="font-mono text-[10px]" style={{ color: "#666", minWidth: 60 }}>{s.shop_id}</span>
                      <span className="flex-1 truncate">{s.city}, {s.state}</span>
                      <span className="text-[10px] font-mono truncate max-w-xs" style={{ color: "#555" }}>{s.gbp_location_id}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Push controls */}
          <div className="rounded-xl p-5 mb-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
            {validationError && (
              <div className="mb-3 text-xs p-2 rounded" style={{ background: "#2d1b00", border: "1px solid #5c3a00", color: "#fbbf24" }}>
                {validationError}
              </div>
            )}
            <div className="flex gap-2 items-center justify-between">
              <div className="text-xs" style={{ color: "#666" }}>
                Runs in batches of {BATCH_SIZE} shops. {Math.ceil(selectedShops.length / BATCH_SIZE) || 0} batches ·{" "}
                ~{Math.max(1, Math.ceil((selectedShops.length * 0.5 + Math.max(0, Math.ceil(selectedShops.length / BATCH_SIZE) - 1) * (INTER_BATCH_DELAY_MS / 1000)) / 60))} min wall-clock.
                Keep this tab open.
              </div>
              <div className="flex gap-2">
                {pushing && (
                  <button
                    onClick={requestStop}
                    disabled={stopping}
                    className="px-4 py-2 rounded-md text-xs font-semibold"
                    style={{ background: "#2d0a0a", border: "1px solid #5c1a1a", color: "#f87171", opacity: stopping ? 0.5 : 1 }}
                  >
                    {stopping ? "Stopping after this batch…" : "Stop"}
                  </button>
                )}
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={pushing || !!validationError}
                  className="px-5 py-2 rounded-md text-xs font-semibold text-white"
                  style={{
                    background: pushing || validationError ? "#333" : "#0ea5e9",
                    opacity: pushing || validationError ? 0.5 : 1,
                  }}
                >
                  {pushing ? `Posting… (batch ${batchProgress?.batch}/${batchProgress?.totalBatches})` : `Post to ${selectedShops.length} shops`}
                </button>
              </div>
            </div>

            {/* Progress panel */}
            {batchProgress && (
              <div className="mt-4 pt-4" style={{ borderTop: "1px solid #2a2a2e" }}>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]">
                  <StatCard label="Phase" value={batchProgress.phase} />
                  <StatCard label="Succeeded" value={batchProgress.totalSucceeded} color="#34d399" />
                  <StatCard label="Failed" value={batchProgress.totalFailed} color={batchProgress.totalFailed > 0 ? "#f87171" : "#e8e8e8"} />
                  <StatCard label="Rejected" value={batchProgress.totalRejected} color={batchProgress.totalRejected > 0 ? "#fbbf24" : "#e8e8e8"} />
                  <StatCard label="Skipped" value={batchProgress.totalSkipped} color={batchProgress.totalSkipped > 0 ? "#fbbf24" : "#e8e8e8"} />
                </div>
                {batchProgress.failures && batchProgress.failures.length > 0 && (
                  <FailurePanel
                    failures={batchProgress.failures}
                    brandLocations={brandLocations}
                    pushing={pushing}
                    onRetry={(retryShopIds) => runPush(retryShopIds)}
                  />
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* History */}
      <div className="rounded-xl p-5" style={{ background: "#151517", border: "1px solid #1e1e22" }}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: "#aaa" }}>Recent bulk posts</h3>
          <button
            onClick={fetchHistory}
            disabled={historyLoading}
            className="text-xs px-3 py-1.5 rounded"
            style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}
          >
            {historyLoading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {history.length === 0 ? (
          <div className="text-xs" style={{ color: "#555" }}>No bulk posts yet.</div>
        ) : (
          <div className="space-y-1">
            {history.map((h) => {
              const cfg = getBrandConfig(h.brand);
              // For OFFER batches, show the offer's end date and whether
              // auto-cleanup has fired. `live` is what's still up on
              // Google after cleanup: succeeded - auto_deleted (since
              // AUTO_DELETED rows started as SUCCESS).
              const liveCount = Math.max(0, (h.succeeded || 0) - (h.auto_deleted || 0));
              const isOffer = h.topic_type === "OFFER";
              const endDate = isOffer && h.offer_end_date ? String(h.offer_end_date).slice(0, 10) : null;
              const today = new Date().toISOString().slice(0, 10);
              const expired = endDate && endDate < today;
              const verify = verifyByBatch[h.batch_id];
              return (
                <div key={h.batch_id}>
                <div className="grid grid-cols-12 gap-2 text-xs py-2 px-3 rounded items-center" style={{ background: "#0c0c0e", border: "1px solid #1a1a1d" }}>
                  <div className="col-span-3">
                    <div className="font-semibold" style={{ color: cfg.color }}>{cfg.name}</div>
                    <div className="text-[10px]" style={{ color: "#555" }}>{new Date(h.pushed_at).toLocaleString()}</div>
                  </div>
                  <div className="col-span-1 text-[10px] font-mono" style={{ color: "#888" }}>
                    {h.topic_type}
                    {endDate && (
                      <div className="text-[9px] mt-0.5" style={{ color: expired ? "#888" : "#93c5fd" }}>
                        ends {endDate}
                      </div>
                    )}
                  </div>
                  <div className="col-span-5 truncate" style={{ color: "#aaa" }}>
                    {h.summary}
                    {(h.auto_deleted || 0) > 0 && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "#1e2a30", border: "1px solid #2a3a44", color: "#93c5fd" }}>
                        {h.auto_deleted} auto-deleted · {liveCount} still live
                      </span>
                    )}
                  </div>
                  <div className="col-span-3 text-right text-[10px] flex items-center justify-end gap-2">
                    <div>
                      <span style={{ color: "#34d399" }}>{h.succeeded}✓</span>
                      {h.failed > 0 && <span style={{ color: "#f87171" }}> · {h.failed}✗</span>}
                      {h.rejected > 0 && <span style={{ color: "#fbbf24" }}> · {h.rejected}⚠</span>}
                      {(h.auto_deleted || 0) > 0 && <span style={{ color: "#93c5fd" }}> · {h.auto_deleted}🗑</span>}
                      <span style={{ color: "#555" }}> / {h.total}</span>
                    </div>
                    <button
                      onClick={() => runVerify(h.batch_id)}
                      disabled={verify?.verifying || pushing}
                      className="px-2 py-1 rounded text-[10px] font-semibold flex-shrink-0"
                      style={{
                        background: "#1c1c1f",
                        border: "1px solid #2a2a2e",
                        color: verify?.verifying ? "#555" : "#93c5fd",
                        opacity: verify?.verifying || pushing ? 0.5 : 1,
                      }}
                      title="Cross-check each shop's GBP profile to confirm the post is actually there"
                    >
                      {verify?.verifying ? "Verifying…" : "Verify"}
                    </button>
                  </div>
                </div>
                {verify && !verify.verifying && (verify.results || verify.error) && (
                  <div className="mt-1 p-3 rounded text-[11px]" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
                    {verify.error ? (
                      <div style={{ color: "#f87171" }}>Verify failed: {verify.error}</div>
                    ) : (
                      <>
                        <div className="flex justify-between items-center mb-2">
                          <div style={{ color: "#aaa" }}>
                            <span style={{ color: "#34d399" }}>{verify.verified} present on GBP</span>
                            {verify.missing > 0 && <span style={{ color: "#f87171" }}> · {verify.missing} missing</span>}
                            {verify.errored > 0 && <span style={{ color: "#fbbf24" }}> · {verify.errored} errored</span>}
                            <span style={{ color: "#555" }}> / {verify.total} checked</span>
                          </div>
                          {verify.missing > 0 && (
                            <button
                              onClick={() => retryMissingFromVerify(h.batch_id)}
                              disabled={pushing}
                              className="px-3 py-1 rounded text-[10px] font-semibold text-white"
                              style={{ background: pushing ? "#333" : "#0ea5e9", opacity: pushing ? 0.5 : 1 }}
                              title="Re-run the CURRENT composed post against just the shops missing this post on GBP"
                            >
                              {pushing ? "Posting…" : `Retry ${verify.missing} missing`}
                            </button>
                          )}
                        </div>
                        {verify.note && (
                          <div className="text-[10px] mb-2" style={{ color: "#666" }}>{verify.note}</div>
                        )}
                        {verify.missing > 0 && (
                          <details style={{ color: "#aaa" }}>
                            <summary className="cursor-pointer text-[10px]" style={{ color: "#93c5fd" }}>Show missing shops</summary>
                            <div className="mt-2 max-h-48 overflow-y-auto space-y-0.5">
                              {verify.results.filter((r) => r.state === "MISSING").map((r, i) => {
                                const shop = shops.find((s) => s.shop_id === r.shopId);
                                return (
                                  <div key={i} className="text-[10px] grid grid-cols-12 gap-2" style={{ color: "#f8717199" }}>
                                    <div className="col-span-1 font-mono" style={{ color: "#f87171" }}>{r.shopId}</div>
                                    <div className="col-span-4 truncate">{shop ? shop.name : "—"}</div>
                                    <div className="col-span-4 truncate">{shop ? `${shop.city}, ${shop.state}` : ""}</div>
                                    <div className="col-span-3 text-right">{r.error || "not on GBP"}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        )}
                        {verify.errored > 0 && (
                          <details className="mt-2" style={{ color: "#aaa" }}>
                            <summary className="cursor-pointer text-[10px]" style={{ color: "#fbbf24" }}>Show errored checks</summary>
                            <div className="mt-2 max-h-32 overflow-y-auto space-y-0.5">
                              {verify.results.filter((r) => r.state === "ERROR").map((r, i) => (
                                <div key={i} className="text-[10px] font-mono" style={{ color: "#fbbf2499" }}>
                                  {r.shopId}: {r.error}
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </>
                    )}
                  </div>
                )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirm modal */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-[500px] rounded-xl overflow-hidden" style={{ background: "#151517", border: "1px solid #2a2a2e" }}>
            <div className="px-5 py-4" style={{ borderBottom: "1px solid #2a2a2e" }}>
              <h3 className="text-base font-semibold text-white">Confirm bulk post</h3>
            </div>
            <div className="px-5 py-4 space-y-2 text-sm" style={{ color: "#ccc" }}>
              <div>
                About to post <strong style={{ color: "#e8e8e8" }}>{topicType}</strong> to{" "}
                <strong style={{ color: brandCfg?.color }}>{selectedShops.length} {brandCfg?.name}</strong> shops.
              </div>
              <div className="text-xs p-3 rounded" style={{ background: "#0c0c0e", border: "1px solid #2a2a2e", color: "#aaa" }}>
                &ldquo;{summary.slice(0, 200)}{summary.length > 200 ? "…" : ""}&rdquo;
              </div>
              <div className="text-xs" style={{ color: "#888" }}>
                Posts appear on Google Business Profile within a few minutes. They&rsquo;re public and visible in Google Search + Maps immediately.
              </div>
            </div>
            <div className="px-5 py-4 flex justify-end gap-2" style={{ borderTop: "1px solid #2a2a2e" }}>
              <button onClick={() => setConfirmOpen(false)} className="px-4 py-2 rounded-md text-xs font-semibold" style={{ background: "#1c1c1f", border: "1px solid #2a2a2e", color: "#aaa" }}>
                Cancel
              </button>
              <button onClick={runPush} className="px-4 py-2 rounded-md text-xs font-semibold text-white" style={{ background: "#0ea5e9" }}>
                Push now
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="px-3 py-2 rounded" style={{ background: "#0f1419", border: "1px solid #1e2a30" }}>
      <div style={{ color: "#888" }}>{label}</div>
      <div className="text-base font-bold" style={{ color: color || "#e8e8e8" }}>{value}</div>
    </div>
  );
}

/**
 * Failure detail panel — shown when a bulk-post run finishes with any
 * FAILED or REJECTED shops. Joins each failure to the shop's row in
 * `brandLocations` so we can show the shop name / city / state (not
 * just a bare shop_id). Splits FAILED (retryable — transient errors)
 * from REJECTED (Google auto-review, retrying with the same content
 * gets the same rejection, so no retry button for those).
 */
function FailurePanel({ failures, brandLocations, pushing, onRetry }) {
  const shopById = new Map((brandLocations || []).map((s) => [s.shop_id, s]));
  const failed = failures.filter((f) => f.state === "FAILED");
  const rejected = failures.filter((f) => f.state === "REJECTED");
  const failedIds = failed.map((f) => f.shopId);

  return (
    <div className="mt-3 space-y-3">
      {failed.length > 0 && (
        <div className="p-3 rounded" style={{ background: "#2d0a0a20", border: "1px solid #5c1a1a40" }}>
          <div className="flex justify-between items-center mb-2">
            <div className="text-[11px] font-semibold" style={{ color: "#f87171" }}>
              Failed shops ({failed.length}) — retryable
            </div>
            {onRetry && (
              <button
                onClick={() => onRetry(failedIds)}
                disabled={pushing}
                className="px-3 py-1 rounded text-[11px] font-semibold text-white"
                style={{ background: pushing ? "#333" : "#0ea5e9", opacity: pushing ? 0.5 : 1 }}
                title="Re-run the current post against just the failed shops"
              >
                {pushing ? "Posting…" : `Retry ${failed.length} failed`}
              </button>
            )}
          </div>
          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {failed.map((f, i) => {
              const shop = shopById.get(f.shopId);
              return (
                <div key={i} className="text-[10px] leading-snug grid grid-cols-12 gap-2" style={{ color: "#f8717199" }}>
                  <div className="col-span-1 font-mono" style={{ color: "#f87171" }}>{safeRenderable(f.shopId)}</div>
                  <div className="col-span-4 truncate" style={{ color: "#f87171cc" }}>
                    {shop ? `${shop.name}` : "—"}
                  </div>
                  <div className="col-span-2 truncate" style={{ color: "#f87171aa" }}>
                    {shop ? `${shop.city}, ${shop.state}` : ""}
                  </div>
                  <div className="col-span-5 font-mono truncate" title={String(f.error || "")}>
                    {safeRenderable(f.error)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {rejected.length > 0 && (
        <div className="p-3 rounded" style={{ background: "#2d1b0020", border: "1px solid #5c3a0040" }}>
          <div className="text-[11px] font-semibold mb-2" style={{ color: "#fbbf24" }}>
            Rejected by Google ({rejected.length}) — content flagged; retrying with the same content won't help
          </div>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {rejected.map((r, i) => {
              const shop = shopById.get(r.shopId);
              return (
                <div key={i} className="text-[10px] leading-snug grid grid-cols-12 gap-2" style={{ color: "#fbbf2499" }}>
                  <div className="col-span-1 font-mono" style={{ color: "#fbbf24" }}>{safeRenderable(r.shopId)}</div>
                  <div className="col-span-4 truncate" style={{ color: "#fbbf24cc" }}>
                    {shop ? shop.name : "—"}
                  </div>
                  <div className="col-span-7 truncate" style={{ color: "#fbbf24aa" }}>
                    {shop ? `${shop.city}, ${shop.state}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
