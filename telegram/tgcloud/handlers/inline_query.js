import { api } from 'sdk';
import { searchSimilar, getReports } from '../lib/desk_api.js';
import { formatReportCard } from '../lib/formatters.js';
import { reportCardKeyboard } from '../lib/keyboards.js';
import { STATUS_EMOJIS, KIND_LABELS } from '../lib/constants.js';

export default async function (inlineQuery) {
  try {
    const query = (inlineQuery.query || '').trim();
    const queryId = inlineQuery.id;

    let reports = [];

    if (query.length >= 2) {
      reports = await searchSimilar(query);
    } else {
      // Show top trending reports if no query is typed
      const res = await getReports({ state: 'open', page: 1 });
      reports = (res.data || []).slice(0, 8);
    }

    const results = reports.map((r) => {
      const emoji = STATUS_EMOJIS[r.status] || '⚪';
      const kind = KIND_LABELS[r.kind] || r.kind;
      const titleText = `${emoji} #${r.id} ${r.title}`;
      const descText = `${kind} • ▲ ${r.votes || 0} votes • ${r.status}`;

      return {
        type: 'article',
        id: String(r.id),
        title: titleText,
        description: descText,
        input_message_content: {
          message_text: formatReportCard(r),
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        },
        reply_markup: reportCardKeyboard(r.id, r.votes || 0, false),
      };
    });

    await api.answerInlineQuery({
      inline_query_id: queryId,
      results,
      cache_time: 15,
      is_personal: false,
    });
  } catch (err) {
    console.error('handlers/inline_query error:', err);
    try {
      await api.answerInlineQuery({
        inline_query_id: inlineQuery.id,
        results: [],
        cache_time: 5,
      });
    } catch {}
  }
}
