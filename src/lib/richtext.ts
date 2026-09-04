/**
 * Complete Discord Markdown Parser & Rich Text Formatter.
 *
 * Fully supports Discord's rich markdown syntax:
 * - Bold (**text**), Italics (*text* or _text_), Underline (__text__), Strikethrough (~~text~~)
 * - Combinations: Underline Bold Italics (__***text***__), Bold Italics (***text***, **_text_**, _**text**_)
 * - Underline Bold (__**text**__), Underline Italics (__*text*__, ___text___), Strikethrough Bold (~~**text**~~)
 * - Fenced code blocks (```lang ... ```) & inline code (`code`)
 * - Blockquotes: Single-line (> quote) and Multi-line (>>> quote)
 * - Headers: # H1, ## H2, ### H3
 * - Subtext: -# small subtext
 * - Lists: Unordered (- or *) and Ordered (1.) with 2-space indentation
 * - Spoilers: ||spoiler text|| (click-to-reveal)
 * - Masked links [label](url) & automatic raw URL linking (with image/video inlining)
 * - Discord Timestamps: <t:1756886400:R>, <t:1756886400:f>, <t:1756886400:D>, etc.
 * - Discord Custom Emojis: <:name:id> and animated <a:name:id>
 * - Discord Mentions: <@id>, <#id>, <@&id>
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?\S*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(\?\S*)?$/i;

// A masked link `[label](url)` or a bare URL
const LINKISH_RE = /\[([^[\]\n]+)]\((https?:\/\/[^\s()]+)\)|(\bhttps?:\/\/[^\s<>"')\]]+)/gi;

// Discord custom emojis: <:name:id> or <a:name:id>
const DISCORD_EMOJI_RE = /<(a)?:([a-zA-Z0-9_]{2,32}):(\d{17,21})>/g;

// Discord timestamps: <t:1756886400> or <t:1756886400:R>
const DISCORD_TIMESTAMP_RE = /<t:(\d{9,12})(?::([tTdDfFR]))?>/g;

// Discord snowflake mentions: <@id>, <@!id>, <#id>, <@&id>
const DISCORD_MENTION_RE = /<(@!?|#|@&)(\d{17,21})>/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RichBody {
  /** Safe HTML — all text is escaped, only validated markdown tags are raw. */
  html: string;
  /** Non-media URLs found in the body, in order, de-duplicated — candidates for link preview cards. */
  previewUrls: string[];
}

interface ListLine {
  ordered: boolean;
  indent: number;
  content: string;
}

/**
 * Format a unix epoch timestamp (seconds) into Discord timestamp format styles.
 */
function formatDiscordTimestamp(timestampSec: number, style = 'f'): { text: string; full: string } {
  const date = new Date(timestampSec * 1000);
  if (isNaN(date.getTime())) {
    return { text: `<t:${timestampSec}:${style}>`, full: '' };
  }

  const full = date.toLocaleString('en-US', {
    dateStyle: 'full',
    timeStyle: 'medium',
  });

  if (style === 'R') {
    const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
    const abs = Math.abs(diffSec);
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    if (abs < 60) return { text: rtf.format(diffSec, 'second'), full };
    if (abs < 3600) return { text: rtf.format(Math.round(diffSec / 60), 'minute'), full };
    if (abs < 86400) return { text: rtf.format(Math.round(diffSec / 3600), 'hour'), full };
    if (abs < 2592000) return { text: rtf.format(Math.round(diffSec / 86400), 'day'), full };
    if (abs < 31536000) return { text: rtf.format(Math.round(diffSec / 2592000), 'month'), full };
    return { text: rtf.format(Math.round(diffSec / 31536000), 'year'), full };
  }

  const optionsMap: Record<string, Intl.DateTimeFormatOptions> = {
    t: { hour: 'numeric', minute: 'numeric' },
    T: { hour: 'numeric', minute: 'numeric', second: 'numeric' },
    d: { month: '2-digit', day: '2-digit', year: 'numeric' },
    D: { month: 'long', day: 'numeric', year: 'numeric' },
    f: { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric' },
    F: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric' },
  };

  try {
    const text = new Intl.DateTimeFormat('en-US', optionsMap[style] || optionsMap.f).format(date);
    return { text, full };
  } catch {
    return { text: date.toLocaleString(), full };
  }
}

export function prepareCommentBody(body: string): RichBody {
  const previewUrls: string[] = [];
  const seenPreview = new Set<string>();

  // Normalize CRLF / lone CR to LF. Without this, block-level regexes that use
  // ^ and $ anchors (headers, quotes, subtext, lists) silently fail when the
  // body comes from a browser textarea that submitted with \r\n line endings
  // — every block element would be mis-rendered as a single paragraph.
  body = body.replace(/\r\n?/g, '\n');

  // Stashed raw HTML tokens
  const store: string[] = [];
  const stash = (html: string): string => {
    store.push(html);
    return `\u0000${store.length - 1}\u0000`;
  };

  // 1. Fenced Code Blocks (```lang\n...```) — protected first.
  //
  // Require a newline after the opening fence (or end-of-string). Without that,
  // `` ` ```code``` ` `` (triple backticks with NO newline) was matching as a
  // fenced block with the first word as the "language" and an empty body — so
  // "```code```" rendered as an empty <pre class="language-code"> instead of
  // inline code like Discord does. The `\n` (or `$`) anchor is what makes a
  // fence a fence.
  let working = body.replace(/```([a-zA-Z0-9_-]+)?(?:\n|$)([\s\S]*?)```/g, (_m, lang: string | undefined, code: string) => {
    const cls = lang ? ` class="language-${escapeHtml(lang.toLowerCase())}"` : '';
    const trimmed = code.replace(/\n$/, '');
    return stash(`<pre class="md-codeblock"><code${cls}>${escapeHtml(trimmed)}</code></pre>`);
  });

  // 2. Inline code spans (`code`).
  //
  // Also handle triple-backtick "inline" usage like `` ```code``` `` — Discord
  // renders that as inline code containing the word with the backticks stripped.
  // Now that fenced blocks require a newline (above), `` ```code``` `` falls
  // through to here. Match 1-3 backticks wrapping non-backtick content.
  working = working.replace(/`{1,3}([^`\n]+?)`{1,3}/g, (_m, code: string) => stash(`<code class="md-code">${escapeHtml(code)}</code>`));

  // 3. Discord Custom Emojis (<:name:id> or <a:name:id>)
  working = working.replace(DISCORD_EMOJI_RE, (_m, isAnim: string | undefined, name: string, id: string) => {
    const ext = isAnim ? 'gif' : 'webp';
    const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=48&quality=lossless`;
    const alt = `:${name}:`;
    return stash(`<img class="md-emoji" src="${url}" alt="${escapeHtml(alt)}" title="${escapeHtml(alt)}" loading="lazy" />`);
  });

  // 4. Discord Timestamps (<t:timestamp:format>)
  working = working.replace(DISCORD_TIMESTAMP_RE, (_m, secStr: string, style: string | undefined) => {
    const sec = parseInt(secStr, 10);
    const { text, full } = formatDiscordTimestamp(sec, style || 'f');
    const iso = new Date(sec * 1000).toISOString();
    return stash(`<time class="md-timestamp" datetime="${iso}" title="${escapeHtml(full)}">${escapeHtml(text)}</time>`);
  });

  // 5. Discord Mentions (<@id>, <#id>, <@&id>)
  working = working.replace(DISCORD_MENTION_RE, (_m, prefix: string, id: string) => {
    let label = '@user';
    let cls = 'md-mention';
    if (prefix === '#') {
      label = '#channel';
      cls = 'md-mention md-channel';
    } else if (prefix === '@&') {
      label = '@role';
      cls = 'md-mention md-role';
    }
    return stash(`<span class="${cls}" data-id="${id}">${label}</span>`);
  });

  // ── Inline emphasis (Bold, Italic, Underline, Strikethrough, Spoilers) ──
  function emphasize(input: string): string {
    let t = input;

    // Protect escaped characters (\*, \_, \~, \|, \#, \-)
    const escaped: string[] = [];
    t = t.replace(/\\([*_~|>#\\-])/g, (_m, ch: string) => {
      escaped.push(ch);
      return `\u0001${escaped.length - 1}\u0001`;
    });

    // Spoilers ||spoiler||
    t = t.replace(
      /\|\|([^\n]+?)\|\|/g,
      '<span class="md-spoiler" tabindex="0" role="button" aria-label="Spoiler, click to reveal" onclick="this.classList.toggle(\'is-revealed\')">$1</span>',
    );

    // Underline Bold Italics
    t = t.replace(/__\*\*\*([^\n]+?)\*\*\*__/g, '<u><strong><em>$1</em></strong></u>');
    t = t.replace(/__\*\*\_([^\n]+?)\_\*\*__/g, '<u><strong><em>$1</em></strong></u>');

    // Bold Italics (***text***, **_text_**, _**text**_)
    t = t.replace(/\*\*\*([^\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*\_([^\n]+?)\_\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\_\*\*([^\n]+?)\*\*\_/g, '<strong><em>$1</em></strong>');

    // Underline Bold (__**text**__ or **__text__**)
    t = t.replace(/__\*\*([^\n]+?)\*\*__/g, '<u><strong>$1</strong></u>');
    t = t.replace(/\*\*__([^\n]+?)__\*\*/g, '<strong><u>$1</u></strong>');

    // Underline Italics (__*text*__, *__text__*, ___text___)
    t = t.replace(/__\*([^\n]+?)\*__/g, '<u><em>$1</em></u>');
    t = t.replace(/\*__([^\n]+?)__\*/g, '<em><u>$1</u></em>');
    t = t.replace(/___([^\n]+?)___/g, '<u><em>$1</em></u>');

    // Strikethrough combos
    t = t.replace(/~~\*\*([^\n]+?)\*\*~~/g, '<del><strong>$1</strong></del>');
    t = t.replace(/\*\*~~([^\n]+?)~~\*\*/g, '<strong><del>$1</del></strong>');
    t = t.replace(/~~\*([^\n]+?)\*~~/g, '<del><em>$1</em></del>');
    t = t.replace(/\*~~([^\n]+?)~~\*/g, '<em><del>$1</del></em>');

    // Standard Bold, Underline, Italic, Strikethrough
    t = t.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^\n]+?)__/g, '<u>$1</u>');
    t = t.replace(/\*([^\n]+?)\*/g, '<em>$1</em>');
    t = t.replace(/(?<![\w\u0001])_([^\n_]+?)_(?![\w\u0001])/g, '<em>$1</em>');
    t = t.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

    // Restore escaped characters
    t = t.replace(/\u0001(\d+)\u0001/g, (_m, idx: string) => escaped[Number(idx)]);
    return t;
  }

  // ── Links + Media + Inline Emphasis for one line ──
  function renderInline(raw: string): string {
    let out = '';
    let last = 0;
    for (const m of raw.matchAll(LINKISH_RE)) {
      const start = m.index ?? 0;
      out += escapeHtml(raw.slice(last, start));

      if (m[1] !== undefined) {
        const label = escapeHtml(m[1]);
        const url = escapeHtml(m[2]);
        out += stash(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" class="comment-link">${label}</a>`);
      } else {
        let url = m[3];
        const trailingPunct = url.match(/[.,;:!?)]+$/)?.[0] ?? '';
        if (trailingPunct) url = url.slice(0, -trailingPunct.length);
        const safeUrl = escapeHtml(url);

        if (IMAGE_EXT_RE.test(url)) {
          out += stash(
            `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="md-media-wrap">` +
              `<img src="${safeUrl}" alt="" loading="lazy" class="comment-inline-media" /></a>`,
          );
        } else if (VIDEO_EXT_RE.test(url)) {
          out += stash(`<video src="${safeUrl}" controls preload="metadata" class="comment-inline-media"></video>`);
        } else {
          out += stash(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow" class="comment-link">${safeUrl}</a>`);
          if (!seenPreview.has(url)) {
            seenPreview.add(url);
            previewUrls.push(url);
          }
        }
        out += escapeHtml(trailingPunct);
      }
      last = start + m[0].length;
    }
    out += escapeHtml(raw.slice(last));
    return emphasize(out);
  }

  function renderList(items: ListLine[]): string {
    interface Frame {
      ordered: boolean;
      indent: number;
      items: string[];
    }
    const stack: Frame[] = [];
    const top: string[] = [];

    const closeTop = () => {
      const f = stack.pop();
      if (!f) return;
      const tag = f.ordered ? 'ol' : 'ul';
      const html = `<${tag} class="md-list">${f.items.join('')}</${tag}>`;
      if (stack.length) stack[stack.length - 1].items.push(html);
      else top.push(html);
    };

    for (const item of items) {
      while (stack.length && stack[stack.length - 1].indent > item.indent) closeTop();
      const cur = stack[stack.length - 1];
      if (!cur || cur.indent < item.indent || cur.ordered !== item.ordered) {
        stack.push({ ordered: item.ordered, indent: item.indent, items: [] });
      }
      stack[stack.length - 1].items.push(`<li>${renderInline(item.content)}</li>`);
    }
    while (stack.length) closeTop();

    return top.join('');
  }

  // ── Block structure scanner ──
  function parseBlocks(text: string): string {
    const lines = text.split('\n');
    const out: string[] = [];

    let paragraphBuf: string[] = [];
    let quoteBuf: string[] = [];
    let listBuf: ListLine[] = [];

    const flushParagraph = () => {
      if (paragraphBuf.length) {
        // A stashed block-level token (e.g. \u00000\u0000 -> <pre>...</pre>)
        // must not be wrapped in a <p> — that's invalid HTML (<pre> is a
        // block element) and browsers aggressively close the <p> before it,
        // producing stray </p> tags. Split the buffer on those tokens and
        // emit each chunk as its own <p>, with block tokens emitted raw.
        const buf = paragraphBuf.map(renderInline).join('<br />');
        // \u0000N\u0000 tokens split the buffer; emit text between them as <p>
        // and the tokens themselves unwrapped.
        const parts = buf.split(/(\u0000\d+\u0000)/);
        let inP = false;
        let html = '';
        for (const part of parts) {
          if (/^\u0000\d+\u0000$/.test(part)) {
            if (inP) { html += '</p>'; inP = false; }
            html += part; // block token — restored later, no <p> wrapper
          } else if (part) {
            if (!inP) { html += '<p>'; inP = true; }
            html += part;
          }
        }
        if (inP) html += '</p>';
        if (html) out.push(html);
        paragraphBuf = [];
      }
    };
    const flushQuote = () => {
      if (quoteBuf.length) {
        out.push(`<blockquote class="md-quote">${quoteBuf.map(renderInline).join('<br />')}</blockquote>`);
        quoteBuf = [];
      }
    };
    const flushList = () => {
      if (listBuf.length) {
        out.push(renderList(listBuf));
        listBuf = [];
      }
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // `>>>` multi-line quote until end of message
      const multiQuote = line.match(/^>>>\s?(.*)$/);
      if (multiQuote) {
        flushParagraph();
        flushList();
        const rest = [multiQuote[1], ...lines.slice(i + 1)];
        out.push(`<blockquote class="md-quote">${rest.map(renderInline).join('<br />')}</blockquote>`);
        i = lines.length;
        break;
      }

      // Single-line `>` quote
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        quoteBuf.push(quote[1]);
        i++;
        continue;
      }
      flushQuote();

      // Headers (#, ##, ###)
      const header = line.match(/^(#{1,3})\s+(.*)$/);
      if (header) {
        flushParagraph();
        flushList();
        out.push(`<div class="md-heading md-h${header[1].length}">${renderInline(header[2])}</div>`);
        i++;
        continue;
      }

      // Subtext (-# text)
      const subtext = line.match(/^-#\s+(.*)$/);
      if (subtext) {
        flushParagraph();
        flushList();
        out.push(`<div class="md-subtext">${renderInline(subtext[1])}</div>`);
        i++;
        continue;
      }

      // Lists: `- `, `* `, or `1. `
      const listItem = line.match(/^( *)([-*]|\d+\.)\s+(.*)$/);
      if (listItem) {
        flushParagraph();
        listBuf.push({
          ordered: /^\d+\.$/.test(listItem[2]),
          indent: Math.floor(listItem[1].length / 2),
          content: listItem[3],
        });
        i++;
        continue;
      }
      flushList();

      if (line.trim() === '') {
        flushParagraph();
        i++;
        continue;
      }

      paragraphBuf.push(line);
      i++;
    }

    flushParagraph();
    flushQuote();
    flushList();

    return out.join('');
  }

  const blocked = parseBlocks(working);

  // Restore stashed tokens
  const html = blocked.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => store[Number(idx)]);

  return { html, previewUrls };
}
