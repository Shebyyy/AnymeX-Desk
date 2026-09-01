import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { canWriteNow, currentUser, avatarUrl } from '../lib/auth';
import { db } from '../lib/db/client';
import { comments, reports, users, notifications, attachments } from '../lib/db/schema';
import { atLeast } from '../lib/levels';
import { levelOf } from '../lib/staff';
import { isReportId } from '../lib/writes';
import { sendDiscordDm } from '../lib/notify';

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

  // Fetch attachments grouped by comment.
  const atts = await db()
    .select({
      commentId: attachments.commentId,
      id: attachments.id,
      fileName: attachments.fileName,
      filePath: attachments.filePath,
      fileType: attachments.fileType,
      mimeType: attachments.mimeType,
      fileSize: attachments.fileSize,
    })
    .from(attachments)
    .where(eq(attachments.reportId, reportId));

  const attByComment = new Map<number, typeof atts>();
  for (const a of atts) {
    if (a.commentId == null) continue;
    const list = attByComment.get(a.commentId) ?? [];
    list.push(a);
    attByComment.set(a.commentId, list);
  }

  return json(
    rows.map((r) => ({
      id: r.id,
      body: r.body,
      userId: r.userId,
      username: r.username,
      avatarUrl: avatarUrl({ id: r.userId, avatarHash: r.avatarHash }),
      createdAt: r.createdAt,
      attachments: attByComment.get(r.id) ?? [],
    })),
  );
};

/* ── POST — add a comment (with optional file attachment) ────────────── */
export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) return json({ error: 'sign-in' }, 401);
  if (!(await canWriteNow(user))) return json({ error: 'banned' }, 403);

  const form = await ctx.request.formData();
  const reportId = Number(form.get('reportId'));
  const body = String(form.get('body') ?? '').trim();
  const file = form.get('file') as File | null;

  if (!isReportId(reportId)) return json({ error: 'invalid report id' }, 400);
  if (!body && !file) return json({ error: 'body or file is required' }, 400);
  if (body.length > 2000) return json({ error: 'body too long (max 2000 chars)' }, 400);

  /* Verify the report exists. */
  const [report] = await db()
    .select({ id: reports.id, reporterId: reports.reporterId, title: reports.title })
    .from(reports)
    .where(eq(reports.id, reportId));
  if (!report) return json({ error: 'report not found' }, 404);

  /* Insert comment + bump counter. */
  const d = db();
  const [inserted] = await d.batch([
    d
      .insert(comments)
      .values({ reportId, userId: user.id, body: body || '' })
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

  /* Upload file attachment if provided. */
  let attachment = null;
  if (file && file.size > 0) {
    const mime = file.type || 'application/octet-stream';
    const uuid = crypto.randomUUID();
    const filePath = `uploads/${uuid}/${file.name}`;
    const kvKey = `upload:${filePath}`;

    // Determine file type.
    let fileType = 'file';
    if (mime.startsWith('image/')) fileType = 'image';
    else if (mime.startsWith('video/')) fileType = 'video';

    // Store in KV.
    const kv = env.SESSION as KVNamespace | undefined;
    if (kv) {
      const buf = await file.arrayBuffer();
      await kv.put(kvKey, buf, {
        metadata: { mimeType: mime, fileName: file.name },
        expirationTtl: 60 * 60 * 24 * 365,
      });
    }

    // Save metadata.
    const [attInserted] = await d
      .insert(attachments)
      .values({
        reportId,
        commentId: comment.id,
        fileName: file.name,
        filePath,
        fileType,
        mimeType: mime,
        fileSize: file.size,
      })
      .returning({
        id: attachments.id,
        fileName: attachments.fileName,
        filePath: attachments.filePath,
        fileType: attachments.fileType,
        mimeType: attachments.mimeType,
        fileSize: attachments.fileSize,
      });
    attachment = attInserted;
  }

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
    const dmText = body
      ? `**${user.username}** commented on your report "${report.title}":\n> ${body.slice(0, 300)}`
      : `**${user.username}** attached a file to your report "${report.title}".`;
    const dm = sendDiscordDm(report.reporterId, dmText);
    if (cf) { cf.waitUntil(notif); cf.waitUntil(dm); }
    else { await notif; await dm; }
  }

  return json({
    id: comment.id,
    body: comment.body,
    userId: comment.userId,
    username: user.username,
    avatarUrl: avatarUrl(user),
    createdAt: comment.createdAt,
    attachment,
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
