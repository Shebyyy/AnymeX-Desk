import type { APIRoute } from 'astro';
import { canWriteNow, currentUser } from '../lib/auth';
import { toggleVote } from '../lib/vote';
import { announceDemand } from '../lib/webhook';
import { safeReturnTo } from '../lib/redirect';
import { isReportId, isVotableReport } from '../lib/writes';
import { logAction } from '../lib/staff';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const form = await ctx.request.formData();
  const reportId = Number(form.get('report'));
  const back = safeReturnTo(ctx.request.headers.get('referer'), ctx.url.origin);

  if (!isReportId(reportId)) return ctx.redirect(back, 303);
  if (!(await isVotableReport(reportId))) return ctx.redirect(back, 303);

  const user = await currentUser(ctx);
  if (!user) {
    ctx.session?.set('pending_vote', reportId);
    return ctx.redirect(`/auth/discord?next=${encodeURIComponent(back)}`, 302);
  }
  if (!(await canWriteNow(user))) return ctx.redirect('/cant-post', 302);

  const result = await toggleVote(reportId, user.id);
  const cf = ctx.locals.cfContext;
  const log = logAction(user, result === 'added' ? 'vote.add' : 'vote.remove', String(reportId));
  if (result === 'added') {
    const announce = announceDemand(reportId, ctx.url.origin);
    if (cf) { cf.waitUntil(log); cf.waitUntil(announce); }
    else { await log; await announce; }
  } else {
    if (cf) cf.waitUntil(log);
    else await log;
  }
  return ctx.redirect(back, 303);
};
