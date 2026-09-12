import type { User } from './db/schema';

/**
 * Who filed a report, in the one wording every surface uses.
 *
 * The username is stored at login, so we can display it without a Discord
 * API call. Reports with a real Discord snowflake as reporterId are
 * looked up in the users table.
 */

export const isRealAccount = (reporterId: string) =>
  Boolean(reporterId && reporterId.trim() !== '' && reporterId !== '0');

export interface ReporterMeta {
  /** What every surface shows. */
  display: string;
}

/**
 * One branch, two surfaces.
 *
 * Called with a report row's `reporterId` and the `users` row for that id (from `dbUser`).
 */
export function reporterMeta(
  reporterId: string,
  user?: Pick<User, 'username'> | null,
): ReporterMeta {
  if (!isRealAccount(reporterId)) return { display: 'unknown' };
  return { display: user?.username ?? 'unknown' };
}

/**
 * The display name, reading `users` only when there is an account to read.
 *
 * Takes the loader rather than importing `dbUser`, so this module stays free of
 * the database (and therefore of `cloudflare:workers`).
 */
export async function reporterName(
  reporterId: string,
  load: (id: string) => Promise<Pick<User, 'username'> | undefined>,
): Promise<string> {
  const user = isRealAccount(reporterId) ? await load(reporterId) : null;
  return reporterMeta(reporterId, user).display;
}
