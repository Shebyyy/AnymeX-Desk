import { inArray, sql } from 'drizzle-orm';
import { db } from './db/client';
import { users } from './db/schema';

/**
 * @mentions inside comment bodies.
 *
 * A mention must start at the beginning of the body or after a non-word
 * boundary. This allows punctuation around mentions, e.g. "(@user)", while
 * avoiding false positives inside email addresses or words such as foo@bar.
 */
const MENTION_RE = /(?:^|[^a-z0-9_])@([a-z0-9_.]{2,32})(?![a-z0-9_])/gi;

/** Pull the raw @handles out of a comment body, de-duplicated, lowercased. */
export function extractMentionHandles(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    seen.add(m[1].toLowerCase());
  }
  return [...seen];
}

/**
 * Resolve @handles to real users, excluding the author (self-mentions don't
 * notify) and anyone already in `alreadyNotified` (so a mention doesn't
 * double-DM someone who's getting a reply notification already).
 */
export async function resolveMentions(
  body: string,
  authorId: string,
  alreadyNotified: Set<string> = new Set(),
): Promise<{ id: string; username: string }[]> {
  const handles = extractMentionHandles(body);
  if (handles.length === 0) return [];

  const rows = await db()
    .select({ id: users.discordId, username: users.username })
    .from(users)
    .where(inArray(sql`lower(${users.username})`, handles));

  return rows.filter((r) => r.id !== authorId && !alreadyNotified.has(r.id));
}
