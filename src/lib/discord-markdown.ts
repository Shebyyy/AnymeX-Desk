/**
 * Complete Discord-style Markdown Parser & Media Extractor for AnymeX Chat
 * Fully supports:
 * - Code blocks (```lang\n...``` and ```...```) & inline code (`code`)
 * - Blockquotes: Single line (> quote) and Multi-line (>>> quote)
 * - Headers: # H1, ## H2, ### H3
 * - Subtext: -# small muted text (single & grouped multi-line)
 * - Lists: Unordered (- or * or +) and Ordered (1.) with indentation
 * - Spoilers: ||spoiler|| (click to reveal)
 * - Discord Custom Emojis: <:name:id> and animated <a:name:id>
 * - Discord Timestamps: <t:1756886400:R>, <t:1756886400:f>, etc.
 * - Discord Snowflake Mentions: <@id>, <@!id>, <#id>, <@&id>
 * - Masked links [label](url), angle-bracket links <url>, and bare URLs
 * - Horizontal Dividers: ---, ***, ___
 * - Backslash escaping: \*not bold\*, \# not header, etc.
 * - Emphasis combos: Bold, Italic, Underline, Strikethrough, and all nested combos
 * - Chat mentions: @everyone, @here, @staff, @admin, @mod, @user
 * - Report tags: #123
 * - Channel tags: #channel-name
 * - Message jump chips: /support?channel=...&message=...
 * - Media extraction: images and videos
 */

export interface ParsedMediaItem {
  type: 'image' | 'video';
  url: string;
}

export interface ParsedChatMessage {
  html: string;
  media: ParsedMediaItem[];
}

const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?[^\s]*)?$/i;
const VIDEO_EXT_REGEX = /\.(mp4|webm|mov|m4v|ogg)(\?[^\s]*)?$/i;

const DISCORD_EMOJI_RE = /<(a)?:([a-zA-Z0-9_]{2,32}):(\d{17,21})>/g;
const DISCORD_TIMESTAMP_RE = /<t:(\d{9,12})(?::([tTdDfFR]))?>/g;
const DISCORD_SNOWFLAKE_RE = /<(@!?|#|@&)(\d{17,21})>/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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

interface ListLine {
  ordered: boolean;
  indent: number;
  content: string;
}

function renderList(items: ListLine[], renderInline: (t: string) => string): string {
  if (!items.length) return '';
  const isOrdered = items[0].ordered;
  const tag = isOrdered ? 'ol' : 'ul';
  const lis = items
    .map((it) => {
      const style = it.indent > 0 ? ` style="margin-left: ${it.indent * 18}px;"` : '';
      return `<li${style}>${renderInline(it.content)}</li>`;
    })
    .join('');
  return `<${tag} class="md-list">${lis}</${tag}>`;
}

export function parseDiscordMarkdown(
  rawText: string,
  options: {
    channels?: { id: string; name: string }[];
    currentUsername?: string;
  } = {}
): ParsedChatMessage {
  if (!rawText) return { html: '', media: [] };

  const channels = options.channels || [];
  const currentUsername = (options.currentUsername || '').toLowerCase();
  const media: ParsedMediaItem[] = [];

  // 1. Extract media URLs
  const mediaUrlRegex = /(https?:\/\/[^\s]+|\/uploads\/[^\s]+)/g;
  const urlsInText = rawText.match(mediaUrlRegex) || [];

  for (const url of urlsInText) {
    const isImage = IMAGE_EXT_REGEX.test(url) || url.includes('/uploads/chat-') || url.includes('/uploads/');
    const isVideo = VIDEO_EXT_REGEX.test(url);

    if (isVideo) {
      media.push({ type: 'video', url });
    } else if (isImage) {
      media.push({ type: 'image', url });
    }
  }

  // Normalize line endings
  let working = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Token store for stashed blocks
  const store: string[] = [];
  const stash = (html: string): string => {
    store.push(html);
    return `\u0000${store.length - 1}\u0000`;
  };

  // 2. Fenced Code Blocks with language: ```lang\n...```
  working = working.replace(/```([a-zA-Z0-9_-]+)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const cls = ` class="discord-code md-code language-${escapeHtml(lang.toLowerCase())}"`;
    const trimmed = code.replace(/\n$/, '');
    return stash(`<pre class="discord-code-block md-codeblock"><code${cls}>${escapeHtml(trimmed)}</code></pre>`);
  });

  // Fenced Code Blocks without language: ```\n...``` or ```...```
  working = working.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    const trimmed = code.replace(/^\n/, '').replace(/\n$/, '');
    return stash(`<pre class="discord-code-block md-codeblock"><code class="discord-code md-code">${escapeHtml(trimmed)}</code></pre>`);
  });

  // 3. Inline code (`code`)
  working = working.replace(/`([^`\n]+?)`/g, (_m, code: string) =>
    stash(`<code class="discord-inline-code md-code">${escapeHtml(code)}</code>`)
  );

  // 4. Discord Custom Emojis
  working = working.replace(DISCORD_EMOJI_RE, (_m, isAnim: string | undefined, name: string, id: string) => {
    const ext = isAnim ? 'gif' : 'webp';
    const url = `https://cdn.discordapp.com/emojis/${id}.${ext}?size=48&quality=lossless`;
    const alt = `:${name}:`;
    return stash(`<img class="md-emoji" src="${url}" alt="${escapeHtml(alt)}" title="${escapeHtml(alt)}" loading="lazy" />`);
  });

  // 5. Discord Timestamps
  working = working.replace(DISCORD_TIMESTAMP_RE, (_m, secStr: string, style: string | undefined) => {
    const sec = parseInt(secStr, 10);
    const { text, full } = formatDiscordTimestamp(sec, style || 'f');
    const iso = new Date(sec * 1000).toISOString();
    return stash(`<time class="md-timestamp" datetime="${iso}" title="${escapeHtml(full)}">${escapeHtml(text)}</time>`);
  });

  // Helper for inline text formatting
  function renderInline(input: string): string {
    let t = input;

    // 0. Protect backslash-escaped characters (\*, \_, \~, \|, \#, \@, \-, \>, \\)
    const escaped: string[] = [];
    t = t.replace(/\\([*_~|>#@\\-])/g, (_m, ch: string) => {
      escaped.push(ch);
      return `\u0001${escaped.length - 1}\u0001`;
    });

    // Angle-bracket links: <https://example.com>
    t = t.replace(/<(https?:\/\/[^\s>]+)>/g, (_m, url: string) => {
      return stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="chat-external-link">${escapeHtml(url)}</a>`);
    });

    // Masked links: [label](url)
    t = t.replace(/\[([^[\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, (_m, label: string, url: string) => {
      return stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="chat-external-link">${escapeHtml(label)}</a>`);
    });

    // Discord snowflake mentions: <@id>, <@!id>, <#id>, <@&id>
    t = t.replace(DISCORD_SNOWFLAKE_RE, (_m, prefix: string, id: string) => {
      if (prefix === '#') {
        const chan = channels.find((c) => c.id === id);
        const name = chan ? chan.name : id;
        return stash(`<button type="button" class="channel-link-chip" data-channel-jump="${id}"><span class="chip-hash">#</span>${escapeHtml(name)}</button>`);
      }
      if (prefix === '@&') {
        return stash(`<span class="mention-chip mention-role-chip role-staff">@role</span>`);
      }
      return stash(`<button type="button" class="mention-chip mention-user-chip" data-mention-user="${id}">@user</button>`);
    });

    // Spoilers: ||spoiler||
    t = t.replace(
      /\|\|([\s\S]+?)\|\|/g,
      (_m, spoilerText: string) =>
        stash(`<span class="discord-spoiler md-spoiler" tabindex="0" role="button" title="Click to reveal spoiler" onclick="this.classList.toggle('revealed');this.classList.toggle('is-revealed')">${escapeHtml(spoilerText)}</span>`)
    );

    // Escape raw HTML before applying emphasis
    t = escapeHtml(t);

    // Underline Bold Italics
    t = t.replace(/__\*\*\*([^\n]+?)\*\*\*__/g, '<u><strong><em>$1</em></strong></u>');
    t = t.replace(/__\*\*\_([^\n]+?)\_\*\*__/g, '<u><strong><em>$1</em></strong></u>');

    // Bold Italics (***text***)
    t = t.replace(/\*\*\*([^\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*\_([^\n]+?)\_\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\_\*\*([^\n]+?)\*\*\_/g, '<strong><em>$1</em></strong>');

    // Underline Bold (__**text**__)
    t = t.replace(/__\*\*([^\n]+?)\*\*__/g, '<u><strong>$1</strong></u>');
    t = t.replace(/\*\*__([^\n]+?)__\*\*/g, '<strong><u>$1</u></strong>');

    // Underline Italics (__*text*__)
    t = t.replace(/__\*([^\n]+?)\*__/g, '<u><em>$1</em></u>');
    t = t.replace(/\*__([^\n]+?)__\*/g, '<em><u>$1</u></em>');
    t = t.replace(/___([^\n]+?)___/g, '<u><em>$1</em></u>');

    // Strikethrough Bold (~~**text**~~)
    t = t.replace(/~~\*\*([^\n]+?)\*\*~~/g, '<del><strong>$1</strong></del>');
    t = t.replace(/\*\*~~([^\n]+?)~~\*\*/g, '<strong><del>$1</del></strong>');
    t = t.replace(/~~\*([^\n]+?)\*~~/g, '<del><em>$1</em></del>');
    t = t.replace(/\*~~([^\n]+?)~~\*/g, '<em><del>$1</del></em>');

    // Standard Bold, Underline, Italic, Strikethrough
    t = t.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^\n]+?)__/g, '<u>$1</u>');
    t = t.replace(/\*([^\n]+?)\*/g, '<em>$1</em>');
    t = t.replace(/(^|\s)_([^\n_]+?)_(?=\s|$)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

    // Mentions: @everyone, @here, @staff, @admin, @mod, @username
    t = t.replace(/@([a-zA-Z0-9_.-]+)/g, (_match, username) => {
      const clean = username.toLowerCase();
      if (clean === 'everyone' || clean === 'here') {
        return `<span class="mention-chip mention-broadcast" title="Broadcast notification">@${username}</span>`;
      }
      if (clean === 'staff' || clean === 'admin' || clean === 'mod') {
        return `<span class="mention-chip mention-role-chip role-${clean}" title="Role mention">@${username}</span>`;
      }
      const isMe = currentUsername && clean === currentUsername;
      return `<button type="button" class="mention-chip mention-user-chip ${isMe ? 'mention-me' : ''}" data-mention-user="${username}" title="View @${username}'s Profile">@${username}</button>`;
    });

    // Report tags: #123
    t = t.replace(/#(\d+)\b/g, (_, id) => {
      return `<a href="/report/${id}" class="report-link-chip" target="_blank">#${id}</a>`;
    });

    // Channel tags: #channel-name
    t = t.replace(/#([a-zA-Z0-9_\-]+)\b/g, (fullMatch, chName) => {
      const target = channels.find(
        (c) => c.name.toLowerCase() === chName.toLowerCase() || c.id.toLowerCase() === chName.toLowerCase()
      );
      if (target) {
        return `<button type="button" class="channel-link-chip" data-channel-jump="${target.id}" title="Switch to #${target.name}"><span class="chip-hash">#</span>${target.name}</button>`;
      }
      return fullMatch;
    });

    // Bare URLs and Message Jump Chip
    t = t.replace(/(https?:\/\/[^\s<]+|\/uploads\/[^\s<]+)/g, (url) => {
      // Strip standalone media files since they render in the attached media card
      if (url.includes('/uploads/chat-') || url.includes('/uploads/') || IMAGE_EXT_REGEX.test(url) || VIDEO_EXT_REGEX.test(url)) {
        return '';
      }
      if (url.includes('/support?') && url.includes('channel=')) {
        const chanMatch = url.match(/[?&]channel=([a-zA-Z0-9_-]+)/);
        const msgMatch = url.match(/[?&]message=(\d+)/);
        const chanId = chanMatch ? chanMatch[1] : '';
        const msgId = msgMatch ? msgMatch[1] : '';
        return `<button type="button" class="message-link-chip" data-channel-jump="${chanId}" data-msg-jump="${msgId}" title="Jump to #${chanId}${msgId ? ` message #${msgId}` : ''}"><span class="chip-hash">#</span>${chanId}${msgId ? ` › msg #${msgId}` : ''}</button>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-external-link">${url}</a>`;
    });

    // Restore escaped characters
    t = t.replace(/\u0001(\d+)\u0001/g, (_m, idx: string) => escapeHtml(escaped[Number(idx)]));

    return t;
  }

  // 6. Block-level parsing: Headers, Blockquotes, Lists, Subtext, Dividers, Paragraphs
  const lines = working.split('\n');
  const out: string[] = [];
  let paragraphBuf: string[] = [];
  let quoteBuf: string[] = [];
  let listBuf: ListLine[] = [];
  let subtextBuf: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuf.length) {
      out.push(paragraphBuf.map(renderInline).join('<br />'));
      paragraphBuf = [];
    }
  };
  const flushQuote = () => {
    if (quoteBuf.length) {
      out.push(`<blockquote class="discord-blockquote md-quote">${quoteBuf.map(renderInline).join('<br />')}</blockquote>`);
      quoteBuf = [];
    }
  };
  const flushList = () => {
    if (listBuf.length) {
      out.push(renderList(listBuf, renderInline));
      listBuf = [];
    }
  };
  const flushSubtext = () => {
    if (subtextBuf.length) {
      out.push(`<div class="discord-subtext md-subtext">${subtextBuf.map(renderInline).join('<br />')}</div>`);
      subtextBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Horizontal Rule: `---` or `***` or `___`
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      flushQuote();
      flushList();
      flushSubtext();
      out.push('<hr class="discord-divider md-divider" />');
      i++;
      continue;
    }

    // Multi-line blockquote: `>>> `
    const multiQuote = line.match(/^>>>\s?(.*)$/);
    if (multiQuote) {
      flushParagraph();
      flushQuote();
      flushList();
      flushSubtext();
      const rest = [multiQuote[1], ...lines.slice(i + 1)];
      out.push(`<blockquote class="discord-blockquote md-quote">${rest.map(renderInline).join('<br />')}</blockquote>`);
      i = lines.length;
      break;
    }

    // Single-line quote: `> `
    const singleQuote = line.match(/^>\s?(.*)$/);
    if (singleQuote) {
      flushParagraph();
      flushList();
      flushSubtext();
      quoteBuf.push(singleQuote[1]);
      i++;
      continue;
    }
    flushQuote();

    // Headers: `# `, `## `, `### `
    const header = line.match(/^(#{1,3})\s+(.*)$/);
    if (header) {
      flushParagraph();
      flushList();
      flushSubtext();
      const level = header[1].length;
      const tag = level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4';
      out.push(`<${tag} class="discord-h${level} md-heading md-h${level}">${renderInline(header[2])}</${tag}>`);
      i++;
      continue;
    }

    // Subtext: `-# `
    const subtext = line.match(/^-#\s+(.*)$/);
    if (subtext) {
      flushParagraph();
      flushList();
      flushQuote();
      subtextBuf.push(subtext[1]);
      i++;
      continue;
    }
    flushSubtext();

    // Lists: `- `, `* `, `+ `, or `1. `
    const listItem = line.match(/^( *)([-*+]|\d+\.)\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      flushQuote();
      flushSubtext();
      const isOrd = /^\d+\.$/.test(listItem[2]);
      if (listBuf.length && listBuf[0].ordered !== isOrd) {
        flushList();
      }
      listBuf.push({
        ordered: isOrd,
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
  flushSubtext();

  let html = out.join('\n');

  // Restore stashed tokens (code blocks, inline code, emojis, timestamps, spoilers, links)
  let prevHtml = '';
  while (prevHtml !== html) {
    prevHtml = html;
    html = html.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => store[Number(idx)] || '');
  }

  return {
    html: html.trim(),
    media,
  };
}
