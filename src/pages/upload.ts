import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { canWriteNow, currentUser } from '../lib/auth';
import { db } from '../lib/db/client';
import {
  attachments,
  IMAGE_MIMES,
  MAX_ATTACHMENTS_PER_REPORT,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  MAX_VIDEO_SIZE,
  reports,
  VIDEO_MIMES,
} from '../lib/db/schema';
import { isReportId } from '../lib/writes';
import { syncAttachmentToDiscord } from '../lib/discord-forums';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Classify a file and pick its size limit.
 *
 * Any file type is accepted for both report-level and comment attachments —
 * the `fileType` tag only decides how the gallery renders it (inline image,
 * inline video, or a download link). A PDF or a .zip lands as `file`, a .png
 * lands as `image`, a .mp4 lands as `video`, and all of them insert a row.
 */
function classify(mime: string) {
  if (IMAGE_MIMES.has(mime)) return { fileType: 'image' as const, maxSize: MAX_IMAGE_SIZE };
  if (VIDEO_MIMES.has(mime)) return { fileType: 'video' as const, maxSize: MAX_VIDEO_SIZE };
  return { fileType: 'file' as const, maxSize: MAX_FILE_SIZE };
}

/**
 * Some browsers (and some drag-and-drop paths) hand us an empty or generic
 * `application/octet-stream` MIME even for a plain `.png` / `.mp4`. Fall back
 * to the filename extension so legitimate uploads aren't silently rejected.
 */
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  apng: 'image/png',
  mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4',
};

function resolveMime(file: File): string {
  const declared = file.type?.trim();
  if (declared && declared !== 'application/octet-stream') return declared;
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  return EXT_MIME[ext] ?? declared ?? 'application/octet-stream';
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

  /* ── Validate size ─────────────────────────────────────────────────── */
 const mime = resolveMime(file);
  const { fileType, maxSize } = classify(mime);
  if (file.size > maxSize) {
    const label =
      fileType === 'image' ? '5 MB' :
      fileType === 'video' ? '50 MB' :
      `${Math.round(MAX_FILE_SIZE / (1024 * 1024))} MB`;
    return json({ error: `file too large (max ${label})` }, 400);
  }

  /* ── Check attachment count limit (report-level only) ─────────────── */
  if (!isCommentAttachment) {
    const [existing] = await db()
      .select({ n: count() })
      .from(attachments)
      .where(and(
        eq(attachments.reportId, reportId),
        isNull(attachments.commentId),
      ));
    if ((existing?.n ?? 0) >= MAX_ATTACHMENTS_PER_REPORT) {
      return json({ error: `max ${MAX_ATTACHMENTS_PER_REPORT} attachments per report` }, 400);
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
    undefined,
    arrayBuffer,
    file.type,
  );
  // Use 'Astro.locals.cfContext' — the adapter's old 'Astro.locals.runtime.ctx'
  // getter throws ("has been removed in Astro v6"), which used to crash every
  // upload on this line. cfContext is what every other route in this repo uses.
  const cf = (ctx.locals as any)?.cfContext;
  if (cf?.waitUntil) {
    cf.waitUntil(syncTask);
  } else {
    syncTask.catch(() => {});
  }

  return json(inserted[0]);
};
