import { fetchPublicRegistryCard, normalizeCcId } from '@/lib/registry-api';

// Matches ALLOWED_IMAGE_MIME_TYPES in supabase/functions/_shared/registry-image.ts
// (the main app's own upload-time allowlist) — the same set of types that
// could ever legitimately have been uploaded, duplicated here for the same
// cross-runtime-boundary reason as this project's other duplicated tables.
const ALLOWED_IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Same-origin image proxy. get-public-registry-card returns a signed
// Supabase Storage URL whose PATH is registered_cards.id (an internal
// UUID) — that's an existing storage-layout convention from the durable
// snapshot-image system (copy-registry-snapshot-image /
// get-registry-snapshot-image-url), not something this project can change
// without touching already-deployed backend infrastructure outside this
// project's scope. But handing that URL straight to <img src> would put
// the internal id directly in this site's rendered HTML, which the
// security requirements this project was built under explicitly forbid.
// This route fetches the signed URL server-side and streams the bytes
// back under this site's own domain instead — the browser only ever sees
// /registry/<cc_id>/image, never the Supabase URL or the internal id.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ccId: string }> },
) {
  const { ccId: rawCcId } = await params;
  const ccId = normalizeCcId(rawCcId);
  if (!ccId) {
    return new Response(null, { status: 404 });
  }

  const result = await fetchPublicRegistryCard(ccId);
  if (result.status !== 'ok' || !result.data.snapshot_image_url) {
    return new Response(null, { status: 404 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(result.data.snapshot_image_url, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return new Response(null, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: 502 });
  }

  // Validated by actual Content-Type only — never by the storage path's
  // file extension or any part of the URL, neither of which are trustworthy
  // indicators of what bytes actually follow. The charset/boundary
  // parameter (e.g. "image/jpeg; charset=binary") is stripped before
  // comparing, since it doesn't change what the content actually is.
  const upstreamContentType = upstream.headers.get('Content-Type') ?? '';
  const mimeType = upstreamContentType.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_CONTENT_TYPES.has(mimeType)) {
    // Drain the body so the connection can be released, but never inspect
    // or forward it — an unexpected type (text/html, application/json,
    // image/svg+xml, etc.) is treated as a failure, not rendered.
    await upstream.body?.cancel();
    return new Response(null, { status: 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      // The underlying signed URL is valid for 5 minutes; a short public
      // cache window is safe (the image content itself isn't sensitive —
      // only its original storage path was) and avoids re-fetching from
      // Storage on every repeat view within that window.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
