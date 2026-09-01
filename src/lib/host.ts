/**
 * URL host utilities.
 *
 * Kept as a general-purpose helper — useful for validating URLs in attachments
 * or user-submitted links.
 */

/**
 * The comparable host of an address: lowercased, no leading `www.`, no path.
 */
export function hostOf(url: string): string | null {
  const v = url.trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.host.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** True only when both addresses parse and name the same host. */
export function sameHost(a: string, b: string): boolean {
  const x = hostOf(a);
  return x !== null && x === hostOf(b);
}
