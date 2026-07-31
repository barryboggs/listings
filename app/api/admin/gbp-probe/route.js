import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { listAccounts, listLocations, getGoogleBpStatus } from "@/lib/google-bp";

/**
 * GET /api/admin/gbp-probe            → lists accounts the connected user manages
 * GET /api/admin/gbp-probe?account=accounts/123 → lists locations under one account
 *
 * Admin-only diagnostic. Confirms end-to-end that our OAuth token can
 * actually call GBP APIs — separates "token exists in DB" from "token
 * actually works." Use after connecting via /api/auth/google-bp/start
 * before investing time in the shop-mapping sync route.
 *
 * Failure modes it distinguishes:
 *   - `state: "no_credentials"` → env vars missing
 *   - `state: "not_connected"` → OAuth not completed yet
 *   - HTTP 403 with "quota" or "PERMISSION_DENIED" in error → GCP project
 *     lacks GBP quota approval (this is the "verify quota" step from the
 *     scoping memo materializing as an actual API error)
 *   - Empty accounts array → OAuth token is for a Google account that
 *     doesn't manage any GBP profiles
 */
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const account = new URL(request.url).searchParams.get("account");

  // Bypass the "state check" gate when the caller passes ?force=1 — the
  // status can go to "failing" after a single bad call, which then locks
  // us out of retrying with a corrected URL. We want to iterate freely
  // during diagnosis. The upstream call will still fail cleanly on its
  // own if there's a real problem.
  const force = new URL(request.url).searchParams.get("force") === "1";
  const status = await getGoogleBpStatus();
  if (!force && status.state !== "healthy" && status.state !== "untested") {
    return NextResponse.json(
      { error: `GBP not ready: ${status.state}`, status, hint: "Add ?force=1 to bypass the health gate for diagnosis." },
      { status: 412 }
    );
  }

  try {
    if (account) {
      const result = await listLocations(account);
      return NextResponse.json({
        mode: "locations",
        account,
        result,
        summary: {
          locationCount: Array.isArray(result.locations) ? result.locations.length : 0,
          nextPageToken: result.nextPageToken || null,
          totalSize: result.totalSize || null,
        },
      });
    }

    const result = await listAccounts();
    return NextResponse.json({
      mode: "accounts",
      result,
      summary: {
        accountCount: Array.isArray(result.accounts) ? result.accounts.length : 0,
        accounts: (result.accounts || []).map((a) => ({
          name: a.name,
          accountName: a.accountName,
          type: a.type,
          role: a.role,
          verificationState: a.verificationState,
        })),
      },
      nextStep: "Copy an account `name` (e.g. \"accounts/12345\") and hit ?account=accounts/12345 to list its locations.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error.message,
        hint: error.message.includes("403") || error.message.includes("PERMISSION_DENIED")
          ? "Looks like a quota/permission issue. Verify the GCP project this OAuth client belongs to has GBP quota approved."
          : undefined,
      },
      { status: 502 }
    );
  }
}
