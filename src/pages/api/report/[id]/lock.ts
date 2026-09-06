import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../../lib/db/client';
import { reports } from '../../../../lib/db/schema';
import { logAction, requireStaff } from '../../../../lib/staff';
import { isReportId } from '../../../../lib/writes';
import { syncForumThreadLock } from '../../../../lib/discord-forums';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * POST /api/report/[id]/lock
 *
 * Staff-only (mod+). Toggles the `locked` flag on a report.
 * When locked, all member actions (comments, reactions, edits, attachments,
 * voting) are frozen. Staff retain full moderation powers.
 *
 * Body (JSON or form): { locked: true | false, reason?: string }
 * Returns: { id, locked, lockedReason }
 */
export const POST: APIRoute = async (ctx) => {
  const gate = await requireStaff(ctx, 'mod');
  if (gate instanceof Response) return gate;
  const user = gate.user;

  const id = Number(ctx.params.id);
  if (!isReportId(id)) return json({ error: 'invalid report id' }, 400);

  // Parse the requested locked state and optional reason from JSON or form.
  let wantLocked: boolean | null = null;
  let rawReason: string | null = null;
  const ct = ctx.request.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const body = (await ctx.request.json()) as { locked?: unknown; reason?: unknown };
    wantLocked = body.locked === true || body.locked === 'true';
    if (typeof body.reason === 'string') rawReason = body.reason.trim();
  } else {
    const form = await ctx.request.formData();
    const v = String(form.get('locked') ?? '');
    if (v === 'true' || v === '1' || v === 'on') wantLocked = true;
    else if (v === 'false' || v === '0' || v === '') wantLocked = false;
    const r = form.get('reason');
    if (typeof r === 'string') rawReason = r.trim();
  }
  if (wantLocked === null) return json({ error: 'locked (boolean) required' }, 400);

  const reason = rawReason ? rawReason.slice(0, 500) : null;

  const [updated] = await db()
    .update(reports)
    .set({
      locked: wantLocked,
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(reports.id, id))
    .returning({
      id: reports.id,
      title: reports.title,
      status: reports.status,
      locked: reports.locked,
      discordThreadId: reports.discordThreadId,
    });

  if (!updated) return json({ error: 'report not found' }, 404);

  // Audit log.
  const auditDetail = wantLocked
    ? (reason ? `locked: ${reason}` : 'locked')
    : 'unlocked';
  const log = logAction(
    user,
    wantLocked ? 'report.lock' : 'report.unlock',
    `report #${id}`,
    auditDetail,
    `${ctx.url.origin}/report/${id}`,
  );

  const tasks: Promise<unknown>[] = [log];

  // Sync with Discord thread if attached
  if (updated.discordThreadId) {
    const isClosed = ['fixed', 'wont_fix', 'duplicate'].includes(updated.status);
    const shouldArchive = wantLocked && isClosed;
    tasks.push(
      syncForumThreadLock(
        updated.discordThreadId,
        wantLocked,
        updated.title,
        user.username,
        reason || undefined,
        shouldArchive,
      ),
    );
  }

  const cf = (ctx.locals as any)?.cfContext;
  if (cf?.waitUntil) for (const t of tasks) cf.waitUntil(t);
  else await Promise.all(tasks);

  return json({
    id: updated.id,
    locked: updated.locked,
  });
};
