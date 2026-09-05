import type { APIRoute } from 'astro';
import { and, asc, eq, gt } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { reports, comments, users, attachments } from '../../../lib/db/schema';
import { statusLabel } from '../../../lib/format';
import { resolveDiscordAvatarUrl } from '../../../lib/discord-forums';
import { prepareCommentBody } from '../../../lib/richtext';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  });
}

export const GET: APIRoute = async (ctx) => {
  const reportId = Number(ctx.url.searchParams.get('reportId'));
  const after = Number(ctx.url.searchParams.get('after') || 0);

  if (!reportId || isNaN(reportId)) {
    return json({ error: 'invalid report id' }, 400);
  }

  const d = db();
  const [report] = await d
    .select({
      id: reports.id,
      status: reports.status,
      kind: reports.kind,
      commentCount: reports.commentCount,
      locked: reports.locked,
    })
    .from(reports)
    .where(eq(reports.id, reportId));

  if (!report) {
    return json({ error: 'not found' }, 404);
  }

  // Fetch comments created after `after`
  const newComments = await d
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      userId: comments.userId,
      username: users.username,
      avatarHash: users.avatarHash,
      replyToId: comments.replyToId,
    })
    .from(comments)
    .innerJoin(users, eq(users.discordId, comments.userId))
    .where(and(eq(comments.reportId, reportId), gt(comments.id, after)))
    .orderBy(asc(comments.createdAt));

  // If there are new comments, fetch attachments for this report
  let attList: any[] = [];
  if (newComments.length > 0) {
    attList = await d
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
  }

  const payloadComments = newComments.map((c) => {
    const cAtts = attList
      .filter((a) => a.commentId === c.id)
      .map((a) => ({
        id: a.id,
        fileName: a.fileName,
        fileType: a.fileType,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        url: a.filePath.startsWith('http') ? a.filePath : '/' + a.filePath,
      }));

    return {
      id: c.id,
      body: c.body,
      // Pre-rendered markdown HTML so the live-update client can insert it
      // directly. Without this, the client dumped the raw body as text and
      // newly-posted comments showed unparsed markdown until a page reload.
      // Uses the same prepareCommentBody() as the SSR path, so the rendering
      // matches exactly.
      bodyHtml: c.body ? prepareCommentBody(c.body).html : '',
      createdAt: c.createdAt,
      userId: c.userId,
      username: c.username,
      avatarUrl: resolveDiscordAvatarUrl({ discordId: c.userId, avatarHash: c.avatarHash }, 64),
      replyToId: c.replyToId,
      attachments: cAtts,
    };
  });

  const allCommentRows = await d
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.reportId, reportId));

  return json({
    status: report.status,
    statusLabel: statusLabel(report.status, report.kind),
    commentCount: report.commentCount,
    locked: report.locked,
    allCommentIds: allCommentRows.map((r) => r.id),
    newComments: payloadComments,
  });
};