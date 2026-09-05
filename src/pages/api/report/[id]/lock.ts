import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../../lib/db/client';
import { reports } from '../../../../lib/db/schema';
import { logAction, requireStaff } from '../../../../lib/staff';
import { isReportId } from '../../../../lib/writes';

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
 * Staff-only (mod+). Toggles the manual `locked` flag on a report, on any
 * status. Independent of status — locking an open report freezes the
 * conversation but keeps voting open (voting is status-gated).
 *
 * Body (JSON or form): { locked: true | false }
 * Returns: { id, locked }
 */
export const POST: APIRoute = async (ctx) => {
  // requireStaff returns a Response (redirect/404) if the user isn't mod+,
  // or a StaffContext with the user if they are.
  const gate = await requireStaff(ctx, 'mod');
  if (gate instanceof Response) return gate;
  const user = gate.user;

  const id = Number(ctx.params.id);
  if (!isReportId(id)) return json({ error: 'invalid report id' }, 400);

  // Parse the requested locked state from JSON or form.
  let wantLocked: boolean | null = null;
  const ct = ctx.request.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const body = (await ctx.request.json()) as { locked?: unknown };
    wantLocked = body.locked === true || body.locked === 'true';
  } else {
    const form = await ctx.request.formData();
    const v = String(form.get('locked') ?? '');
    if (v === 'true' || v === '1' || v === 'on') wantLocked = true;
    else if (v === 'false' || v === '0' || v === '') wantLocked = false;
  }
  if (wantLocked === null) return json({ error: 'locked (boolean) required' }, 400);

  const [updated] = await db()
    .update(reports)
    .set({ locked: wantLocked, updatedAt: sql`(unixepoch())` })
    .where(eq(reports.id, id))
    .returning({ id: reports.id, locked: reports.locked });

  if (!updated) return json({ error: 'report not found' }, 404);

  // Audit log.
  const log = logAction(
    user,
    wantLocked ? 'report.lock' : 'report.unlock',
    `report #${id}`,
    wantLocked ? 'locked' : 'unlocked',
    `${ctx.url.origin}/report/${id}`,
  );
  const cf = (ctx.locals as any)?.cfContext;
  if (cf?.waitUntil) cf.waitUntil(log);
  else await log;

  return json({ id: updated.id, locked: updated.locked });
};
