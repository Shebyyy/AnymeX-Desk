/**
 * Turns a raw comment body into safe HTML: escape first, then linkify URLs,
 * inlining direct image/gif/video links as actual media instead of plain
 * text. Anything else stays a clickable link and gets queued up for an
 * Open Graph preview card (see link-preview.ts) rendered separately below
 * the comment.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?\S*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(\?\S*)?$/i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RichBody {
  /** Safe HTML — text is escaped, only our own linkify/media tags are raw. */
  html: string;
  /** Non-media URLs found in the body, in order, de-duplicated — candidates for an OG preview card. */
  previewUrls: string[];
}

export function prepareCommentBody(body: string): RichBody {
  const previewUrls: string[] = [];
  const seen = new Set<string>();
  let html = '';
  let lastIndex = 0;

  for (const m of body.matchAll(URL_RE)) {
    let url = m[0];
    const start = m.index ?? 0;

    // Trailing punctuation is almost never part of the URL ("check this out.").
    const trailingPunct = url.match(/[.,;:!?)]+$/)?.[0] ?? '';
    if (trailingPunct) url = url.slice(0, -trailingPunct.length);

    html += escapeHtml(body.slice(lastIndex, start));

    if (IMAGE_EXT_RE.test(url)) {
      html +=
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">` +
        `<img src="${escapeHtml(url)}" alt="" loading="lazy" class="comment-inline-media" />` +
        `</a>`;
    } else if (VIDEO_EXT_RE.test(url)) {
      html += `<video src="${escapeHtml(url)}" controls preload="metadata" class="comment-inline-media"></video>`;
    } else {
      html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow" class="comment-link">${escapeHtml(url)}</a>`;
      if (!seen.has(url)) {
        seen.add(url);
        previewUrls.push(url);
      }
    }

    html += escapeHtml(trailingPunct);
    lastIndex = start + m[0].length;
  }

  html += escapeHtml(body.slice(lastIndex));
  return { html, previewUrls };
}
