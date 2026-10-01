/**
 * Discord-style Markdown Parser & Media Extractor for AnymeX Chat
 */

export interface ParsedMediaItem {
  type: 'image' | 'video';
  url: string;
}

export interface ParsedChatMessage {
  html: string;
  media: ParsedMediaItem[];
}

const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|avif|svg)(\?[^\s]*)?$/i;
const VIDEO_EXT_REGEX = /\.(mp4|webm|mov|ogg)(\?[^\s]*)?$/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

  // Extract media URLs from text (both full http/https URLs and relative /uploads/ URLs)
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

  // Normalize newlines and clean whitespace
  let processed = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  processed = processed.split('\n').map((l) => l.trimEnd()).join('\n');
  processed = processed.replace(/\n{3,}/g, '\n\n').trim();

  // Split multi-line code blocks first so inner markdown isn't touched
  const codeBlocks: string[] = [];
  processed = processed.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const safeCode = escapeHtml(code);
    codeBlocks.push(
      `<pre class="discord-code-block"><code class="language-${lang || 'text'}">${safeCode}</code></pre>`
    );
    return `§§CODEBLOCK_${idx}§§`;
  });

  // Split single-line inline code
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="discord-inline-code">${escapeHtml(code)}</code>`);
    return `§§INLINECODE_${idx}§§`;
  });

  // Escape normal text
  processed = escapeHtml(processed);

  // Line-by-line processing for blockquotes, headers, subtext (-#)
  const lines = processed.split('\n');
  const formattedLines = lines.map((line) => {
    const trimmed = line.trim();

    // Discord Subtext: -# subtext
    if (trimmed.startsWith('-# ')) {
      return `<div class="discord-subtext">${applyInlineMarkdown(trimmed.slice(3))}</div>`;
    }

    // Discord Blockquote: > text
    if (trimmed.startsWith('&gt; ')) {
      return `<blockquote class="discord-blockquote">${applyInlineMarkdown(trimmed.slice(5))}</blockquote>`;
    }

    // Discord Headers
    if (trimmed.startsWith('### ')) {
      return `<h4 class="discord-h3">${applyInlineMarkdown(trimmed.slice(4))}</h4>`;
    }
    if (trimmed.startsWith('## ')) {
      return `<h3 class="discord-h2">${applyInlineMarkdown(trimmed.slice(3))}</h3>`;
    }
    if (trimmed.startsWith('# ')) {
      return `<h2 class="discord-h1">${applyInlineMarkdown(trimmed.slice(2))}</h2>`;
    }

    return applyInlineMarkdown(line);
  });

  processed = formattedLines.join('\n');

  // Spoilers: ||spoiler||
  processed = processed.replace(
    /\|\|([\s\S]+?)\|\|/g,
    '<span class="discord-spoiler" title="Click to reveal spoiler">$1</span>'
  );

  // Mentions: @everyone, @here, @staff, @admin, @mod, @user
  processed = processed.replace(/@([a-zA-Z0-9_.-]+)/g, (match, username) => {
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
  processed = processed.replace(/#(\d+)\b/g, (_, id) => {
    return `<a href="/report/${id}" class="report-link-chip" target="_blank">#${id}</a>`;
  });

  // Channel tags: #channel-name
  processed = processed.replace(/#([a-zA-Z0-9_\-]+)\b/g, (fullMatch, chName) => {
    const target = channels.find(
      (c) => c.name.toLowerCase() === chName.toLowerCase() || c.id.toLowerCase() === chName.toLowerCase()
    );
    if (target) {
      return `<button type="button" class="channel-link-chip" data-channel-jump="${target.id}" title="Switch to #${target.name}"><span class="chip-hash">#</span>${target.name}</button>`;
    }
    return fullMatch;
  });

  // Links and Message jump chip (strip embedded media URLs from text body)
  processed = processed.replace(
    /(https?:\/\/[^\s<]+|\/uploads\/[^\s<]+)/g,
    (url) => {
      // If it's an uploaded media file or raw image/video URL, don't show raw text link since we show the embedded media card below!
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
    }
  );

  // Restore inline codes
  processed = processed.replace(/§§INLINECODE_(\d+)§§/g, (_, idx) => inlineCodes[Number(idx)] || '');

  // Restore code blocks
  processed = processed.replace(/§§CODEBLOCK_(\d+)§§/g, (_, idx) => codeBlocks[Number(idx)] || '');

  // Clean any empty lines or trailing breaks created by stripped media links
  processed = processed
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    html: processed,
    media,
  };
}

function applyInlineMarkdown(text: string): string {
  // Bold Italic: ***text***
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');

  // Bold: **text**
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Underline: __text__
  text = text.replace(/__([^_]+)__/g, '<u>$1</u>');

  // Italic: *text* or _text_
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');

  // Strikethrough: ~~text~~
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return text;
}
