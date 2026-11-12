/**
 * Known analytics / tracking domains. Small, auditable list; matches the
 * domain itself and any subdomain. Extend as needed.
 */
export const TRACKER_DOMAINS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "analytics.google.com",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "hotjar.com",
  "hotjar.io",
  "fullstory.com",
  "heap.io",
  "heapanalytics.com",
  "intercom.io",
  "sentry.io",
  "datadoghq.com",
  "newrelic.com",
  "nr-data.net",
  "facebook.net",
  "connect.facebook.net",
  "plausible.io",
  "posthog.com",
  "i.posthog.com",
  "clarity.ms",
  "cloudflareinsights.com",
  "logrocket.io",
  "bugsnag.com",
];

export function isKnownTracker(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return TRACKER_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}
