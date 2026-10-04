// Minimal Resend sender for server-side waitlist email (grant-waitlist-
// access). join-waitlist still has its own inline sender and is untouched.
//
// Never throws, never logs: returns a result the caller reports and logs
// with its own context. RESEND_API_KEY / WAITLIST_FROM_EMAIL are Edge
// Function secrets and never leave this module. Message content (which can
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

export async function sendResendEmail(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<EmailResult> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('WAITLIST_FROM_EMAIL');
  if (!apiKey || !from) return { sent: false, reason: 'email_not_configured' };

  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, ...message }),
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
