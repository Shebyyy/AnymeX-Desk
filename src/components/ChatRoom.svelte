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
    statusLabel?: string;
    kind: string;
    kindLabel?: string;
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
  let mobileSidebarOpen = $state<boolean>(false);

  // ─────────────────────────────────────────────────────────────
  // # Tag Autocomplete Search Popover
  // ─────────────────────────────────────────────────────────────
  let showReportPicker = $state<boolean>(false);
  let reportSearchQuery = $state<string>('');
  let reportGroups = $state<Record<string, TaggedReport[]>>({ bug: [], suggestion: [], extension: [] });
  let isSearchingReports = $state<boolean>(false);
  let reportDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let tagMatchStart = $state<number>(-1);

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

  async function searchReports(query: string) {
    isSearchingReports = true;
    try {
      const res = await fetch(`/api/chat/reports-search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.ok && data.grouped) {
        reportGroups = data.grouped;
        showReportPicker = true;
      }
    } catch (err) {
      console.error('Failed searching reports:', err);
    } finally {
      isSearchingReports = false;
    }
  }

  function checkInputForReportTag(inputVal: string, cursorPosition: number) {
    const textBeforeCursor = inputVal.slice(0, cursorPosition);
    const match = textBeforeCursor.match(/#([a-zA-Z0-9_\-\s]*)$/);

    if (match && match[0].length <= 30) {
      const query = match[1].trim();
      tagMatchStart = match.index ?? 0;
      reportSearchQuery = query;

      if (reportDebounceTimer) clearTimeout(reportDebounceTimer);
      reportDebounceTimer = setTimeout(() => {
        searchReports(query);
      }, 150);
    } else {
      showReportPicker = false;
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    checkInputForReportTag(target.value, target.selectionStart || target.value.length);
  }

  function selectReportTag(rep: TaggedReport) {
    const inputEl = document.getElementById('chat-composer-input') as HTMLTextAreaElement | null;
    if (!inputEl) return;

    const cursorPos = inputEl.selectionStart || inputText.length;
    const before = inputText.slice(0, tagMatchStart);
    const after = inputText.slice(cursorPos);

    inputText = `${before}#${rep.id} ${after}`;
    showReportPicker = false;

    setTimeout(() => {
      inputEl.focus();
      const newPos = before.length + String(rep.id).length + 2;
      inputEl.setSelectionRange(newPos, newPos);
    }, 30);
  }

  async function sendMessage() {
    if (!inputText.trim() || isSending || !currentUser) return;
    isSending = true;
    showReportPicker = false;

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
    if (e.key === 'Escape') {
      showReportPicker = false;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (showReportPicker) {
        const first = reportGroups.bug[0] || reportGroups.suggestion[0] || reportGroups.extension[0];
        if (first) {
          e.preventDefault();
          selectReportTag(first);
          return;
        }
      }
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

  function openTagPickerDirectly() {
    inputText = inputText ? `${inputText} #` : '#';
    const inputEl = document.getElementById('chat-composer-input') as HTMLTextAreaElement | null;
    if (inputEl) {
      inputEl.focus();
      tagMatchStart = inputText.length - 1;
      searchReports('');
    }
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

    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadMessages(false);
      }
    }, 3000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (reportDebounceTimer) clearTimeout(reportDebounceTimer);
  });

  function selectChannel(id: string) {
    activeChannelId = id;
    mobileSidebarOpen = false;
    isLoading = true;
    messages = [];
    replyingTo = null;
    showReportPicker = false;
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
  <!-- Mobile Backdrop -->
  {#if mobileSidebarOpen}
    <div
      class="mobile-backdrop"
      onclick={() => (mobileSidebarOpen = false)}
      role="button"
      tabindex="0"
      onkeydown={(e) => e.key === 'Escape' && (mobileSidebarOpen = false)}
      aria-label="Close sidebar"
    ></div>
  {/if}

  <!-- Sidebar Channels -->
  <aside class="chat-sidebar" class:mobile-open={mobileSidebarOpen}>
    <div class="sidebar-header">
      <div class="sidebar-title-row">
        <span class="hub-title">AnymeX Lounge</span>
        <button
          type="button"
          class="mobile-close-sidebar-btn"
          onclick={() => (mobileSidebarOpen = false)}
          aria-label="Close channels"
        >
          ✕
        </button>
      </div>
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
          {pushActive ? '🔔 Push Active' : '🔕 Enable Push'}
        </button>
      </div>
    {/if}
  </aside>

  <!-- Main Chat Pane -->
  <main class="chat-main">
    <header class="chat-header">
      <div class="header-left">
        <!-- Mobile Channels Hamburger Button -->
        <button
          type="button"
          class="mobile-channels-toggle-btn"
          onclick={() => (mobileSidebarOpen = !mobileSidebarOpen)}
          aria-label="Open channels"
        >
          <span class="btn-bars">☰</span>
          <span class="btn-chan-name">#{channels.find((c) => c.id === activeChannelId)?.name || 'channels'}</span>
        </button>

        <span class="header-hash desktop-only">#</span>
        <h2 class="header-name desktop-only">{channels.find((c) => c.id === activeChannelId)?.name || activeChannelId}</h2>
        {#if channels.find((c) => c.id === activeChannelId)?.description}
          <span class="header-desc desktop-only">{channels.find((c) => c.id === activeChannelId)?.description}</span>
        {/if}
      </div>

      <div class="header-right">
        {#if pushSupported}
          <button
            type="button"
            class="header-push-icon-btn mobile-only"
            class:active={pushActive}
            onclick={togglePush}
            title={pushActive ? 'Push Notifications Enabled' : 'Enable Push Notifications'}
          >
            {pushActive ? '🔔' : '🔕'}
          </button>
        {/if}
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
          <p class="empty-sub">This is the start of this channel. Say hi or ask a question!</p>
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

    <!-- Message Composer with # Report Tagging Popover -->
    <div class="chat-composer-box">
      <!-- Report Tagging Autocomplete Popover (Kind-wise) -->
      {#if showReportPicker}
        <div class="report-picker-popover">
          <div class="picker-header">
            <span class="picker-title">Tag a Report (Bugs, Suggestions, Extensions)</span>
            <span class="picker-hint">{reportSearchQuery ? `Matching: "${reportSearchQuery}"` : 'Recent reports'}</span>
            <button type="button" class="picker-close" onclick={() => (showReportPicker = false)}>✕</button>
          </div>

          <div class="picker-scroll-body">
            {#if isSearchingReports}
              <div class="picker-loading">Searching reports...</div>
            {:else if !reportGroups.bug.length && !reportGroups.suggestion.length && !reportGroups.extension.length}
              <div class="picker-empty">No reports matching "#{reportSearchQuery}"</div>
            {:else}
              <!-- Kind Section: Bugs -->
              {#if reportGroups.bug.length > 0}
                <div class="picker-kind-section">
                  <div class="kind-section-title kind-bug">🐛 BUGS ({reportGroups.bug.length})</div>
                  {#each reportGroups.bug as rep}
                    <button type="button" class="picker-item" onclick={() => selectReportTag(rep)}>
                      <span class="item-id">#{rep.id}</span>
                      <span class="item-title">{rep.title}</span>
                      <span class="item-status status-{rep.status}">{rep.statusLabel || rep.status}</span>
                      <span class="item-votes">▲ {rep.votes}</span>
                    </button>
                  {/each}
                </div>
              {/if}

              <!-- Kind Section: Suggestions -->
              {#if reportGroups.suggestion.length > 0}
                <div class="picker-kind-section">
                  <div class="kind-section-title kind-suggestion">💡 SUGGESTIONS ({reportGroups.suggestion.length})</div>
                  {#each reportGroups.suggestion as rep}
                    <button type="button" class="picker-item" onclick={() => selectReportTag(rep)}>
                      <span class="item-id">#{rep.id}</span>
                      <span class="item-title">{rep.title}</span>
                      <span class="item-status status-{rep.status}">{rep.statusLabel || rep.status}</span>
                      <span class="item-votes">▲ {rep.votes}</span>
                    </button>
                  {/each}
                </div>
              {/if}

              <!-- Kind Section: Extensions -->
              {#if reportGroups.extension.length > 0}
                <div class="picker-kind-section">
                  <div class="kind-section-title kind-extension">🧩 EXTENSION ISSUES ({reportGroups.extension.length})</div>
                  {#each reportGroups.extension as rep}
                    <button type="button" class="picker-item" onclick={() => selectReportTag(rep)}>
                      <span class="item-id">#{rep.id}</span>
                      <span class="item-title">{rep.title}</span>
                      <span class="item-status status-{rep.status}">{rep.statusLabel || rep.status}</span>
                      <span class="item-votes">▲ {rep.votes}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      {/if}

      {#if replyingTo}
        <div class="active-reply-bar">
          <div class="reply-bar-left">
            <span class="reply-icon">↩</span>
            <span>Replying to <strong>@{replyingTo.authorName}</strong>:</span>
            <span class="reply-preview-snip">"{replyingTo.body.slice(0, 50)}{replyingTo.body.length > 50 ? '...' : ''}"</span>
          </div>
          <button type="button" class="cancel-reply-btn" onclick={() => (replyingTo = null)}>✕</button>
        </div>
      {/if}

      {#if currentUser}
        <div class="composer-input-row">
          <div class="textarea-wrapper">
            <textarea
              id="chat-composer-input"
              class="composer-textarea"
              placeholder="Message #{channels.find((c) => c.id === activeChannelId)?.name || 'channel'}... Type #crash or #12 to tag a report"
              bind:value={inputText}
              oninput={handleInput}
              onkeydown={handleKeydown}
              rows="1"
            ></textarea>
            <!-- Quick Tag Report Helper Button -->
            <button
              type="button"
              class="tag-helper-btn"
              title="Tag a report (#)"
              onclick={openTagPickerDirectly}
            >
              # Tag
            </button>
          </div>

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
    position: relative;
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
    z-index: 20;
    transition: transform 0.25s ease;
  }

  .sidebar-header {
    display: flex;
    flex-direction: column;
  }

  .sidebar-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .mobile-close-sidebar-btn {
    display: none;
    background: none;
    border: none;
    color: #94a3b8;
    font-size: 1.1rem;
    cursor: pointer;
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
    padding: 0.45rem;
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
    min-width: 0;
  }

  .chat-header {
    height: 52px;
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 1rem;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .mobile-channels-toggle-btn {
    display: none;
    align-items: center;
    gap: 0.4rem;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    padding: 0.35rem 0.65rem;
    color: #fff;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .header-push-icon-btn {
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    padding: 0.25rem 0.5rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .header-push-icon-btn.active {
    background: rgba(16, 185, 129, 0.2);
    border-color: #10b981;
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
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .chat-empty {
    margin: auto;
    text-align: center;
    color: #94a3b8;
    padding: 1rem;
  }

  .empty-title {
    font-size: 1.15rem;
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
    padding: 0.4rem 0.5rem;
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
    margin-left: 28px;
    margin-bottom: 3px;
    font-size: 0.78rem;
    color: #94a3b8;
    cursor: pointer;
  }

  .reply-spine-box:hover .reply-user {
    text-decoration: underline;
    color: #fff;
  }

  .reply-spine-curve {
    width: 18px;
    height: 9px;
    border-left: 2px solid #4b5563;
    border-top: 2px solid #4b5563;
    border-top-left-radius: 5px;
    margin-right: 2px;
  }

  .reply-avatar {
    width: 15px;
    height: 15px;
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
    max-width: 240px;
  }

  .message-content-wrapper {
    display: flex;
    gap: 0.75rem;
  }

  .msg-avatar {
    width: 36px;
    height: 36px;
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
    gap: 0.4rem;
    margin-bottom: 0.15rem;
  }

  .author-name {
    font-weight: 600;
    color: #fff;
    cursor: pointer;
    font-size: 0.92rem;
  }

  .author-name:hover {
    text-decoration: underline;
  }

  .author-badge {
    font-size: 0.62rem;
    padding: 1px 5px;
    background: #5865f2;
    color: #fff;
    border-radius: 4px;
    font-weight: 700;
  }

  .msg-time {
    font-size: 0.7rem;
    color: #64748b;
  }

  .msg-text {
    color: #e2e8f0;
    font-size: 0.9rem;
    line-height: 1.4;
    word-break: break-word;
  }

  /* Tagged Reports Grid */
  .report-embeds-grid {
    margin-top: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .report-card-embed {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(88, 101, 242, 0.3);
    border-left: 3px solid #5865f2;
    border-radius: 6px;
    padding: 0.45rem 0.65rem;
    text-decoration: none;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-width: 100%;
    transition: transform 0.15s, border-color 0.15s;
  }

  .report-card-embed:hover {
    border-color: #5865f2;
  }

  .report-embed-top {
    display: flex;
    gap: 0.4rem;
    font-size: 0.68rem;
    align-items: center;
  }

  .report-kind-tag {
    text-transform: uppercase;
    font-weight: 700;
    color: #a5b4fc;
  }

  .report-status-tag {
    background: rgba(255, 255, 255, 0.1);
    padding: 1px 5px;
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
    font-size: 0.82rem;
    font-weight: 600;
    color: #fff;
  }

  /* Hover Actions */
  .msg-actions {
    display: none;
    position: absolute;
    right: 0.5rem;
    top: -10px;
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
    padding: 0.25rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
  }

  .action-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }

  /* Composer Box */
  .chat-composer-box {
    padding: 0.65rem 0.85rem;
    background: var(--surface-2, #181a24);
    border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    position: relative;
  }

  /* Report Picker Popover */
  .report-picker-popover {
    position: absolute;
    bottom: 100%;
    left: 0.85rem;
    right: 0.85rem;
    max-height: 320px;
    background: #181a24;
    border: 1px solid rgba(88, 101, 242, 0.4);
    border-radius: 10px;
    box-shadow: 0 -8px 25px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    z-index: 50;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    background: rgba(255, 255, 255, 0.05);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 0.78rem;
  }

  .picker-title {
    font-weight: 700;
    color: #fff;
  }

  .picker-hint {
    color: #94a3b8;
    font-size: 0.72rem;
  }

  .picker-close {
    background: none;
    border: none;
    color: #94a3b8;
    font-weight: 700;
    cursor: pointer;
  }

  .picker-scroll-body {
    overflow-y: auto;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .picker-loading,
  .picker-empty {
    padding: 1rem;
    text-align: center;
    color: #94a3b8;
    font-size: 0.82rem;
  }

  .picker-kind-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .kind-section-title {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 4px;
    display: inline-block;
  }

  .kind-bug {
    color: #f87171;
    background: rgba(239, 68, 68, 0.12);
  }

  .kind-suggestion {
    color: #60a5fa;
    background: rgba(59, 130, 246, 0.12);
  }

  .kind-extension {
    color: #c084fc;
    background: rgba(168, 85, 247, 0.12);
  }

  .picker-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    color: #e2e8f0;
    text-align: left;
    cursor: pointer;
    font-size: 0.82rem;
    transition: background 0.12s, border-color 0.12s;
  }

  .picker-item:hover {
    background: rgba(88, 101, 242, 0.2);
    border-color: #5865f2;
  }

  .item-id {
    font-weight: 700;
    color: #5865f2;
    min-width: 32px;
  }

  .item-title {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #fff;
  }

  .item-status {
    font-size: 0.68rem;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
    color: #cbd5e1;
    white-space: nowrap;
  }

  .item-votes {
    font-size: 0.72rem;
    color: #f59e0b;
    font-weight: 700;
  }

  .active-reply-bar {
    background: rgba(88, 101, 242, 0.15);
    border-left: 3px solid #5865f2;
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.78rem;
    color: #cbd5e1;
  }

  .reply-bar-left {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    overflow: hidden;
  }

  .reply-preview-snip {
    color: #94a3b8;
    max-width: 200px;
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
    padding: 0 4px;
  }

  .composer-input-row {
    display: flex;
    gap: 0.4rem;
    align-items: flex-end;
  }

  .textarea-wrapper {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
  }

  .composer-textarea {
    width: 100%;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
    border-radius: 8px;
    padding: 0.55rem 3.5rem 0.55rem 0.75rem;
    color: #fff;
    font-size: 0.9rem;
    font-family: inherit;
    resize: none;
    outline: none;
    transition: border-color 0.15s;
    min-height: 38px;
  }

  .composer-textarea:focus {
    border-color: #5865f2;
  }

  .tag-helper-btn {
    position: absolute;
    right: 6px;
    background: rgba(88, 101, 242, 0.18);
    border: 1px solid rgba(88, 101, 242, 0.3);
    color: #a5b4fc;
    border-radius: 5px;
    padding: 2px 7px;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
  }

  .tag-helper-btn:hover {
    background: #5865f2;
    color: #fff;
  }

  .send-btn {
    background: #5865f2;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 0.55rem 1rem;
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 0.15s;
    height: 38px;
  }

  .send-btn:hover:not(:disabled) {
    background: #4752c4;
  }

  .send-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .composer-login-prompt {
    padding: 0.5rem;
    text-align: center;
    font-size: 0.85rem;
    color: #94a3b8;
  }

  .login-link {
    color: #5865f2;
    font-weight: 600;
    text-decoration: underline;
  }

  .desktop-only {
    display: inline-flex;
  }

  .mobile-only {
    display: none;
  }

  /* Responsive Breakpoint for Mobile Screens (< 768px) */
  @media (max-width: 768px) {
    .chat-wrapper {
      height: calc(100vh - 100px);
      min-height: 440px;
      border-radius: 0;
      border-left: none;
      border-right: none;
    }

    .desktop-only {
      display: none !important;
    }

    .mobile-only {
      display: inline-flex !important;
    }

    .mobile-channels-toggle-btn {
      display: inline-flex;
    }

    .mobile-close-sidebar-btn {
      display: inline-block;
    }

    .chat-sidebar {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      width: 260px;
      transform: translateX(-100%);
      box-shadow: 4px 0 20px rgba(0, 0, 0, 0.5);
    }

    .chat-sidebar.mobile-open {
      transform: translateX(0);
    }

    .mobile-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(2px);
      z-index: 15;
    }

    .chat-message-row:hover .msg-actions,
    .chat-message-row .msg-actions {
      display: flex;
      top: auto;
      bottom: -6px;
      right: 0.5rem;
    }
  }
</style>
