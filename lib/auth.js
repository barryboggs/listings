import { SignJWT, jwtVerify } from "jose";

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET || "driven-brands-listing-manager-prototype-secret-2026"
);

export async function signToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret);
}

export async function verifyToken(token) {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch {
    return null;
  }
}

// Demo users for prototype - production would use a real database
export const DEMO_USERS = [
  {
    id: "usr-001",
    email: "admin@drivenbrands.com",
    password: "admin123",
    name: "Admin User",
    role: "admin",
    initials: "AU",
    brands: ["carstar", "take5", "autoglass"],
    createdAt: "2026-01-15",
  },
  {
    id: "usr-002",
    email: "barry@drivenbrands.com",
    password: "demo123",
    name: "Barry S.",
    role: "manager",
    initials: "BS",
    brands: ["carstar", "take5", "autoglass"],
    createdAt: "2026-01-15",
  },
  {
    id: "usr-003",
    email: "maria@drivenbrands.com",
    password: "demo123",
    name: "Maria T.",
    role: "editor",
    initials: "MT",
    brands: ["carstar"],
    createdAt: "2026-02-01",
  },
  {
    id: "usr-004",
    email: "james@drivenbrands.com",
    password: "demo123",
    name: "James R.",
    role: "editor",
    initials: "JR",
    brands: ["take5", "autoglass"],
    createdAt: "2026-02-10",
  },
];

export function findUser(email, password) {
  return DEMO_USERS.find(
    (u) => u.email === email && u.password === password
  );
}

export function getUserByEmail(email) {
  return DEMO_USERS.find((u) => u.email === email);
}
