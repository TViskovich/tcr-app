// Report-scoped media inspection for administrators (Phase 2B M5.3). Admin
// only, one image per request, never preloaded by the app.
//
// POST { report_id: uuid, ref: 1-50, confirm_child_safety?: boolean }
//   Authorization: Bearer <admin user JWT>
// → 200 { status: 'ok', signed_path, expires_in, kind, child_safety }
//   200 { status: 'refused', reason }   not_found | unavailable | quarantined |
//                                       child_safety_confirmation_required
//   400 invalid_body · 401 unauthorized · 403 forbidden · 500 sign_failed
//
// What can be opened is decided by the database, not by this function or
// the app: public.report_media_authorize (service role only) re-checks the
// caller's admin standing (admin_users, not suspended, not pending
// deletion), resolves `ref` against THAT report's recorded evidence (DM
// photo, folder cover, item images, post image, avatar), refuses media that
// is no longer at its recorded location (a quarantined original is never
// served — quarantine copies stay service-only), requires an explicit
// confirmation for child-safety reports, and logs every request
// (private.report_media_access). Only then is that one object signed, for
// 60 seconds. No path, bucket or URL is accepted from the caller.
//
// The response carries the signed URL as a path relative to the project URL
// (the app prefixes its own), so the runtime's internal host never leaks.
// Logs carry ids and outcome codes only — never paths, URLs or report text.
//
// Deploy with gateway JWT verification (the default).
import { requireAdmin } from '../_shared/admin-auth.ts';
import { handleCorsPreflight, jsonResponse, serviceRoleClient } from '../_shared/registry-image.ts';

const SIGNED_URL_TTL_SECONDS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGN_PREFIX = '/storage/v1/object/sign/';

const noStore = (body: unknown, status: number) => {
  const r = jsonResponse(body, status);
  r.headers.set('Cache-Control', 'no-store');
  return r;
};

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return noStore({ status: 'failed', reason: 'method_not_allowed' }, 405);

  let body: { report_id?: unknown; ref?: unknown; confirm_child_safety?: unknown };
  try {
    body = await req.json();
  } catch {
    return noStore({ status: 'failed', reason: 'invalid_body' }, 400);
  }
  const reportId = body.report_id;
  const ref = body.ref;
  if (typeof reportId !== 'string' || !UUID_RE.test(reportId) || typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1 || ref > 50
      || (body.confirm_child_safety !== undefined && typeof body.confirm_child_safety !== 'boolean')) {
    return noStore({ status: 'failed', reason: 'invalid_body' }, 400);
  }

  const client = serviceRoleClient();
  const admin = await requireAdmin(client, req, 'admin-report-media');
  if (!admin.ok) {
    admin.response.headers.set('Cache-Control', 'no-store');
    return admin.response;
  }
  const { data: auth, error } = await client.rpc('report_media_authorize', {
    p_admin: admin.userId, p_report_id: reportId, p_ref: ref, p_confirm_child_safety: body.confirm_child_safety === true,
  });
  if (error || !auth?.ok) {
    const reason = auth?.reason === 'not_found' ? 'not_found' : 'forbidden';
    console.log(JSON.stringify({ fn: 'admin-report-media', admin: admin.userId, report: reportId, outcome: reason }));
    return reason === 'not_found' ? noStore({ status: 'refused', reason }, 200) : noStore({ status: 'failed', reason }, 403);
  }
  if (!auth.allowed) {
    console.log(JSON.stringify({ fn: 'admin-report-media', admin: admin.userId, report: reportId, ref, outcome: auth.reason }));
    return noStore({ status: 'refused', reason: auth.reason, child_safety: auth.child_safety === true }, 200);
  }

  const { data: signed, error: signError } = await client.storage.from(auth.bucket as string).createSignedUrl(auth.path as string, SIGNED_URL_TTL_SECONDS);
  let signedPath: string | null = null;
  try {
    const u = new URL(signed?.signedUrl ?? '');
    if (u.pathname.startsWith(SIGN_PREFIX)) signedPath = u.pathname + u.search;
  } catch {
    signedPath = null;
  }
  if (signError || !signedPath) {
    console.log(JSON.stringify({ fn: 'admin-report-media', admin: admin.userId, report: reportId, ref, outcome: 'sign_failed' }));
    return noStore({ status: 'failed', reason: 'sign_failed' }, 500);
  }
  console.log(JSON.stringify({ fn: 'admin-report-media', admin: admin.userId, report: reportId, ref, outcome: 'signed', child_safety: auth.child_safety === true }));
  return noStore({ status: 'ok', signed_path: signedPath, expires_in: SIGNED_URL_TTL_SECONDS, kind: auth.kind, child_safety: auth.child_safety === true }, 200);
});
