import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { listLocationImages } from "@/lib/semrush-rich";
import { getImagePushes, resolveImagePush } from "@/lib/db";

/**
 * POST /api/admin/audit-image-pushes
 *
 * Walks recent FAILED rows in lm_image_pushes, hits Semrush to see if
 * the image actually landed (it often does — Semrush's image endpoint
 * has a pattern where it returns 400 "Invalid request" after large
 * payloads but stores the image anyway). Rows where the image is
 * actually present get flipped to SUCCESS with the Semrush image_id +
 * URL captured.
 *
 * Body (all optional):
 *   { brand?: string,           // limit to one brand
 *     sourceUrl?: string,       // limit to one image URL (typical use:
 *                                  audit just the last bulk push)
 *     hoursBack?: number,       // default 24
 *     verifyWindowMinutes?: number }  // default 60 — how close in time the
 *                                       Semrush image's createDate must be
 *                                       to our pushed_at to count as "ours"
 *
 * Response:
 *   { scanned, fixed, stillFailed, errors }
 */
export const maxDuration = 90;

const DEFAULT_HOURS_BACK = 24;
const DEFAULT_VERIFY_WINDOW_MINUTES = 60;

export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const {
    brand = null,
    sourceUrl = null,
    hoursBack = DEFAULT_HOURS_BACK,
    verifyWindowMinutes = DEFAULT_VERIFY_WINDOW_MINUTES,
  } = body;

  // Pull recent FAILED rows we'll consider auditing.
  const allFailed = await getImagePushes({ state: "FAILED", brand, sourceUrl, limit: 5000 });
  const cutoffMs = Date.now() - hoursBack * 60 * 60 * 1000;
  const candidates = allFailed.filter((row) => {
    const pushedMs = row.pushed_at ? new Date(row.pushed_at).getTime() : 0;
    return pushedMs >= cutoffMs;
  });

  if (candidates.length === 0) {
    return NextResponse.json({
      scanned: 0,
      fixed: 0,
      stillFailed: 0,
      errors: [],
      message: "No FAILED rows in the audit window.",
    });
  }

  let fixed = 0;
  let stillFailed = 0;
  const errors = [];

  for (const row of candidates) {
    if (!row.semrush_new_id) {
      stillFailed++;
      continue;
    }
    try {
      const existing = await listLocationImages(row.semrush_new_id);
      const items = Array.isArray(existing?.data) ? existing.data : [];
      const pushedAtMs = row.pushed_at ? new Date(row.pushed_at).getTime() : 0;
      const windowMs = verifyWindowMinutes * 60 * 1000;

      let landed = null;
      for (const it of items) {
        const created = it?.createDate ? new Date(it.createDate).getTime() : NaN;
        if (!isNaN(created) && pushedAtMs && Math.abs(created - pushedAtMs) < windowMs) {
          landed = it;
          break;
        }
      }

      if (landed) {
        await resolveImagePush(row.id, {
          success: true,
          semrushImageId: landed.id || null,
          semrushImageUrl: landed.url || null,
        });
        fixed++;
      } else {
        stillFailed++;
      }
    } catch (e) {
      stillFailed++;
      if (errors.length < 50) {
        errors.push({ shopId: row.shop_id, semrushNewId: row.semrush_new_id, error: e.message });
      }
    }
  }

  return NextResponse.json({
    scanned: candidates.length,
    fixed,
    stillFailed,
    errors,
    auditWindow: { hoursBack, verifyWindowMinutes, brand, sourceUrl },
  });
}
