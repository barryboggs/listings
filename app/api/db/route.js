import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { initDatabase } from "@/lib/db";

// POST /api/db - initialize database tables and seed data
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const result = await initDatabase();
  return NextResponse.json(result);
}

// GET /api/db - check database status
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const hasPostgres = !!(process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING);
  return NextResponse.json({
    hasPostgres,
    mode: hasPostgres ? "postgres" : "memory",
  });
}
