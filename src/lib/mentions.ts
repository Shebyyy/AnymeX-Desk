import { inArray, sql } from 'drizzle-orm';
import { db } from './db/client';
import { users } from './db/schema';

/**
 * @mentions inside comment bodies.
 *
 * Discord usernames are lowercase-ish, 2–32 chars, letters/digits/._ — this
 * mirrors that shape closely enough to avoid false positives on things like
 * email addresses (which have a dot immediately before an @, not after).
 */
const MENTION_RE = /(?:^|\s)@([a-z0-9_.]{2,32})/gi;

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
 * double-DM someone who's getting a comment/reply notification already).
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
