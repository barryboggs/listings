import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { put } from "@vercel/blob";
import sharp from "sharp";

// Resize images down so Semrush's image endpoint reliably accepts the
// payload. We hit a pattern where ~1.4MB images caused most batched
// pushes to silently return 400 "Invalid request" despite the image
// landing on Semrush. Smaller payloads stop tripping it.
const RESIZE_MAX_EDGE_PX = 1200;
const JPEG_QUALITY = 85;

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
    // Resize via sharp. Preserves aspect ratio; only downscales (never upscales).
    // PNG inputs stay PNG so logo transparency is preserved; JPEG/WebP become
    // JPEG since downstream directories most reliably display JPEG.
    const originalBuffer = Buffer.from(await file.arrayBuffer());
    const inputMeta = await sharp(originalBuffer).metadata();

    const needsResize = (inputMeta.width || 0) > RESIZE_MAX_EDGE_PX || (inputMeta.height || 0) > RESIZE_MAX_EDGE_PX;
    const keepAsPng = file.type === "image/png";

    let processedBuffer;
    let outputContentType;
    let outputExt;

    if (needsResize || !keepAsPng) {
      let pipeline = sharp(originalBuffer).resize({
        width: RESIZE_MAX_EDGE_PX,
        height: RESIZE_MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      });
      if (keepAsPng) {
        pipeline = pipeline.png({ compressionLevel: 9 });
        outputContentType = "image/png";
        outputExt = "png";
      } else {
        pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
        outputContentType = "image/jpeg";
        outputExt = "jpg";
      }
      processedBuffer = await pipeline.toBuffer();
    } else {
      // Already within size limits and PNG — pass through unchanged.
      processedBuffer = originalBuffer;
      outputContentType = file.type;
      outputExt = file.type === "image/png" ? "png" : file.type === "image/jpeg" ? "jpg" : "webp";
    }

    const outputMeta = await sharp(processedBuffer).metadata();

    // Random suffix so two admins uploading the same filename don't collide.
    const safeName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "image";
    const blob = await put(
      `listings-photos/${Date.now()}-${safeName}.${outputExt}`,
      processedBuffer,
      {
        access: "public",
        contentType: outputContentType,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      }
    );

    return NextResponse.json({
      success: true,
      url: blob.url,
      pathname: blob.pathname,
      contentType: outputContentType,
      // Surface enough info that the page can show a clear preview/comparison
      // ("Resized from 1.4 MB → 320 KB · 1024×768").
      originalSize: file.size,
      originalContentType: file.type,
      originalWidth: inputMeta.width || null,
      originalHeight: inputMeta.height || null,
      resizedSize: processedBuffer.length,
      resizedWidth: outputMeta.width || null,
      resizedHeight: outputMeta.height || null,
      wasResized: processedBuffer.length !== originalBuffer.length || outputContentType !== file.type,
    });
  } catch (error) {
    console.error("Vercel Blob upload error:", error.message);
    return NextResponse.json({ error: `Upload failed: ${error.message}` }, { status: 502 });
  }
}
