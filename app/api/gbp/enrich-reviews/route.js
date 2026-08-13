import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { verifyToken } from "@/lib/auth";
import {
  getUnenrichedReviews,
  upsertReviewEnrichments,
  initDatabase,
  logActivity,
} from "@/lib/db";

// Vercel Pro function timeout. Per Claude Haiku call ~2-4s; batched at
// 10 reviews/call, throttled 500ms → 50 reviews/batch handles ~1000
// reviews in ~2 minutes. maxDuration lets a single invocation cover
// most brands. Repeat-clicks pick up where left off (getUnenrichedReviews
// only returns rows without an enrichment row).
export const maxDuration = 300;

// Model choice: Haiku 4.5 is the cheapest tier that handles this well.
// Short-text classification with a fixed vocabulary is squarely in
// Haiku's wheelhouse; Sonnet-level nuance isn't needed and would
// multiply the bill.
const MODEL = "claude-haiku-4-5-20251001";

// Batch size — how many reviews per Claude call. 10 keeps the prompt
// under a couple KB and lets the model reason across the batch (small
// context helps consistency). Higher batch sizes = fewer round-trips
// but more risk of the model dropping items or drifting.
const BATCH_SIZE = 10;

// Throttle between batches — Haiku's rate limits are generous, but
// this leaves headroom for other Claude callers in the same account.
const CALL_THROTTLE_MS = 500;

// Per-invocation cap. Larger brands (60K+ reviews) can't finish in
// one call within maxDuration, so we cap and report "remaining" —
// the admin re-clicks to continue.
const MAX_PER_INVOCATION = 1000;

// Fixed theme vocabulary. Deliberately small so the model reliably
// picks tags rather than inventing them, and so aggregation across
// months is comparable. Extending later means back-populating.
const THEME_VOCAB = [
  "quality",
  "price",
  "staff",
  "wait_time",
  "communication",
  "location",
  "cleanliness",
  "scheduling",
  "value",
  "other",
];

// Claude tool schema — using tool-use forces the model to return
// structured JSON that matches this schema exactly. Much more reliable
// than free-form text + parse. If Claude fails to conform (rare with
// Haiku on a well-defined schema), the response is dropped from the
// batch and reported in errors.
const CLASSIFY_TOOL = {
  name: "classify_reviews",
  description:
    "Return a themes array for each review. Each theme carries its OWN sentiment " +
    "(a review may mention staff positively AND wait time negatively — do not average " +
    "them). Include a short verbatim quote (5-15 words) from the review as evidence. " +
    "Only tag themes actually discussed; an empty themes array is valid.",
  input_schema: {
    type: "object",
    properties: {
      reviews: {
        type: "array",
        items: {
          type: "object",
          properties: {
            review_name: {
              type: "string",
              description: "The review's identifier — copy verbatim from the input.",
            },
            themes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tag: { type: "string", enum: THEME_VOCAB },
                  sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
                  quote: {
                    type: "string",
                    description: "Short (5-15 word) verbatim snippet from the review illustrating this theme.",
                  },
                },
                required: ["tag", "sentiment", "quote"],
              },
            },
          },
          required: ["review_name", "themes"],
        },
      },
    },
    required: ["reviews"],
  },
};

/**
 * POST /api/gbp/enrich-reviews
 *
 * Admin-only. Reads reviews that don't yet have an enrichment row,
 * sends them to Claude Haiku in batches, writes results to
 * lm_review_enrichments. Idempotent — re-clicking continues where
 * the previous call stopped.
 *
 * Body:
 *   { brand?, month?, force? }
 *   - brand: scope to one brand's reviews; omit for all
 *   - month: "YYYY-MM" scope. Massively cuts cost/time when a monthly
 *     report only needs one month enriched (typical case)
 *   - force: (not implemented in v1) — future hook for re-enriching
 *     already-enriched rows when the model changes
 *
 * Response:
 *   {
 *     enriched: number,          // rows written to lm_review_enrichments
 *     remaining: number,         // rows still lacking enrichment
 *     model: string,
 *     batches: number,           // Claude calls made
 *     errors: [{ batch, error }],
 *   }
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set in env" },
      { status: 412 }
    );
  }

  await initDatabase();

  const body = await request.json().catch(() => ({}));
  const brand = body.brand && body.brand !== "*" ? body.brand : null;
  const monthStr = body.month && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null;

  // Pull the batch we'll process this invocation. Cap enforced so we
  // don't run past maxDuration on huge brands. Month-scoping is the
  // typical case — enrich only the reviews that will appear in the
  // current report month, saving ~90% of the cost.
  const rows = await getUnenrichedReviews({ brand, monthStr, limit: MAX_PER_INVOCATION });

  if (rows.length === 0) {
    return NextResponse.json({
      enriched: 0,
      remaining: 0,
      model: MODEL,
      batches: 0,
      note: "No unenriched reviews with a comment. Sync more reviews or wait for new ones.",
    });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let enriched = 0;
  let batchesCompleted = 0;
  const errors = [];

  // Chunk into BATCH_SIZE-sized groups for the Claude calls.
  const chunks = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    chunks.push(rows.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Prompt shape: give Claude the reviews as a JSON list keyed by
    // the review_name we want it to echo back. This keeps
    // model-generated review_names aligned with our DB (models
    // occasionally paraphrase identifiers if they're not verbatim).
    const promptReviews = chunk.map((r) => ({
      review_name: r.review_name,
      rating: r.rating,
      comment: (r.comment || "").slice(0, 2000), // guard against pathological reviews
    }));

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
        tools: [CLASSIFY_TOOL],
        messages: [
          {
            role: "user",
            content:
              "You are analyzing customer reviews for an auto-service brand. For each " +
              "review, identify which themes (from the fixed vocabulary) the customer " +
              "discusses, and the sentiment of each theme independently.\n\n" +
              "Themes vocabulary: " + THEME_VOCAB.join(", ") + ".\n" +
              "Sentiment: positive | negative | neutral.\n\n" +
              "Reviews:\n" + JSON.stringify(promptReviews, null, 2),
          },
        ],
      });

      // Find the tool_use block in Claude's response.
      const toolUse = response.content.find((c) => c.type === "tool_use");
      if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.reviews)) {
        throw new Error("Model response did not contain the expected tool_use structure");
      }

      // Match model output back to our chunk by review_name. Anything
      // the model skipped or fabricated is dropped silently — the
      // aggregation is over what's present, missing rows just re-appear
      // in the next unenriched query.
      const validNames = new Set(chunk.map((r) => r.review_name));
      const enrichmentsToWrite = [];
      for (const item of toolUse.input.reviews) {
        if (!validNames.has(item.review_name)) continue;
        const themes = Array.isArray(item.themes) ? item.themes.filter(
          (t) => t && THEME_VOCAB.includes(t.tag) && ["positive", "negative", "neutral"].includes(t.sentiment)
        ) : [];
        enrichmentsToWrite.push({ review_name: item.review_name, themes });
      }

      const res = await upsertReviewEnrichments(enrichmentsToWrite, MODEL);
      enriched += res.inserted;
      batchesCompleted++;
    } catch (e) {
      if (errors.length < 10) errors.push({ batch: i + 1, error: e.message });
    }

    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, CALL_THROTTLE_MS));
    }
  }

  // Estimate how many more reviews are waiting in the SAME scope
  // (respect monthStr filter so "0 remaining" is accurate for the
  // current report). Fresh count is cheap.
  const stillPending = await getUnenrichedReviews({ brand, monthStr, limit: 1 });
  const remaining = stillPending.length > 0 ? "1+" : 0;
  // The "1+" is a hint that there's more work; we don't want to run
  // an unbounded COUNT(*) here. Admin can just re-click to keep going.

  logActivity({
    user: user.name,
    action: "Analyzed GBP review themes",
    location: "",
    brand: brand || "all",
    details: `enriched:${enriched} batches:${batchesCompleted}/${chunks.length} month:${monthStr || "all"} model:${MODEL}`,
  }).catch(() => {});

  return NextResponse.json({
    enriched,
    remaining,
    model: MODEL,
    batches: batchesCompleted,
    totalBatches: chunks.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
