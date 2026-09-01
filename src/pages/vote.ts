import type { APIRoute } from 'astro';
import { canWriteNow, currentUser } from '../lib/auth';
import { toggleVote } from '../lib/vote';
import { announceDemand } from '../lib/webhook';
import { safeReturnTo } from '../lib/redirect';
import { isReportId, isVotableReport } from '../lib/writes';

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
  if (result === 'added') {
    const announce = announceDemand(reportId, ctx.url.origin);
    const cf = ctx.locals.cfContext;
    if (cf) cf.waitUntil(announce);
    else await announce;
  }
  return ctx.redirect(back, 303);
};
