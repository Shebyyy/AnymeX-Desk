import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { canWriteNow, currentUser, avatarUrl } from '../lib/auth';
import { db } from '../lib/db/client';
import { comments, reports, users, notifications, attachments } from '../lib/db/schema';
import { atLeast } from '../lib/levels';
import { levelOf, logAction } from '../lib/staff';
import { isReportId } from '../lib/writes';
import { sendDiscordDm } from '../lib/notify';
import { resolveMentions } from '../lib/mentions';

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
      updatedAt: comments.updatedAt,
      replyToId: comments.replyToId,
    })
    .from(comments)
    .innerJoin(users, eq(users.discordId, comments.userId))
    .where(eq(comments.reportId, reportId))
    .orderBy(asc(comments.createdAt));

  // Look up usernames for whatever comments are being replied to.
  const usernameById = new Map(rows.map((r) => [r.id, r.username]));

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
      updatedAt: r.updatedAt,
      edited: r.updatedAt !== r.createdAt,
      attachments: attByComment.get(r.id) ?? [],
      replyToId: r.replyToId,
      replyToUsername: r.replyToId != null ? usernameById.get(r.replyToId) ?? null : null,
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
  const replyToRaw = form.get('replyToId');
  let replyToId: number | null = replyToRaw ? Number(replyToRaw) : null;
  if (replyToId != null && (!Number.isSafeInteger(replyToId) || replyToId <= 0)) replyToId = null;

  if (!isReportId(reportId)) return json({ error: 'invalid report id' }, 400);
  if (!body && !file) return json({ error: 'body or file is required' }, 400);
  if (body.length > 2000) return json({ error: 'body too long (max 2000 chars)' }, 400);

  /* Verify the report exists. */
  const [report] = await db()
    .select({ id: reports.id, reporterId: reports.reporterId, title: reports.title })
    .from(reports)
    .where(eq(reports.id, reportId));
  if (!report) return json({ error: 'report not found' }, 404);

  /* If replying, make sure the parent comment actually belongs to this report. */
  let parentAuthorId: string | null = null;
  if (replyToId != null) {
    const [parent] = await db()
      .select({ id: comments.id, userId: comments.userId })
      .from(comments)
      .where(and(eq(comments.id, replyToId), eq(comments.reportId, reportId)));
    if (!parent) replyToId = null;
    else parentAuthorId = parent.userId;
  }

  /* Insert comment + bump counter. */
  const d = db();
  const [inserted] = await d.batch([
    d
      .insert(comments)
      .values({ reportId, userId: user.id, body: body || '', replyToId })
      .returning({
        id: comments.id,
        body: comments.body,
        userId: comments.userId,
        createdAt: comments.createdAt,
        replyToId: comments.replyToId,
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
  const reportUrl = `${ctx.url.origin}/report/${reportId}`;
  const dmTasks: Promise<unknown>[] = [];
  const cf = ctx.locals.cfContext;
  const alreadyNotified = new Set<string>();

  if (report.reporterId !== user.id) {
    const notif = db()
      .insert(notifications)
      .values({
        userId: report.reporterId,
        reportId,
        kind: 'comment',
      });
    // In-app bell only — no DM here. A DM only goes out if the reporter is
    // actually @mentioned (handled below), so normal comments stay quiet.
    dmTasks.push(notif);
  }

  /* Notify whoever they replied to, if it's not themself. */
  if (replyToId != null && parentAuthorId && parentAuthorId !== user.id) {
    const notif = db()
      .insert(notifications)
      .values({
        userId: parentAuthorId,
        reportId,
        kind: 'comment',
      });
    const dmText = body
      ? `**${user.username}** replied to your comment on "${report.title}":\n> ${body.slice(0, 300)}\n${reportUrl}`
      : `**${user.username}** replied with an attachment to your comment on "${report.title}".\n${reportUrl}`;
    const dm = sendDiscordDm(parentAuthorId, dmText);
    dmTasks.push(notif, dm);
    alreadyNotified.add(parentAuthorId);
  }

  /* @mentions — notify + DM anyone tagged who isn't already being notified. */
  if (body) {
    const mentioned = await resolveMentions(body, user.id, alreadyNotified);
    for (const target of mentioned) {
      const notif = db()
        .insert(notifications)
        .values({
          userId: target.id,
          reportId,
          kind: 'mentioned',
          detail: `${user.username} mentioned you`,
        });
      const dmText = `**${user.username}** mentioned you in a comment on "${report.title}":\n> ${body.slice(0, 300)}\n${reportUrl}`;
      dmTasks.push(notif, sendDiscordDm(target.id, dmText));
      alreadyNotified.add(target.id);
    }
  }

  const logMsg = body ? body.slice(0, 200) : '(attachment only)';
  const log = logAction(
    user,
    replyToId != null ? 'comment.reply' : 'comment.add',
    `report #${reportId}`,
    logMsg,
    reportUrl,
  );
  dmTasks.push(log);

  if (cf) for (const task of dmTasks) cf.waitUntil(task);
  else await Promise.all(dmTasks);

  let replyToUsername: string | null = null;
  if (comment.replyToId != null) {
    const [parentUser] = await db()
      .select({ username: users.username })
      .from(comments)
      .innerJoin(users, eq(users.discordId, comments.userId))
      .where(eq(comments.id, comment.replyToId));
    replyToUsername = parentUser?.username ?? null;
  }

  return json({
    id: comment.id,
    body: comment.body,
    userId: comment.userId,
    username: user.username,
    avatarUrl: avatarUrl(user),
    createdAt: comment.createdAt,
    attachment,
    replyToId: comment.replyToId,
    replyToUsername,
  });
};

/* ── PUT — edit a comment ─────────────────────────────────────────────── */
export const PUT: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) return json({ error: 'sign-in' }, 401);

  const form = await ctx.request.formData();
  const commentId = Number(form.get('commentId'));
  const body = String(form.get('body') ?? '').trim();
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    return json({ error: 'invalid comment id' }, 400);
  }
  if (!body) return json({ error: 'body is required' }, 400);
  if (body.length > 2000) return json({ error: 'body too long (max 2000 chars)' }, 400);

  /* Load the comment to check ownership + get the report for mention DMs. */
  const [comment] = await db()
    .select({ id: comments.id, userId: comments.userId, reportId: comments.reportId })
    .from(comments)
    .where(eq(comments.id, commentId));
  if (!comment) return json({ error: 'comment not found' }, 404);

  /* Only the author can edit — staff use delete for moderation, not rewrites. */
  if (comment.userId !== user.id) return json({ error: 'forbidden' }, 403);

  const [report] = await db()
    .select({ id: reports.id, title: reports.title })
    .from(reports)
    .where(eq(reports.id, comment.reportId));

  const [updated] = await db()
    .update(comments)
    .set({ body, updatedAt: sql`(unixepoch())` })
    .where(eq(comments.id, commentId))
    .returning({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
    });

  /* @mentions added on edit still notify + DM (skip the author themself). */
  const dmTasks: Promise<unknown>[] = [];
  if (report) {
    const reportUrl = `${ctx.url.origin}/report/${comment.reportId}`;
    const mentioned = await resolveMentions(body, user.id);
    for (const target of mentioned) {
      dmTasks.push(
        db().insert(notifications).values({
          userId: target.id,
          reportId: comment.reportId,
          kind: 'mentioned',
          detail: `${user.username} mentioned you`,
        }),
        sendDiscordDm(
          target.id,
          `**${user.username}** mentioned you in an edited comment on "${report.title}":\n> ${body.slice(0, 300)}\n${reportUrl}`,
        ),
      );
    }
  }
  const log = logAction(user, 'comment.edit', `report #${comment.reportId}`, body.slice(0, 200), `${ctx.url.origin}/report/${comment.reportId}`);
  dmTasks.push(log);

  const cf = ctx.locals.cfContext;
  if (cf) for (const task of dmTasks) cf.waitUntil(task);
  else await Promise.all(dmTasks);

  return json({
    id: updated.id,
    body: updated.body,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
    edited: updated.updatedAt !== updated.createdAt,
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

  const log = logAction(
    user,
    'comment.delete',
    `report #${comment.reportId}`,
    isAuthor ? 'own comment' : 'by staff',
    `${ctx.url.origin}/report/${comment.reportId}`,
  );
  const cf = ctx.locals.cfContext;
  if (cf) cf.waitUntil(log);
  else await log;

  return new Response(null, { status: 204 });
};
