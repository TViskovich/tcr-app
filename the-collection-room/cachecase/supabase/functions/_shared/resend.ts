// Minimal Resend sender for server-side email: waitlist access (grant-
// waitlist-access), account deletion monitoring alerts (account-monitor) and
// moderation alerts (moderation-monitor, with its own dedicated key).
// join-waitlist still has its own inline sender and is untouched.
//
// Never throws, never logs: returns a result the caller reports and logs
// with its own context. RESEND_API_KEY / WAITLIST_FROM_EMAIL are Edge
// Function secrets and never leave this module (a caller may pass its own
// verified sender as `from`). Message content (which can
// carry an invite code) is never logged; neither is Resend's error message,
// which can echo the recipient address.

export type EmailResult =
  | { sent: true; resendId: string | null; httpStatus: number }
  | {
      sent: false;
      reason: 'email_not_configured' | 'resend_rejected' | 'resend_unreachable';
      httpStatus?: number;
      resendError?: string; // Resend's error `name`, e.g. "validation_error"
    };

// Local testing only: RESEND_API_URL may point the sender at a mock provider
// on this machine (localhost, 127.0.0.1 or host.docker.internal). Any other
// value is ignored, so the API key is never sent anywhere but Resend.
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
function resendEndpoint(): string {
  const override = Deno.env.get('RESEND_API_URL');
  if (!override) return RESEND_ENDPOINT;
  try {
    const url = new URL(override);
    if (['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname)) return url.toString();
  } catch {}
  return RESEND_ENDPOINT;
}

export async function sendResendEmail(message: {
  to: string | string[];
  subject: string;
  text: string;
  html: string;
  from?: string;
  // A caller with its own dedicated key (moderation-monitor) passes it here;
  // everyone else uses RESEND_API_KEY. Never sent anywhere but the header.
  apiKey?: string;
}): Promise<EmailResult> {
  const { apiKey: dedicatedKey, ...content } = message;
  const apiKey = dedicatedKey ?? Deno.env.get('RESEND_API_KEY');
  const from = content.from || Deno.env.get('WAITLIST_FROM_EMAIL');
  if (!apiKey || !from) return { sent: false, reason: 'email_not_configured' };

  let res: Response;
  try {
    res = await fetch(resendEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...content, from }),
    });
  } catch {
    return { sent: false, reason: 'resend_unreachable' };
  }

  let payload: { id?: unknown; name?: unknown } = {};
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body — status code alone decides.
  }

  if (!res.ok) {
    return {
      sent: false,
      reason: 'resend_rejected',
      httpStatus: res.status,
      resendError: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }
  return {
    sent: true,
    resendId: typeof payload.id === 'string' ? payload.id : null,
    httpStatus: res.status,
  };
}
