import { api } from 'sdk';
import { searchMedia } from '../lib/anilist.js';
import { formatMediaCard } from '../lib/formatters.js';
import { mediaCardKeyboard } from '../lib/keyboards.js';

export default async function (inlineQuery) {
  try {
    const query = (inlineQuery?.query || '').trim();
    if (!query || query.length < 2) {
      await api.answerInlineQuery({
        inline_query_id: inlineQuery.id,
        results: [],
        switch_pm_text: 'Type anime, manga, or novel title to search',
        switch_pm_parameter: 'search',
        cache_time: 10,
      });
      return;
    }

    // Search AniList
    const result = await searchMedia({ query, perPage: 10 });
    const mediaList = result.media || [];

    const results = mediaList.map((media) => {
      const title = media.title?.english || media.title?.romaji || 'Unknown';
      const desc = `${media.format || ''} • ⭐ ${media.averageScore || 'N/A'}% • ${media.status || ''}`;

      return {
        type: 'article',
        id: `media_${media.id}`,
        title,
        description: desc,
        thumbnail_url: media.coverImage?.large || media.coverImage?.extraLarge,
        input_message_content: {
          message_text: formatMediaCard(media),
          parse_mode: 'HTML',
        },
        reply_markup: mediaCardKeyboard(media),
      };
    });

    await api.answerInlineQuery({
      inline_query_id: inlineQuery.id,
      results,
      cache_time: 60,
      is_personal: false,
    });
  } catch (err) {
    console.error('handlers/inline_query error:', err);
  }
}
