import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { canWriteNow, currentUser } from '../lib/auth';
import { db } from '../lib/db/client';
import {
  attachments,
  IMAGE_MIMES,
  MAX_IMAGE_SIZE,
  MAX_IMAGES,
  MAX_VIDEO_SIZE,
  MAX_VIDEOS,
  reports,
  VIDEO_MIMES,
} from '../lib/db/schema';
import { isReportId } from '../lib/writes';
import { syncAttachmentToDiscord } from '../lib/discord-forums';

export const prerender = false;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB for other files

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Classify file type and get limits. For comment attachments, allows any file. */
function classify(mime: string, isCommentAttachment: boolean) {
  if (IMAGE_MIMES.has(mime)) return { fileType: 'image' as const, maxSize: MAX_IMAGE_SIZE };
  if (VIDEO_MIMES.has(mime)) return { fileType: 'video' as const, maxSize: MAX_VIDEO_SIZE };
  if (isCommentAttachment) return { fileType: 'file' as const, maxSize: MAX_FILE_SIZE };
  return null; // reject unknown types for report-level uploads
}

export const POST: APIRoute = async (ctx) => {
  /* ── Auth gate ─────────────────────────────────────────────────────── */
  const user = await currentUser(ctx);
  if (!user) return json({ error: 'sign-in' }, 401);
  if (!(await canWriteNow(user))) return json({ error: 'banned' }, 403);

  /* ── Parse multipart form ──────────────────────────────────────────── */
  const form = await ctx.request.formData();
  const file = form.get('file') as File | null;
  const reportId = Number(form.get('reportId'));
  const commentId = form.get('commentId') ? Number(form.get('commentId')) : null;
  const isCommentAttachment = !!commentId;

  if (!isReportId(reportId)) return json({ error: 'invalid report id' }, 400);
  if (!file) return json({ error: 'no file' }, 400);

  /* ── Validate MIME type & size ────────────────────────────────────── */
 const mime = file.type || 'application/octet-stream';
  const classified = classify(mime, isCommentAttachment);
  if (!classified) return json({ error: 'unsupported file type' }, 400);

  const { fileType, maxSize } = classified;
  if (file.size > maxSize) {
    const label = fileType === 'image' ? '5 MB' : fileType === 'video' ? '50 MB' : '10 MB';
    return json({ error: `file too large (max ${label})` }, 400);
  }

  /* ── Check attachment count limit (report-level only) ─────────────── */
  if (!isCommentAttachment) {
    const maxCount = fileType === 'image' ? MAX_IMAGES : MAX_VIDEOS;
    const [existing] = await db()
      .select({ n: count() })
      .from(attachments)
      .where(and(
        eq(attachments.reportId, reportId),
        eq(attachments.fileType, fileType),
        isNull(attachments.commentId),
      ));
    if ((existing?.n ?? 0) >= maxCount) {
      const label = fileType === 'image' ? 'images' : 'videos';
      return json({ error: `max ${maxCount} ${label} per report` }, 400);
    }
  }

  /* ── Verify report exists ──────────────────────────────────────────── */
  const [report] = await db()
    .select({ id: reports.id })
    .from(reports)
    .where(eq(reports.id, reportId));
  if (!report) return json({ error: 'report not found' }, 404);

  /* ── Generate path & store file in KV ──────────────────────────────── */
  const uuid = crypto.randomUUID();
  const filePath = `uploads/${uuid}/${file.name}`;
  const kvKey = `upload:${filePath}`;

  const arrayBuffer = await file.arrayBuffer();
  const kv = env.SESSION as KVNamespace | undefined;
  if (kv) {
    await kv.put(kvKey, arrayBuffer, {
      metadata: { mimeType: mime, fileName: file.name },
      expirationTtl: 60 * 60 * 24 * 365,
    });
  }

  /* ── Save metadata to D1 ──────────────────────────────────────────── */
  const values: Record<string, unknown> = {
    reportId,
    commentId: commentId ?? null,
    fileName: file.name,
    filePath,
    fileType,
    mimeType: mime,
    fileSize: file.size,
  };

  const d = db();
  const batchOps = [
    d.insert(attachments).values(values).returning({
      id: attachments.id,
      filePath: attachments.filePath,
      fileType: attachments.fileType,
      fileName: attachments.fileName,
      fileSize: attachments.fileSize,
      mimeType: attachments.mimeType,
    }),
  ];

  // Only bump report attachment count for report-level uploads.
  if (!isCommentAttachment) {
    batchOps.push(
      d.update(reports)
        .set({ attachmentCount: sql`${reports.attachmentCount} + 1` })
        .where(eq(reports.id, reportId)),
    );
  }

  const [inserted] = await d.batch(batchOps);

  // Sync attachment to Discord forum thread if present (async / non-blocking)
  const syncTask = syncAttachmentToDiscord(
    reportId,
    filePath,
    file.name,
    fileType,
    ctx.url.origin,
    user.username,
  );
  const cf = (ctx.locals as any)?.runtime?.ctx;
  if (cf?.waitUntil) {
    cf.waitUntil(syncTask);
  } else {
    syncTask.catch(() => {});
  }

  return json(inserted[0]);
};
