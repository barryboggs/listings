import { NextResponse } from "next/server";
import { verifyToken, DEMO_USERS } from "@/lib/auth";

/**
 * In-memory user store. Initialized from DEMO_USERS (without passwords for reads).
 * On Vercel, this persists within a warm serverless instance but resets on cold start.
 * For production, replace with a database.
 */
let userStore = null;

function getUsers() {
  if (!userStore) {
    userStore = DEMO_USERS.map(({ password, ...u }) => ({
      ...u,
      // Store passwords separately for auth, but don't expose them
    }));
  }
  return userStore;
}

// GET - list all users
export async function GET(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ users: getUsers() });
}

// POST - add a new user
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const users = getUsers();

  // Check for duplicate email
  if (users.find((u) => u.email === body.email)) {
    return NextResponse.json({ error: "Email already exists" }, { status: 409 });
  }

  const newUser = {
    id: `usr-${Date.now()}`,
    name: body.name,
    email: body.email,
    role: body.role || "editor",
    initials: body.initials || body.name.slice(0, 2).toUpperCase(),
    brands: body.brands || [],
    createdAt: new Date().toISOString().split("T")[0],
  };

  userStore.push(newUser);
  return NextResponse.json({ user: newUser });
}

// PUT - update a user
export async function PUT(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const users = getUsers();
  const idx = users.findIndex((u) => u.id === body.id);
  if (idx === -1) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  userStore[idx] = { ...userStore[idx], ...body };
  return NextResponse.json({ user: userStore[idx] });
}

// DELETE - remove a user
export async function DELETE(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("id");

  const users = getUsers();
  const target = users.find((u) => u.id === userId);
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (target.role === "admin") {
    return NextResponse.json({ error: "Cannot remove admin users" }, { status: 403 });
  }

  userStore = users.filter((u) => u.id !== userId);
  return NextResponse.json({ success: true });
}
