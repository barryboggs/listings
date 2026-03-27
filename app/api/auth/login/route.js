import { NextResponse } from "next/server";
import { findUser, signToken } from "@/lib/auth";
import { findUserByEmail } from "@/lib/db";

export async function POST(request) {
  try {
    const { email, password } = await request.json();

    // Try database first (includes DEMO_USERS as fallback)
    let user = await findUserByEmail(email);

    if (!user || user.password !== password) {
      // Fall back to in-memory DEMO_USERS
      user = findUser(email, password);
    }

    if (!user) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    const token = await signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      initials: user.initials,
      brands: typeof user.brands === "string" ? JSON.parse(user.brands) : user.brands,
    });

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        initials: user.initials,
        brands: typeof user.brands === "string" ? JSON.parse(user.brands) : user.brands,
      },
    });

    response.cookies.set("auth-token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 8,
      path: "/",
    });

    return response;
  } catch (error) {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
