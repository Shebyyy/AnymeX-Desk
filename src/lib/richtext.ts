/**
 * Renders raw text — comment bodies, report descriptions, steps-to-reproduce —
 * as safe HTML using Discord's own markdown subset, so text typed the same
 * way you'd type it in a Discord message looks the same here.
 * Reference: https://support.discord.com/hc/en-us/articles/210298617
 *
 * Covered: bold, italic, underline, strikethrough, bold+italic and
 * underline+bold/italic combos, inline code, fenced code blocks (with an
 * optional language class — no syntax-highlighting colors, since we don't
 * ship a highlighter), single-line (`>`) and multi-line (`>>>`) blockquotes,
 * spoilers (`||text||`, click to reveal), headers (`#`/`##`/`###`), subtext
 * (`-#`), unordered and ordered lists with 2-space nesting, masked links
 * (`[label](url)`), and raw URL autolinking — direct image/video links are
 * inlined as actual media instead of plain text.
 *
 * Deliberately NOT covered: Discord's @mention / #channel / emoji / timestamp
 * tags (`<@id>`, `<:name:id>`, `<t:...>`) — those reference Discord snowflake
 * IDs this site has no way to resolve.
 *
 * Titles are never run through this — see report/[id].astro — a title is
 * plain text everywhere else it appears (board rows, <title>, webhook embeds,
 * notifications), so markup there would look broken rather than helpful.
 *
 * IMPORTANT implementation note: block-level markers (`>`, `#`, `-`, digits)
 * are detected on the RAW, not-yet-HTML-escaped text. `>` in particular is
 * one of the characters escapeHtml() rewrites to `&gt;` — if escaping ran
 * first, blockquote lines would never match. Only once a line has been
 * classified and its marker stripped does its remaining content get
 * escaped, linkified, and emphasized.
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?\S*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)(\?\S*)?$/i;

// A masked link `[label](url)` or a bare URL, matched in one pass so a URL
// is never processed twice (once as itself, again as part of an <a> we just
// built for it).
const LINKISH_RE = /\[([^[\]\n]+)]\((https?:\/\/[^\s()]+)\)|(\bhttps?:\/\/[^\s<>"')\]]+)/gi;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RichBody {
  /** Safe HTML — text is escaped, only our own markdown/linkify/media tags are raw. */
  html: string;
  /** Non-media URLs found in the body, in order, de-duplicated — candidates for an OG preview card. */
  previewUrls: string[];
}

interface ListLine {
  ordered: boolean;
  indent: number;
  content: string;
}

export function prepareCommentBody(body: string): RichBody {
  const previewUrls: string[] = [];
  const seenPreview = new Set<string>();

  // Stashed raw HTML (code blocks, inline code, links/media) — kept opaque
  // through every later regex pass and restored verbatim at the very end.
  const store: string[] = [];
  const stash = (html: string): string => {
    store.push(html);
    return `\u0000${store.length - 1}\u0000`;
  };

  // ── Inline emphasis (bold/italic/underline/strike/spoiler) ──
  // Applied to text that's already been HTML-escaped and had its
  // links/code swapped for opaque placeholder tokens.
  function emphasize(input: string): string {
    let t = input;

    // Backslash-escaped punctuation (`\*`, `\_`, ...) is protected from
    // every pass below, then restored as a literal character at the end.
    const escaped: string[] = [];
    t = t.replace(/\\([*_~|>#\\-])/g, (_m, ch: string) => {
      escaped.push(ch);
      return `\u0001${escaped.length - 1}\u0001`;
    });

    // Longest / most specific delimiters first so e.g. `***x***` doesn't get
    // partially consumed by the plain-bold pass before the combo pass sees it.
    t = t.replace(/\*\*\*([^\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/__\*\*([^\n]+?)\*\*__/g, '<u><strong>$1</strong></u>');
    t = t.replace(/__\*([^\n]+?)\*__/g, '<u><em>$1</em></u>');
    t = t.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^\n]+?)__/g, '<u>$1</u>');
    t = t.replace(/\*([^\n]+?)\*/g, '<em>$1</em>');
    // Underscore italics only trigger outside of word characters, so
    // `snake_case_words` doesn't get half-italicized.
    t = t.replace(/(?<![\w\u0001])_([^\n_]+?)_(?![\w\u0001])/g, '<em>$1</em>');
    t = t.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    t = t.replace(
      /\|\|([^\n]+?)\|\|/g,
      '<span class="md-spoiler" tabindex="0" role="button" aria-label="Spoiler, click to reveal" onclick="this.classList.toggle(\'is-revealed\')">$1</span>',
    );

    t = t.replace(/\u0001(\d+)\u0001/g, (_m, idx: string) => escaped[Number(idx)]);
    return t;
  }

  // ── Links + media, then emphasis, for one line of RAW content ──
  // (raw = not yet HTML-escaped; may still contain earlier code-placeholder
  // tokens, which LINKISH_RE and escapeHtml both simply pass through.)
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
            `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer nofollow">` +
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

  // ── Block structure, scanning RAW (unescaped) lines ──
  function parseBlocks(text: string): string {
    const lines = text.split('\n');
    const out: string[] = [];

    let paragraphBuf: string[] = [];
    let quoteBuf: string[] = [];
    let listBuf: ListLine[] = [];

    const flushParagraph = () => {
      if (paragraphBuf.length) {
        out.push(`<p>${paragraphBuf.map(renderInline).join('<br />')}</p>`);
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

      // `>>>` turns the rest of the message into one blockquote.
      const multiQuote = line.match(/^>>>\s?(.*)$/);
      if (multiQuote) {
        flushParagraph();
        flushList();
        const rest = [multiQuote[1], ...lines.slice(i + 1)];
        out.push(`<blockquote class="md-quote">${rest.map(renderInline).join('<br />')}</blockquote>`);
        i = lines.length;
        break;
      }

      // Single-line `>` quotes — consecutive ones are grouped into one block.
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        quoteBuf.push(quote[1]);
        i++;
        continue;
      }
      flushQuote();

      // `#`/`##`/`###` headers (4+ hashes are not a header, matching Discord).
      const header = line.match(/^(#{1,3})\s+(.*)$/);
      if (header) {
        flushParagraph();
        flushList();
        out.push(`<div class="md-heading md-h${header[1].length}">${renderInline(header[2])}</div>`);
        i++;
        continue;
      }

      // `-#` subtext.
      const subtext = line.match(/^-#\s+(.*)$/);
      if (subtext) {
        flushParagraph();
        flushList();
        out.push(`<div class="md-subtext">${renderInline(subtext[1])}</div>`);
        i++;
        continue;
      }

      // `- `/`* ` bullets or `1. ` ordered items; two leading spaces nest a level.
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

  // 1. Fenced code blocks — nothing inside these is markdown. Extracted
  // first, on the fully raw body, so their content is never touched by
  // anything below (block detection, links, emphasis).
  let working = body.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang: string | undefined, code: string) => {
    const cls = lang ? ` class="language-${escapeHtml(lang.toLowerCase())}"` : '';
    const trimmed = code.replace(/\n$/, '');
    return stash(`<pre class="md-codeblock"><code${cls}>${escapeHtml(trimmed)}</code></pre>`);
  });

  // 2. Inline code spans — also protected from further processing.
  working = working.replace(/`([^`\n]+)`/g, (_m, code: string) => stash(`<code class="md-code">${escapeHtml(code)}</code>`));

  // 3. Block structure — still-raw text (markdown punctuation intact) is
  // where `>`/`#`/`-`/digits get classified; escaping/linkifying/emphasis
  // happens per-line, inside renderInline(), only after that classification.
  const blocked = parseBlocks(working);

  // 4. Swap the stashed code/link/media HTML back in.
  const html = blocked.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => store[Number(idx)]);

  return { html, previewUrls };
}
