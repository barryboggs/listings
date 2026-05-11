import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getCategories, getRichStatus } from "@/lib/semrush-rich";

/**
 * GET /api/semrush/categories?country=<ISO2>
 *
 * Proxy + 24h server-side cache (in lib/semrush-rich.js, keyed by country)
 * for the new API's category catalog. Used by EditModal's category picker.
 *
 * The upstream requires `country` (case-sensitive ISO 3166-1 alpha-2). We
 * default to US if the caller omits it. Returns { categories: [] } with a
 * reason on failure rather than 500 — picker degrades to free-text.
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!getRichStatus().hasKey) {
    return NextResponse.json({ categories: [], reason: "no_apikey" });
  }

  const { searchParams } = new URL(request.url);
  const country = (searchParams.get("country") || "US").toUpperCase();

  try {
    const list = await getCategories({ country });
    return NextResponse.json({ categories: Array.isArray(list) ? list : [], country });
  } catch (error) {
    return NextResponse.json({
      categories: [],
      country,
      reason: "upstream_error",
      message: error.message,
    });
  }
}
