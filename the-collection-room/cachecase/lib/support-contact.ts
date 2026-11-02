// Support & Contact destinations shown on the Dashboard.
//
// Only CONFIRMED destinations belong here. Each one left null renders as a
// clearly labelled "not available yet" row instead of a link, so nothing
// points collectors at an address or page that doesn't exist. To go live,
// set the value — no other code changes are needed:
//   email          → opens the mail composer (mailto:)
//   helpCenterUrl  → opens in the in-app browser (https only)
//   reportIssueUrl → opens in the in-app browser; when null but `email` is
//                    set, Report a Problem composes an email instead
export const SUPPORT_CONTACT: {
  email: string | null;
  helpCenterUrl: string | null;
  reportIssueUrl: string | null;
} = {
  email: null,
  helpCenterUrl: null,
  reportIssueUrl: null,
};
