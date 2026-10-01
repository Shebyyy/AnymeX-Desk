import { describe, it, expect } from 'bun:test';
import { parseDiscordMarkdown } from '../../src/lib/discord-markdown';

describe('Discord Markdown Parser', () => {
  it('parses code blocks with language and newline', () => {
    const res = parseDiscordMarkdown('```js\nconsole.log("hello");\n```');
    expect(res.html).toContain('<pre class="discord-code-block md-codeblock"><code class="discord-code md-code language-js">console.log(&quot;hello&quot;);</code></pre>');
  });

  it('parses code blocks without language and without trailing newline', () => {
    const res = parseDiscordMarkdown('```console.log("hello");```');
    expect(res.html).toContain('<pre class="discord-code-block md-codeblock"><code class="discord-code md-code">console.log(&quot;hello&quot;);</code></pre>');
  });

  it('parses inline code', () => {
    const res = parseDiscordMarkdown('This is `inline code` test');
    expect(res.html).toContain('<code class="discord-inline-code md-code">inline code</code>');
  });

  it('parses subtext (-#) and groups multiple lines', () => {
    const res = parseDiscordMarkdown('-# this is line 1\n-# this is line 2');
    expect(res.html).toBe('<div class="discord-subtext md-subtext">this is line 1<br />this is line 2</div>');
  });

  it('parses headers (#, ##, ###)', () => {
    const res = parseDiscordMarkdown('# H1\n## H2\n### H3');
    expect(res.html).toContain('<h2 class="discord-h1 md-heading md-h1">H1</h2>');
    expect(res.html).toContain('<h3 class="discord-h2 md-heading md-h2">H2</h3>');
    expect(res.html).toContain('<h4 class="discord-h3 md-heading md-h3">H3</h4>');
  });

  it('parses single-line and multi-line blockquotes', () => {
    const res = parseDiscordMarkdown('> single quote\n>>> multi line 1\nline 2');
    expect(res.html).toContain('<blockquote class="discord-blockquote md-quote">single quote</blockquote>');
    expect(res.html).toContain('<blockquote class="discord-blockquote md-quote">multi line 1<br />line 2</blockquote>');
  });

  it('parses unordered and ordered lists with nested indentation', () => {
    const res = parseDiscordMarkdown('- item 1\n  - nested\n1. one\n2. two');
    expect(res.html).toContain('<ul class="md-list"><li>item 1</li><li style="margin-left: 18px;">nested</li></ul>');
    expect(res.html).toContain('<ol class="md-list"><li>one</li><li>two</li></ol>');
  });

  it('parses spoilers with click toggle', () => {
    const res = parseDiscordMarkdown('||secret spoiler||');
    expect(res.html).toContain('class="discord-spoiler md-spoiler"');
    expect(res.html).toContain('secret spoiler');
  });

  it('parses custom discord emojis', () => {
    const res = parseDiscordMarkdown('<:pepe:123456789012345678>');
    expect(res.html).toContain('<img class="md-emoji" src="https://cdn.discordapp.com/emojis/123456789012345678.webp?size=48&quality=lossless"');
  });

  it('parses discord timestamps', () => {
    const res = parseDiscordMarkdown('<t:1756886400:R>');
    expect(res.html).toContain('<time class="md-timestamp"');
  });

  it('parses masked links [label](url) and angle-bracket links', () => {
    const res = parseDiscordMarkdown('[Google](https://google.com) and <https://example.com>');
    expect(res.html).toContain('<a href="https://google.com" target="_blank" rel="noopener noreferrer" class="chat-external-link">Google</a>');
    expect(res.html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="chat-external-link">https://example.com</a>');
  });

  it('parses snowflake mentions (<@id>, <#id>, <@&id>)', () => {
    const res = parseDiscordMarkdown('<@123456789012345678> <#987654321098765432>');
    expect(res.html).toContain('data-mention-user="123456789012345678"');
    expect(res.html).toContain('data-channel-jump="987654321098765432"');
  });

  it('parses horizontal dividers (---)', () => {
    const res = parseDiscordMarkdown('top\n---\nbottom');
    expect(res.html).toContain('<hr class="discord-divider md-divider" />');
  });

  it('respects backslash escaping', () => {
    const res = parseDiscordMarkdown('\\*not italic\\* and \\# not header');
    expect(res.html).toContain('*not italic* and # not header');
    expect(res.html).not.toContain('<em>');
    expect(res.html).not.toContain('<h2');
  });

  it('parses mentions and chat tags', () => {
    const res = parseDiscordMarkdown('@Sheby @everyone @staff #123', {
      channels: [{ id: 'general', name: 'general' }],
    });
    expect(res.html).toContain('data-mention-user="Sheby"');
    expect(res.html).toContain('mention-broadcast');
    expect(res.html).toContain('role-staff');
    expect(res.html).toContain('/report/123');
  });

  it('parses bold, italic, underline, strikethrough combos', () => {
    const res = parseDiscordMarkdown('**bold** *italic* __underline__ ~~strike~~ ***bold italic*** __***all three***__');
    expect(res.html).toContain('<strong>bold</strong>');
    expect(res.html).toContain('<em>italic</em>');
    expect(res.html).toContain('<u>underline</u>');
    expect(res.html).toContain('<del>strike</del>');
    expect(res.html).toContain('<strong><em>bold italic</em></strong>');
    expect(res.html).toContain('<u><strong><em>all three</em></strong></u>');
  });
});
