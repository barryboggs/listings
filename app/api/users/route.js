import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getUsers, createUser, updateUser, deleteUser } from "@/lib/db";

export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const users = await getUsers();
  return NextResponse.json({ users });
}

export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  try {
    const body = await request.json();
    const newUser = await createUser(body);
    return NextResponse.json({ user: newUser });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
}

export async function PUT(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  try {
    const body = await request.json();
    const updated = await updateUser(body.id, body);
    return NextResponse.json({ user: updated });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
}

export async function DELETE(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("id");
    await deleteUser(userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
}
