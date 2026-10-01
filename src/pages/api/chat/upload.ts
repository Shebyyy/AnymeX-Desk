import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { currentUser } from '../../../lib/auth';

export const prerender = false;

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4',
  pdf: 'application/pdf', zip: 'application/zip',
};

export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: Sign in to upload media' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await ctx.request.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string' || !(file instanceof File)) {
      return new Response(JSON.stringify({ ok: false, error: 'No file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const MAX_CHAT_FILE_SIZE = 25 * 1024 * 1024; // 25 MB max
    if (file.size > MAX_CHAT_FILE_SIZE) {
      return new Response(JSON.stringify({ ok: false, error: 'File too large (max 25MB)' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const declared = file.type?.trim();
    const mime = (declared && declared !== 'application/octet-stream') ? declared : (EXT_MIME[ext] ?? 'application/octet-stream');

    const isImage = mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext);
    const isVideo = mime.startsWith('video/') || ['mp4', 'webm', 'm4v'].includes(ext);
    const fileType = isImage ? 'image' : isVideo ? 'video' : 'file';

    const uuid = crypto.randomUUID();
    const cleanFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = `uploads/chat-${uuid}/${cleanFileName}`;
    const kvKey = `upload:${filePath}`;

    const kv = (env as any).SESSION as KVNamespace | undefined;
    if (kv) {
      const buffer = await file.arrayBuffer();
      await kv.put(kvKey, buffer, {
        metadata: { mimeType: mime, fileName: file.name, userId: user.id },
      });
    }

    const publicUrl = `/uploads/chat-${uuid}/${cleanFileName}`;

    return new Response(
      JSON.stringify({
        ok: true,
        url: publicUrl,
        name: file.name,
        fileType,
        size: file.size,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[chat:upload] Upload failed:', err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Upload failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
