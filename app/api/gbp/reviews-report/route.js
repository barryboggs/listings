import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import {
  getReviewStatsForMonth,
  getTopThemesForMonth,
  initDatabase,
} from "@/lib/db";

/**
 * GET /api/gbp/reviews-report?brand=<brand>&month=YYYY-MM
 *
 * Admin-only. Returns everything the monthly-report page needs in one
 * call: brand-level rating stats + top themes (positive/negative split)
 * + prior-month stats (for MoM delta rendering).
 *
 * If the enrichment layer hasn't been run yet (Phase B not applied to
 * this brand's reviews), themes come back as empty arrays and the UI
 * shows "Run enrichment" call-to-action instead of hero panels.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  await initDatabase();

  const url = new URL(request.url);
  const brand = url.searchParams.get("brand");
  const month = url.searchParams.get("month");

  if (!brand || !month) {
    return NextResponse.json(
      { error: "brand and month (YYYY-MM) are required" },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json(
      { error: "month must be YYYY-MM" },
      { status: 400 }
    );
  }

  // Compute previous month string for MoM delta
  const [year, m] = month.split("-").map(Number);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? year - 1 : year;
  const prevMonth = `${prevY}-${String(prevM).padStart(2, "0")}`;

  const [thisStats, prevStats, themes] = await Promise.all([
    getReviewStatsForMonth({ brand, monthStr: month }),
    getReviewStatsForMonth({ brand, monthStr: prevMonth }),
    getTopThemesForMonth({ brand, monthStr: month, topN: 8 }),
  ]);

  return NextResponse.json({
    brand,
    month,
    prevMonth,
    stats: thisStats,
    prevStats,
    themes,
  });
}
