import type { APIRoute } from 'astro';
import { and, count, eq, sql } from 'drizzle-orm';
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

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

  if (!isReportId(reportId)) return json({ error: 'invalid report id' }, 400);
  if (!file) return json({ error: 'no file' }, 400);

  /* ── Validate MIME type ────────────────────────────────────────────── */
  const mime = file.type;
  let fileType: 'image' | 'video';
  let maxSize: number;
  let maxCount: number;

  if (IMAGE_MIMES.has(mime)) {
    fileType = 'image';
    maxSize = MAX_IMAGE_SIZE;
    maxCount = MAX_IMAGES;
  } else if (VIDEO_MIMES.has(mime)) {
    fileType = 'video';
    maxSize = MAX_VIDEO_SIZE;
    maxCount = MAX_VIDEOS;
  } else {
    return json({ error: 'unsupported file type' }, 400);
  }

  /* ── Validate file size ────────────────────────────────────────────── */
  if (file.size > maxSize) {
    const label = fileType === 'image' ? '5 MB' : '50 MB';
    return json({ error: `file too large (max ${label})` }, 400);
  }

  /* ── Check attachment count limit ──────────────────────────────────── */
  const [existing] = await db()
    .select({ n: count() })
    .from(attachments)
    .where(and(eq(attachments.reportId, reportId), eq(attachments.fileType, fileType)));

  if ((existing?.n ?? 0) >= maxCount) {
    const label = fileType === 'image' ? 'images' : 'videos';
    return json({ error: `max ${maxCount} ${label} per report` }, 400);
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

  // Read file into ArrayBuffer and store in KV with metadata.
  const arrayBuffer = await file.arrayBuffer();
  const kv = (ctx.locals.runtime as any).env?.SESSION as KVNamespace | undefined;
  if (kv) {
    await kv.put(kvKey, arrayBuffer, {
      metadata: { mimeType: mime, fileName: file.name },
      expirationTtl: 60 * 60 * 24 * 365, // 1 year TTL
    });
  }

  /* ── Save metadata to D1 ──────────────────────────────────────────── */
  const d = db();
  const [inserted] = await d.batch([
    d
      .insert(attachments)
      .values({
        reportId,
        fileName: file.name,
        filePath,
        fileType,
        mimeType: mime,
        fileSize: file.size,
      })
      .returning({
        id: attachments.id,
        filePath: attachments.filePath,
        fileType: attachments.fileType,
        fileName: attachments.fileName,
        fileSize: attachments.fileSize,
      }),
    d
      .update(reports)
      .set({ attachmentCount: sql`${reports.attachmentCount} + 1` })
      .where(eq(reports.id, reportId)),
  ]);

  return json(inserted[0]);
};
