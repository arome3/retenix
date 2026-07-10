/*
 * S1 carries two things across its screens: the address the user typed, and a
 * correlation id for the warm-path timer (PS-F1-AC1).
 *
 * sessionStorage, never the URL: an email in a query string ends up in browser
 * history, in referrers, and in every server access log it touches.
 *
 * Private-mode browsers throw on storage access, so every read and write is
 * defensive — a failure degrades the flow, it does not break it.
 */
const SID_KEY = "retenix:onboarding:sid";
const EMAIL_KEY = "retenix:onboarding:email";

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage is unavailable; the flow still works, the timer just cannot pair.
  }
}

/** Starts a run and returns its correlation id. */
export function beginOnboarding(email: string): string {
  const sid = crypto.randomUUID();
  write(SID_KEY, sid);
  write(EMAIL_KEY, email);
  return sid;
}

export function readOnboarding(): { sid: string | null; email: string | null } {
  return { sid: read(SID_KEY), email: read(EMAIL_KEY) };
}

/** Drops the address as soon as it has served its purpose. */
export function forgetOnboardingEmail(): void {
  try {
    sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    // Nothing to clear if storage is unreachable.
  }
}

export function endOnboarding(): void {
  forgetOnboardingEmail();
  try {
    sessionStorage.removeItem(SID_KEY);
  } catch {
    // As above.
  }
}
