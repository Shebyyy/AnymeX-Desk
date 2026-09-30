<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { isPushSupported, getPushSubscription, subscribeToPush, unsubscribeFromPush } from '../scripts/push-client';

  interface UserInfo {
    id: string;
    username: string;
    avatarHash: string | null;
    isStaff: boolean;
  }

  interface Channel {
    id: string;
    name: string;
    description: string | null;
    icon: string;
    isStaffOnly: boolean;
  }

  interface ReplyInfo {
    id: number;
    body: string;
    authorName: string;
    authorAvatar: string | null;
  }

  interface TaggedReport {
    id: number;
    title: string;
    status: string;
    kind: string;
    votes: number;
    category: string | null;
  }

  interface ChatMessage {
    id: number;
    channelId: string;
    userId: string;
    body: string;
    replyToId: number | null;
    createdAt: number;
    authorName: string;
    authorAvatar: string | null;
    authorRole: string | null;
    replyTo: ReplyInfo | null;
    taggedReports?: TaggedReport[];
  }

  let { currentUser }: { currentUser: UserInfo | null } = $props();

  let channels = $state<Channel[]>([]);
  let activeChannelId = $state<string>('general');
  let messages = $state<ChatMessage[]>([]);
  let inputText = $state<string>('');
  let replyingTo = $state<ChatMessage | null>(null);
  let isSending = $state<boolean>(false);
  let isLoading = $state<boolean>(true);
  let pushActive = $state<boolean>(false);
  let pushSupported = $state<boolean>(false);
  let messagesEndRef = $state<HTMLDivElement | null>(null);
  let highlightedMessageId = $state<number | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function loadChannels() {
    try {
      const res = await fetch('/api/chat/channels');
      const data = await res.json();
      if (data.ok && data.channels) {
        channels = data.channels;
        if (!channels.find((c) => c.id === activeChannelId) && channels.length > 0) {
          activeChannelId = channels[0].id;
        }
      }
    } catch (err) {
      console.error('Failed to load channels:', err);
    }
  }

  async function loadMessages(scrollBottom = false) {
    try {
      const res = await fetch(`/api/chat/messages?channel=${encodeURIComponent(activeChannelId)}`);
      const data = await res.json();
      if (data.ok && data.messages) {
        const prevCount = messages.length;
        messages = data.messages;
        if (scrollBottom || prevCount === 0 || prevCount < messages.length) {
          scrollToBottom();
        }
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      isLoading = false;
    }
  }

  function scrollToBottom() {
    setTimeout(() => {
      messagesEndRef?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  }

  function scrollToMessage(id: number) {
    highlightedMessageId = id;
    const el = document.getElementById(`chat-msg-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setTimeout(() => {
      if (highlightedMessageId === id) highlightedMessageId = null;
    }, 2500);
  }

  async function sendMessage() {
    if (!inputText.trim() || isSending || !currentUser) return;
    isSending = true;

    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: activeChannelId,
          body: inputText,
          replyToId: replyingTo ? replyingTo.id : null,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        inputText = '';
        replyingTo = null;
        await loadMessages(true);
      } else {
        alert(data.error || 'Failed to send message');
      }
    } catch (err) {
      console.error('Send error:', err);
    } finally {
      isSending = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function setReply(msg: ChatMessage) {
    replyingTo = msg;
    const inputEl = document.getElementById('chat-composer-input');
    if (inputEl) inputEl.focus();
  }

  function addMention(username: string) {
    inputText = inputText ? `${inputText} @${username} ` : `@${username} `;
    const inputEl = document.getElementById('chat-composer-input');
    if (inputEl) inputEl.focus();
  }

  async function togglePush() {
    if (pushActive) {
      const res = await unsubscribeFromPush();
      if (res.success) pushActive = false;
    } else {
      const res = await subscribeToPush();
      if (res.success) pushActive = true;
      else if (res.error) alert(res.error);
    }
  }

  onMount(async () => {
    pushSupported = isPushSupported();
    if (pushSupported) {
      const sub = await getPushSubscription();
      pushActive = !!sub;
    }

    await loadChannels();
    await loadMessages(true);

    // Short-polling for live chat (every 3 seconds when tab is visible)
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadMessages(false);
      }
    }, 3000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  function selectChannel(id: string) {
    activeChannelId = id;
    isLoading = true;
    messages = [];
    replyingTo = null;
    loadMessages(true);
  }

  function formatTime(timestamp: number): string {
    const d = new Date(timestamp * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function getAvatarUrl(userId: string, avatarHash: string | null): string {
    if (avatarHash) {
      return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.webp?size=64`;
    }
    return `https://cdn.discordapp.com/embed/avatars/${parseInt(userId.slice(-2) || '0', 10) % 5}.png`;
  }
</script>

<div class="chat-wrapper">
  <!-- Sidebar Channels -->
  <aside class="chat-sidebar">
    <div class="sidebar-header">
      <span class="hub-title">AnymeX Lounge</span>
      <span class="hub-tag">Support & Chat</span>
    </div>

    <nav class="channel-list">
      {#each channels as chan}
        <button
          type="button"
          class="channel-item"
          class:active={chan.id === activeChannelId}
          onclick={() => selectChannel(chan.id)}
        >
          <span class="channel-hash">#</span>
          <span class="channel-name">{chan.name}</span>
          {#if chan.isStaffOnly}
            <span class="staff-badge">STAFF</span>
          {/if}
        </button>
      {/each}
    </nav>

    <!-- Web Push Controls -->
    {#if pushSupported}
      <div class="push-card">
        <div class="push-info">
          <span class="push-title">Web Push</span>
          <span class="push-status">{pushActive ? 'Active' : 'Disabled'}</span>
        </div>
        <button
          type="button"
          class="push-toggle-btn"
          class:active={pushActive}
          onclick={togglePush}
        >
          {pushActive ? '🔔 Push On' : '🔕 Enable Push'}
        </button>
      </div>
    {/if}
  </aside>

  <!-- Main Chat Pane -->
  <main class="chat-main">
    <header class="chat-header">
      <div class="header-left">
        <span class="header-hash">#</span>
        <h2 class="header-name">{channels.find((c) => c.id === activeChannelId)?.name || activeChannelId}</h2>
        {#if channels.find((c) => c.id === activeChannelId)?.description}
          <span class="header-desc">{channels.find((c) => c.id === activeChannelId)?.description}</span>
        {/if}
      </div>
      <div class="header-right">
        <span class="live-dot" title="Live sync active"></span>
        <span class="live-label">LIVE</span>
      </div>
    </header>

    <!-- Messages Container -->
    <div class="messages-container">
      {#if isLoading && messages.length === 0}
        <div class="chat-empty">Loading messages...</div>
      {:else if messages.length === 0}
        <div class="chat-empty">
          <p class="empty-title">Welcome to #{channels.find((c) => c.id === activeChannelId)?.name}!</p>
          <p class="empty-sub">This is the start of this channel. Be the first to start the conversation!</p>
        </div>
      {:else}
        {#each messages as msg (msg.id)}
          <div
            id="chat-msg-{msg.id}"
            class="chat-message-row"
            class:highlighted={highlightedMessageId === msg.id}
          >
            <!-- Discord-style Reply Reference line directly above -->
            {#if msg.replyTo}
              <div
                class="reply-spine-box"
                onclick={() => msg.replyTo && scrollToMessage(msg.replyTo.id)}
                role="button"
                tabindex="0"
                onkeydown={(e) => e.key === 'Enter' && msg.replyTo && scrollToMessage(msg.replyTo.id)}
              >
                <div class="reply-spine-curve"></div>
                <img
                  src={getAvatarUrl('', msg.replyTo.authorAvatar)}
                  alt=""
                  class="reply-avatar"
                />
                <span class="reply-user">@{msg.replyTo.authorName}</span>
                <span class="reply-text-snippet">{msg.replyTo.body.slice(0, 80)}{msg.replyTo.body.length > 80 ? '...' : ''}</span>
              </div>
            {/if}

            <div class="message-content-wrapper">
              <img
                src={getAvatarUrl(msg.userId, msg.authorAvatar)}
                alt={msg.authorName}
                class="msg-avatar"
              />

              <div class="msg-body-col">
                <div class="msg-header">
                  <span class="author-name" onclick={() => addMention(msg.authorName)} role="button" tabindex="0" onkeydown={() => {}}>{msg.authorName}</span>
                  {#if msg.authorRole && msg.authorRole !== 'member'}
                    <span class="author-badge">{msg.authorRole.toUpperCase()}</span>
                  {/if}
                  <span class="msg-time">{formatTime(msg.createdAt)}</span>
                </div>

                <div class="msg-text">
                  {msg.body}
                </div>

                <!-- Tagged Reports Embeds (#123) -->
                {#if msg.taggedReports && msg.taggedReports.length > 0}
                  <div class="report-embeds-grid">
                    {#each msg.taggedReports as r}
                      <a href="/report/{r.id}" class="report-card-embed" target="_blank" rel="noopener">
                        <div class="report-embed-top">
                          <span class="report-kind-tag {r.kind}">{r.kind}</span>
                          <span class="report-status-tag status-{r.status}">{r.status}</span>
                          <span class="report-votes-tag">▲ {r.votes}</span>
                        </div>
                        <div class="report-embed-title">
                          #{r.id} {r.title}
                        </div>
                      </a>
                    {/each}
                  </div>
                {/if}
              </div>

              <!-- Message Action Hover Buttons -->
              <div class="msg-actions">
                <button
                  type="button"
                  class="action-btn"
                  title="Reply"
                  onclick={() => setReply(msg)}
                >
                  ↩ Reply
                </button>
                <button
                  type="button"
                  class="action-btn"
                  title="Mention"
                  onclick={() => addMention(msg.authorName)}
                >
                  @ Mention
                </button>
              </div>
            </div>
          </div>
        {/each}
        <div bind:this={messagesEndRef}></div>
      {/if}
    </div>

    <!-- Message Composer -->
    <div class="chat-composer-box">
      {#if replyingTo}
        <div class="active-reply-bar">
          <div class="reply-bar-left">
            <span class="reply-icon">↩</span>
            <span>Replying to <strong>@{replyingTo.authorName}</strong>:</span>
            <span class="reply-preview-snip">"{replyingTo.body.slice(0, 60)}{replyingTo.body.length > 60 ? '...' : ''}"</span>
          </div>
          <button type="button" class="cancel-reply-btn" onclick={() => (replyingTo = null)}>✕</button>
        </div>
      {/if}

      {#if currentUser}
        <div class="composer-input-row">
          <textarea
            id="chat-composer-input"
            class="composer-textarea"
            placeholder="Message #{channels.find((c) => c.id === activeChannelId)?.name || 'channel'}... (use @user or #reportId)"
            bind:value={inputText}
            onkeydown={handleKeydown}
            rows="1"
          ></textarea>
          <button
            type="button"
            class="send-btn"
            disabled={!inputText.trim() || isSending}
            onclick={sendMessage}
          >
            {isSending ? '...' : 'Send'}
          </button>
        </div>
      {:else}
        <div class="composer-login-prompt">
          Please <a href="/auth/discord" class="login-link">Sign in with Discord</a> to chat and receive notifications.
        </div>
      {/if}
    </div>
  </main>
</div>

<style>
  .chat-wrapper {
    display: flex;
    height: calc(100vh - 120px);
    min-height: 520px;
    background: var(--surface-1, #13141c);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    border-radius: 12px;
    overflow: hidden;
  }

  /* Sidebar */
  .chat-sidebar {
    width: 240px;
    background: var(--surface-2, #181a24);
    border-right: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    flex-direction: column;
    padding: 1rem;
    gap: 1rem;
  }

  .sidebar-header {
    display: flex;
    flex-direction: column;
  }

  .hub-title {
    font-weight: 700;
    font-size: 1rem;
    color: var(--text-1, #fff);
  }

  .hub-tag {
    font-size: 0.75rem;
    color: var(--text-muted, #8b949e);
  }

  .channel-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
  }

  .channel-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: transparent;
    border: none;
    color: var(--text-muted, #94a3b8);
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
  }

  .channel-item:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-1, #fff);
  }

  .channel-item.active {
    background: rgba(88, 101, 242, 0.18);
    color: #fff;
    font-weight: 600;
  }

  .channel-hash {
    font-size: 1.1rem;
    color: var(--text-muted, #64748b);
  }

  .staff-badge {
    margin-left: auto;
    font-size: 0.65rem;
    background: #ef4444;
    color: #fff;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 700;
  }

  /* Push Card */
  .push-card {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
    border-radius: 8px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .push-info {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
  }

  .push-status {
    color: #10b981;
    font-weight: 600;
  }

  .push-toggle-btn {
    background: #5865f2;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 0.4rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }

  .push-toggle-btn.active {
    background: rgba(16, 185, 129, 0.2);
    color: #10b981;
    border: 1px solid #10b981;
  }

  /* Main Chat */
  .chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--surface-1, #13141c);
    position: relative;
  }

  .chat-header {
    height: 52px;
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 1.25rem;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .header-hash {
    font-size: 1.3rem;
    color: #64748b;
  }

  .header-name {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    color: #fff;
  }

  .header-desc {
    font-size: 0.8rem;
    color: #94a3b8;
    margin-left: 0.5rem;
    padding-left: 0.75rem;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 8px #10b981;
  }

  .live-label {
    font-size: 0.75rem;
    font-weight: 700;
    color: #10b981;
  }

  /* Messages Area */
  .messages-container {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .chat-empty {
    margin: auto;
    text-align: center;
    color: #94a3b8;
  }

  .empty-title {
    font-size: 1.2rem;
    font-weight: 700;
    color: #fff;
    margin-bottom: 0.25rem;
  }

  .empty-sub {
    font-size: 0.85rem;
  }

  /* Row */
  .chat-message-row {
    position: relative;
    padding: 0.4rem 0.6rem;
    border-radius: 8px;
    transition: background 0.1s ease;
  }

  .chat-message-row:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .chat-message-row.highlighted {
    background: rgba(88, 101, 242, 0.25);
    transition: background 0.3s ease;
  }

  /* Discord Spine Reply */
  .reply-spine-box {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-left: 32px;
    margin-bottom: 3px;
    font-size: 0.8rem;
    color: #94a3b8;
    cursor: pointer;
  }

  .reply-spine-box:hover .reply-user {
    text-decoration: underline;
    color: #fff;
  }

  .reply-spine-curve {
    width: 20px;
    height: 10px;
    border-left: 2px solid #4b5563;
    border-top: 2px solid #4b5563;
    border-top-left-radius: 6px;
    margin-right: 2px;
  }

  .reply-avatar {
    width: 16px;
    height: 16px;
    border-radius: 50%;
  }

  .reply-user {
    font-weight: 600;
    color: #cbd5e1;
  }

  .reply-text-snippet {
    color: #64748b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 320px;
  }

  .message-content-wrapper {
    display: flex;
    gap: 0.85rem;
  }

  .msg-avatar {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .msg-body-col {
    flex: 1;
    min-width: 0;
  }

  .msg-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.2rem;
  }

  .author-name {
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    font-size: 0.95rem;
  }

  .author-name:hover {
    text-decoration: underline;
  }

  .author-badge {
    font-size: 0.65rem;
    padding: 1px 5px;
    background: #5865f2;
    color: #fff;
    border-radius: 4px;
    font-weight: 700;
  }

  .msg-time {
    font-size: 0.72rem;
    color: #64748b;
  }

  .msg-text {
    color: #e2e8f0;
    font-size: 0.92rem;
    line-height: 1.45;
    word-break: break-word;
  }

  /* Tagged Reports Grid */
  .report-embeds-grid {
    margin-top: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .report-card-embed {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(88, 101, 242, 0.3);
    border-left: 3px solid #5865f2;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    text-decoration: none;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 380px;
    transition: transform 0.15s, border-color 0.15s;
  }

  .report-card-embed:hover {
    transform: translateY(-1px);
    border-color: #5865f2;
  }

  .report-embed-top {
    display: flex;
    gap: 0.4rem;
    font-size: 0.7rem;
    align-items: center;
  }

  .report-kind-tag {
    text-transform: uppercase;
    font-weight: 700;
    color: #a5b4fc;
  }

  .report-status-tag {
    background: rgba(255, 255, 255, 0.1);
    padding: 1px 6px;
    border-radius: 4px;
    color: #cbd5e1;
    font-weight: 600;
  }

  .report-votes-tag {
    color: #f59e0b;
    font-weight: 700;
    margin-left: auto;
  }

  .report-embed-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: #fff;
  }

  /* Hover Actions */
  .msg-actions {
    display: none;
    position: absolute;
    right: 1rem;
    top: -12px;
    background: var(--surface-2, #181a24);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }

  .chat-message-row:hover .msg-actions {
    display: flex;
  }

  .action-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
  }

  .action-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }

  /* Composer Box */
  .chat-composer-box {
    padding: 0.75rem 1.25rem 1rem;
    background: var(--surface-2, #181a24);
    border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .active-reply-bar {
    background: rgba(88, 101, 242, 0.15);
    border-left: 3px solid #5865f2;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.8rem;
    color: #cbd5e1;
  }

  .reply-bar-left {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .reply-preview-snip {
    color: #94a3b8;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cancel-reply-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    font-weight: 700;
  }

  .composer-input-row {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }

  .composer-textarea {
    flex: 1;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    padding: 0.65rem 0.9rem;
    color: #fff;
    font-size: 0.92rem;
    font-family: inherit;
    resize: none;
    outline: none;
    transition: border-color 0.15s;
  }

  .composer-textarea:focus {
    border-color: #5865f2;
  }

  .send-btn {
    background: #5865f2;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 0.65rem 1.25rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }

  .send-btn:hover:not(:disabled) {
    background: #4752c4;
  }

  .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .composer-login-prompt {
    padding: 0.75rem;
    text-align: center;
    font-size: 0.9rem;
    color: #94a3b8;
  }

  .login-link {
    color: #5865f2;
    font-weight: 600;
    text-decoration: underline;
  }
</style>
