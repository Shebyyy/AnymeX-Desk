/**
 * App version validation for AnymeX.
 *
 * Users optionally provide their app version (e.g. "3.1.7+39") when filing
 * a bug. This module validates the format.
 */

/** True when the input looks like a version string (has at least one digit). */
export function isValidAppVersion(version: string): boolean {
  const v = version.trim();
  if (!v) return false;
  return /\d/.test(v);
}

/** True when the input is non-empty but has no digit — unparseable. */
export function isUnreadableVersion(version: string): boolean {
  return version.trim().length > 0 && !/\d/.test(version);
}

// Compatibility alias.
export const isUnreadable = isUnreadableVersion;
export const isVersionUnreadable = isUnreadableVersion;
