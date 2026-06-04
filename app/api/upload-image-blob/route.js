import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { put } from "@vercel/blob";

/**
 * POST /api/upload-image-blob
 *
 * Receives a single image file via multipart/form-data (field name "file"),
 * uploads it to Vercel Blob, returns the public URL. The /dashboard/listings-photos
 * page calls this once per bulk-push operation: upload the brand asset
 * once, then re-use its URL for every shop's individual Semrush push
 * (which the server base64-encodes from the same URL).
 *
 * Requires BLOB_READ_WRITE_TOKEN in env (Vercel auto-injects when a Blob
 * store is configured for the project). Without it, this returns 503 and
 * the page falls back to URL-paste-only mode.
 */
export async function POST(request) {
  const token = request.cookies.get("auth-token")?.value;
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await verifyToken(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["admin", "manager"].includes(user.role)) {
    return NextResponse.json({ error: "Admin or manager access required" }, { status: 403 });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Vercel Blob not configured (BLOB_READ_WRITE_TOKEN missing). Use URL-paste mode instead." },
      { status: 503 }
    );
  }

  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file field is required and must be a binary upload" }, { status: 400 });
  }

  // Reject ridiculous sizes early. Semrush's image endpoint hasn't
  // documented a max but a sane upper bound prevents accidental
  // 50MB uploads from chewing through Blob storage.
  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `Image too large (${file.size} bytes). Max ${MAX_BYTES} bytes.` }, { status: 400 });
  }

  // Validate it's an image-ish type
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  if (!allowed.includes(file.type)) {
    return NextResponse.json({ error: `Unsupported content type: ${file.type}. Allowed: ${allowed.join(", ")}` }, { status: 400 });
  }

  try {
    // Random suffix so two admins uploading the same filename don't collide.
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "image";
    const blob = await put(`listings-photos/${Date.now()}-${safeName}`, file, {
      access: "public",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return NextResponse.json({
      success: true,
      url: blob.url,
      pathname: blob.pathname,
      size: file.size,
      contentType: file.type,
    });
  } catch (error) {
    console.error("Vercel Blob upload error:", error.message);
    return NextResponse.json({ error: `Upload failed: ${error.message}` }, { status: 502 });
  }
}
