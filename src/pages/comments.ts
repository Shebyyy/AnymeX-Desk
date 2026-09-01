import type { APIRoute } from 'astro';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { canWriteNow, currentUser, avatarUrl } from '../lib/auth';
import { db } from '../lib/db/client';
import { comments, reports, users, notifications } from '../lib/db/schema';
import { atLeast } from '../lib/levels';
import { levelOf } from '../lib/staff';
import { isReportId } from '../lib/writes';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/* ── GET — list comments for a report ────────────────────────────────── */
export const GET: APIRoute = async (ctx) => {
  const reportId = Number(ctx.url.searchParams.get('reportId'));
  if (!isReportId(reportId)) return json({ error: 'invalid report id' }, 400);

  const rows = await db()
    .select({
      id: comments.id,
      body: comments.body,
      userId: comments.userId,
      username: users.username,
      avatarHash: users.avatarHash,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.discordId, comments.userId))
    .where(eq(comments.reportId, reportId))
    .orderBy(asc(comments.createdAt));

  return json(
    rows.map((r) => ({
      id: r.id,
      body: r.body,
      userId: r.userId,
      username: r.username,
      avatarUrl: avatarUrl({ id: r.userId, avatarHash: r.avatarHash }),
      createdAt: r.createdAt,
    })),
  );
};

/* ── POST — add a comment ────────────────────────────────────────────── */
export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) return json({ error: 'sign-in' }, 401);
  if (!(await canWriteNow(user))) return json({ error: 'banned' }, 403);

  const form = await ctx.request.formData();
  const reportId = Number(form.get('reportId'));
  const body = String(form.get('body') ?? '').trim();

  if (!isReportId(reportId)) return json({ error: 'invalid report id' }, 400);
  if (!body) return json({ error: 'body is empty' }, 400);
  if (body.length > 2000) return json({ error: 'body too long (max 2000 chars)' }, 400);

  /* Verify the report exists. */
  const [report] = await db()
    .select({ id: reports.id, reporterId: reports.reporterId })
    .from(reports)
    .where(eq(reports.id, reportId));
  if (!report) return json({ error: 'report not found' }, 404);

  /* Insert comment + bump counter in a batch. */
  const d = db();
  const [inserted] = await d.batch([
    d
      .insert(comments)
      .values({ reportId, userId: user.id, body })
      .returning({
        id: comments.id,
        body: comments.body,
        userId: comments.userId,
        createdAt: comments.createdAt,
      }),
    d
      .update(reports)
      .set({ commentCount: sql`${reports.commentCount} + 1` })
      .where(eq(reports.id, reportId)),
  ]);

  const comment = inserted[0];

  /* Notify the reporter (skip if commenting on your own report). */
  if (report.reporterId !== user.id) {
    const cf = ctx.locals.cfContext;
    const notif = db()
      .insert(notifications)
      .values({
        userId: report.reporterId,
        reportId,
        kind: 'comment',
      });
    if (cf) cf.waitUntil(notif);
    else await notif;
  }

  return json({
    id: comment.id,
    body: comment.body,
    userId: comment.userId,
    username: user.username,
    avatarUrl: avatarUrl(user),
    createdAt: comment.createdAt,
  });
};

/* ── DELETE — remove a comment ───────────────────────────────────────── */
export const DELETE: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) return json({ error: 'sign-in' }, 401);

  const form = await ctx.request.formData();
  const commentId = Number(form.get('commentId'));
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    return json({ error: 'invalid comment id' }, 400);
  }

  /* Load the comment to check ownership. */
  const [comment] = await db()
    .select({ id: comments.id, userId: comments.userId, reportId: comments.reportId })
    .from(comments)
    .where(eq(comments.id, commentId));
  if (!comment) return json({ error: 'comment not found' }, 404);

  /* Author or staff (mod+) can delete. */
  const isAuthor = comment.userId === user.id;
  const isStaff = atLeast(await levelOf(user.id), 'mod');
  if (!isAuthor && !isStaff) return json({ error: 'forbidden' }, 403);

  /* Delete comment + decrement counter in a batch. */
  const d = db();
  await d.batch([
    d.delete(comments).where(eq(comments.id, commentId)),
    d
      .update(reports)
      .set({ commentCount: sql`max(0, ${reports.commentCount} - 1)` })
      .where(eq(reports.id, comment.reportId)),
  ]);

  return new Response(null, { status: 204 });
};
