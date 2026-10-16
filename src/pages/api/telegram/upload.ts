import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { attachments, reports, IMAGE_MIMES, VIDEO_MIMES } from '../../../lib/db/schema';
import { readConfig } from '../../../lib/settings';
import { syncAttachmentToDiscord } from '../../../lib/discord-forums';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

function validateSecret(req: Request, secret: string): boolean {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  return token === secret;
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/**
 * POST /api/telegram/upload
 * Securely uploads an attachment from Telegram bot to AnymeX Desk KV and syncs to Discord forum.
 */
export const POST: APIRoute = async (ctx) => {
  try {
    const cfg = await readConfig();
    if (cfg.discord_sync_secret) {
      if (!validateSecret(ctx.request, cfg.discord_sync_secret)) {
        return json({ error: 'unauthorized' }, 401);
      }
    }

    const form = await ctx.request.formData();
    const file = form.get('file') as File | null;
    const reportId = Number(form.get('reportId'));
    const reporterName = String(form.get('reporterName') || 'Telegram User');
    const declaredType = String(form.get('fileType') || 'image');

    if (!reportId || isNaN(reportId)) {
      return json({ error: 'invalid reportId' }, 400);
    }
    if (!file) {
      return json({ error: 'no file provided' }, 400);
    }

    const d = db();
    const [report] = await d.select().from(reports).where(eq(reports.id, reportId));
    if (!report) {
      return json({ error: 'report not found' }, 404);
    }

    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const mime = file.type || EXT_MIME[ext] || 'application/octet-stream';
    let fileType: 'image' | 'video' | 'file' = 'file';
    if (IMAGE_MIMES.has(mime) || declaredType === 'image') {
      fileType = 'image';
    } else if (VIDEO_MIMES.has(mime) || declaredType === 'video') {
      fileType = 'video';
    } else {
      fileType = 'file';
    }

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

    // Save attachment row to D1
    const [inserted] = await d
      .insert(attachments)
      .values({
        reportId,
        commentId: null,
        fileName: file.name,
        filePath,
        fileType,
        mimeType: mime,
        fileSize: file.size,
      })
      .returning();

    // Bump attachment count on report
    await d
      .update(reports)
      .set({ attachmentCount: sql`${reports.attachmentCount} + 1` })
      .where(eq(reports.id, reportId));

    // Sync attachment to Discord forum thread
    const syncTask = syncAttachmentToDiscord(
      reportId,
      filePath,
      file.name,
      fileType,
      ctx.url.origin,
      reporterName,
      undefined,
      arrayBuffer,
      mime,
    );

    const cf = (ctx.locals as any)?.cfContext;
    if (cf?.waitUntil) {
      cf.waitUntil(syncTask);
    } else {
      syncTask.catch(() => {});
    }

    return json({
      ok: true,
      attachmentId: inserted.id,
      filePath,
      fileType,
    });
  } catch (err: any) {
    console.error('api/telegram/upload error:', err);
    return json({ error: err?.message || 'Internal Server Error' }, 500);
  }
};
