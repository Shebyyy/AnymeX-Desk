import { sql } from 'drizzle-orm';
import type { APIRoute } from 'astro';
import { isResponse, requireStaff } from '../../lib/staff';
import { db } from '../../lib/db/client';
import { attachments, reports } from '../../lib/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { logAction } from '../../lib/staff';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/*
 * Pin a comment's attachment to the report's main gallery.
 * Sets commentId = NULL and increments the report's attachmentCount.
 */
export const PUT: APIRoute = async (ctx) => {
  const gate = await requireStaff(ctx, 'mod');
  if (isResponse(gate)) return gate;

  const form = await ctx.request.formData();
  const attachmentId = Number(form.get('attachmentId'));
  const reportId = Number(form.get('reportId'));

  if (!Number.isSafeInteger(attachmentId) || attachmentId <= 0) {
    return json({ error: 'invalid attachment id' }, 400);
  }
  if (!Number.isSafeInteger(reportId) || reportId <= 0) {
    return json({ error: 'invalid report id' }, 400);
  }

  // Move attachment from comment to report-level.
  const [updated] = await db()
    .update(attachments)
    .set({ commentId: null, sortOrder: 0 })
    .where(eq(attachments.id, attachmentId))
    .returning({ id: attachments.id, fileName: attachments.fileName });

  if (!updated) return json({ error: 'attachment not found' }, 404);

  // Increment report attachment count.
  await db()
    .update(reports)
    .set({ attachmentCount: sql`${reports.attachmentCount} + 1` })
    .where(eq(reports.id, reportId));

  await logAction(gate.user, 'attachment.pin', String(attachmentId), `pinned ${updated.fileName} to report #${reportId}`);

  return json({ pinned: true });
};
