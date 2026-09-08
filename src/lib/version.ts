/**
 * App version validation and comparison utilities for AnymeX.
 *
 * Users provide their app version (e.g. "3.1.7" or "3.1.6+4-beta") and optional
 * plugin version when filing a bug. This module validates, compares, and provides
 * outdated-version feedback.
 */

export const APP_OTHER = 'Other';
export const APPS = ['AnymeX', 'AnymeX Preview', APP_OTHER] as const;

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

// Compatibility aliases.
export const isUnreadable = isUnreadableVersion;
export const isVersionUnreadable = isUnreadableVersion;

/**
 * Split a version string into an array of numeric segment parts.
 *
 * Rules:
 * - Leading 'v' or 'V' is stripped.
 * - Surrounding whitespace is stripped.
 * - Prerelease / metadata suffixes (after '-' or '+') are split and non-numeric parts parse to 0.
 * - Parts that are purely alphabetic or unparseable parse to 0.
 */
export function parseVersionParts(version: string): number[] {
  const clean = version.trim().replace(/^[vV]/, '');
  if (!clean) return [];

  // Split into segments by '.' or separators
  // Only parse before prerelease / build markers for base semver comparison
  const mainPart = clean.split(/[-+]/)[0] ?? '';
  const tokens = mainPart.split('.');

  const parts: number[] = [];
  for (const token of tokens) {
    const match = token.match(/^\d+/);
    if (match) {
      parts.push(parseInt(match[0], 10));
    } else {
      parts.push(0);
    }
  }

  // Trim trailing zeros so [14, 1, 0] normalizes to [14, 1] for length-agnostic comparison
  while (parts.length > 0 && parts[parts.length - 1] === 0) {
    parts.pop();
  }

  return parts;
}

/**
 * Extract build number if present (e.g. "+4-beta" -> 4, "+39" -> 39).
 */
export function extractBuildNumber(version: string): number | null {
  const match = version.match(/\+(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Compares two version strings numerically:
 * Returns:
 *   < 0 if v1 < v2
 *   > 0 if v1 > v2
 *   0 if v1 == v2
 */
export function compareVersions(v1: string, v2: string): number {
  const p1 = parseVersionParts(v1);
  const p2 = parseVersionParts(v2);

  const maxLen = Math.max(p1.length, p2.length);
  for (let i = 0; i < maxLen; i++) {
    const num1 = p1[i] ?? 0;
    const num2 = p2[i] ?? 0;
    if (num1 !== num2) {
      return num1 - num2;
    }
  }

  return 0;
}

/**
 * Checks if reportedVersion is genuinely behind latestVersion.
 * Safe against empty or unparseable versions (returns false).
 */
export function isOutdated(reportedVersion: string, latestVersion: string): boolean {
  const r = reportedVersion.trim();
  const l = latestVersion.trim();

  // If either has no digit, never block or accuse of being outdated
  if (!/\d/.test(r) || !/\d/.test(l)) {
    return false;
  }

  return compareVersions(r, l) < 0;
}

export interface VersionAdvisory {
  type: 'blocked' | 'warning' | 'info' | null;
  blocked: boolean;
  message: string | null;
}

export interface ReleaseItem {
  tag: string;
  version: string;
  publishedAt?: string;
  channel?: 'stable' | 'beta';
}

export interface CheckAppVersionParams {
  channel: 'stable' | 'beta';
  version: string;
  allStable?: ReleaseItem[];
  allBeta?: ReleaseItem[];
  latestStable?: ReleaseItem | null;
  latestBeta?: ReleaseItem | null;
}

function findReleaseItem(list?: ReleaseItem[], ver?: string): ReleaseItem | undefined {
  if (!list || !ver) return undefined;
  const target = ver.toLowerCase().replace(/^[vV]/, '').trim();
  return list.find((item) => {
    const itemVer = item.version.toLowerCase().replace(/^[vV]/, '').trim();
    const itemTag = item.tag.toLowerCase().replace(/^[vV]/, '').trim();
    return itemVer === target || itemTag === target;
  });
}

/**
 * Compare reported app version and channel against latest known stable and beta releases.
 * Checks exact publication dates (publishedAt) when available, and falls back to semver.
 * Outdated versions are marked with blocked: true.
 */
export function checkAppVersionAdvisory(params: CheckAppVersionParams): VersionAdvisory {
  const { channel, version, allStable, allBeta, latestStable, latestBeta } = params;
  const v = version.trim();

  if (!v || !/\d/.test(v)) {
    return { type: null, blocked: false, message: null };
  }

  if (channel === 'beta') {
    const userBeta = findReleaseItem(allBeta, v);
    const userBetaTime = userBeta?.publishedAt ? new Date(userBeta.publishedAt).getTime() : null;
    const latestStableTime = latestStable?.publishedAt ? new Date(latestStable.publishedAt).getTime() : null;
    const latestBetaTime = latestBeta?.publishedAt ? new Date(latestBeta.publishedAt).getTime() : null;

    // 1. Check if beta is older than latest stable release (by date, or fallback to version)
    if (userBetaTime !== null && latestStableTime !== null) {
      if (latestStableTime > userBetaTime) {
        return {
          type: 'blocked',
          blocked: true,
          message: `Update required before filing: The preview build you selected was released before the latest stable release (${latestStable?.tag}). This issue might already be fixed in ${latestStable?.tag}. Please update to the latest stable release or latest preview build.`,
        };
      }
    } else if (latestStable?.version) {
      const cmpStable = compareVersions(v, latestStable.version);
      if (cmpStable < 0) {
        return {
          type: 'blocked',
          blocked: true,
          message: `Update required before filing: This preview build (${v}) is older than the latest stable release (${latestStable.tag}). Please update to the latest stable release or latest preview build.`,
        };
      }
    }

    // 2. Check if beta is older than latest beta release
    if (userBetaTime !== null && latestBetaTime !== null) {
      if (latestBetaTime > userBetaTime) {
        return {
          type: 'blocked',
          blocked: true,
          message: `Update required before filing: You are reporting on an older preview build (${userBeta?.tag || v}). The latest preview build is ${latestBeta?.tag}. Please update to the latest preview release before reporting.`,
        };
      }
    } else if (latestBeta?.version) {
      const cmpBeta = compareVersions(v, latestBeta.version);
      const reportedBuild = extractBuildNumber(v);
      const latestBetaBuild = extractBuildNumber(latestBeta.version);

      if (cmpBeta < 0 || (cmpBeta === 0 && reportedBuild !== null && latestBetaBuild !== null && reportedBuild < latestBetaBuild)) {
        return {
          type: 'blocked',
          blocked: true,
          message: `Update required before filing: You are reporting on an older preview build (${v}). The latest preview build is ${latestBeta.tag}. Please update to the latest preview release before reporting.`,
        };
      }
    }
  } else {
    // Channel is 'stable'
    const userStable = findReleaseItem(allStable, v);
    const userStableTime = userStable?.publishedAt ? new Date(userStable.publishedAt).getTime() : null;
    const latestStableTime = latestStable?.publishedAt ? new Date(latestStable.publishedAt).getTime() : null;
    const latestBetaTime = latestBeta?.publishedAt ? new Date(latestBeta.publishedAt).getTime() : null;

    // 1. Check if stable is older than latest stable
    if (userStableTime !== null && latestStableTime !== null) {
      if (latestStableTime > userStableTime) {
        return {
          type: 'blocked',
          blocked: true,
          message: `Update required before filing: You are reporting on an older stable version (${userStable?.tag || v}). The latest stable release is ${latestStable?.tag}. Please update to the latest release before reporting.`,
        };
      }
    } else if (latestStable?.version) {
      const cmpStable = compareVersions(v, latestStable.version);
      if (cmpStable < 0) {
        return {
          type: 'blocked',
          blocked: true,
          message: `Update required before filing: You are reporting on an older stable version (${v}). The latest stable release is ${latestStable.tag}. Please update to the latest release before reporting.`,
        };
      }
    }

    // 2. If on latest stable, check if a newer beta release came out afterwards (informational)
    if (latestBetaTime !== null && latestStableTime !== null && latestBetaTime > latestStableTime) {
      return {
        type: 'info',
        blocked: false,
        message: `A newer preview build (${latestBeta?.tag}) was published after this version and is currently in testing. This issue might already be fixed in the latest beta.`,
      };
    }
  }

  return { type: null, blocked: false, message: null };
}

/**
 * Check if plugin version is outdated compared to latest runtime bridge release.
 */
export function checkPluginVersionAdvisory(
  reportedPluginVersion: string,
  latestPlugin?: ReleaseItem | null,
): VersionAdvisory {
  const pv = reportedPluginVersion.trim();
  if (!pv || !/\d/.test(pv) || !latestPlugin?.version) {
    return { type: null, blocked: false, message: null };
  }

  if (compareVersions(pv, latestPlugin.version) < 0) {
    return {
      type: 'warning',
      blocked: false,
      message: `A newer extension runtime plugin (${latestPlugin.tag}) is available. Please update in Settings → Extensions → Settings icon to see if that resolves the issue.`,
    };
  }

  return { type: null, blocked: false, message: null };
}
