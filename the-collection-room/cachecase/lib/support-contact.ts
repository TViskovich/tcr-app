// Support & Contact destinations shown on the Dashboard and on account
// deletion / Download My Data failure states.
//
// Only CONFIRMED destinations belong here. Each one left null renders as a
// clearly labelled "not available yet" row instead of a link, so nothing
// points collectors at an address or page that doesn't exist. To go live,
// set the value — no other code changes are needed:
//   email          → opens the mail composer (mailto:)
//   helpCenterUrl  → opens in the in-app browser (https only)
//   reportIssueUrl → opens in the in-app browser; when null but `email` is
//                    set, Report a Problem composes an email instead
//
// email: the official beta support address (forwarded to the team inbox).
// The help center and issue-report pages don't exist yet.
export const SUPPORT_CONTACT: {
  email: string | null;
  helpCenterUrl: string | null;
  reportIssueUrl: string | null;
} = {
  email: 'info@cachecase.com',
  helpCenterUrl: null,
  reportIssueUrl: null,
};

// A mailto: link to support, or null when no email is configured.
export function supportMailto(subject?: string): string | null {
  if (!SUPPORT_CONTACT.email) return null;
  return `mailto:${SUPPORT_CONTACT.email}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
}
