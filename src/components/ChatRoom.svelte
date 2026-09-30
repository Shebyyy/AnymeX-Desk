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

  interface ReactionItem {
    emoji: string;
    count: number;
    reactedByMe: boolean;
  }

  interface ChatMessage {
    id: number;
    channelId: string;
    userId: string;
    body: string;
    replyToId: number | null;
    createdAt: number;
    updatedAt: number;
    isEdited?: boolean;
    authorName: string;
    authorAvatar: string | null;
    authorRole: string | null;
    replyTo: ReplyInfo | null;
    taggedReports?: TaggedReport[];
    reactions: ReactionItem[];
  }

  interface MentionUser {
    id: string;
    username: string;
    avatarUrl: string;
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
  let textareaRef = $state<HTMLTextAreaElement | null>(null);
  let highlightedMessageId = $state<number | null>(null);
  let mobileSidebarOpen = $state<boolean>(false);

  // Quick reactions palette
  const QUICK_EMOJIS = ['👍', '❤️', '🔥', '😂', '🎉', '👀', '🚀'];

  // Discord-style Context Menu / Long Press Action Sheet
  let activeContextMsg = $state<ChatMessage | null>(null);
  let contextMenuPos = $state<{ x: number; y: number } | null>(null);
  let isMobileSheet = $state<boolean>(false);
  let showCopiedToast = $state<boolean>(false);

  // Quick reaction popup from hover toolbar
  let hoverReactionMsgId = $state<number | null>(null);

  // ─────────────────────────────────────────────────────────────
  // Editing state using main bottom input box (Discord style)
  // ─────────────────────────────────────────────────────────────
  let editingMessage = $state<ChatMessage | null>(null);
  let isSavingEdit = $state<boolean>(false);

  // ─────────────────────────────────────────────────────────────
  // # Tag Autocomplete Search Popover
  // ─────────────────────────────────────────────────────────────
  let showReportPicker = $state<boolean>(false);
  let reportSearchQuery = $state<string>('');
  let reportGroups = $state<Record<string, TaggedReport[]>>({ bug: [], suggestion: [], extension: [] });
  let isSearchingReports = $state<boolean>(false);
  let reportDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let tagMatchStart = $state<number>(-1);
  let selectedReportIndex = $state<number>(0);
  let reportReqSeq = 0;

  // Flattened reports for arrow navigation
  let flattenedReports = $derived.by(() => {
    const list: TaggedReport[] = [];
    if (reportGroups.bug) list.push(...reportGroups.bug);
    if (reportGroups.suggestion) list.push(...reportGroups.suggestion);
    if (reportGroups.extension) list.push(...reportGroups.extension);
    return list;
  });

  // ─────────────────────────────────────────────────────────────
  // @ User Mention Autocomplete Popover
  // ─────────────────────────────────────────────────────────────
  let showUserPicker = $state<boolean>(false);
  let userSearchQuery = $state<string>('');
  let userSearchResults = $state<MentionUser[]>([]);
  let isSearchingUsers = $state<boolean>(false);
  let userDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let userMatchStart = $state<number>(-1);
  let selectedUserIndex = $state<number>(0);
  let userReqSeq = 0;

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

  // ─────────────────────────────────────────────────────────────
  // Auto-resize Textarea
  // ─────────────────────────────────────────────────────────────
  function autoResize() {
    if (!textareaRef) return;
    textareaRef.style.height = 'auto';
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 180) + 'px';
  }

  // ─────────────────────────────────────────────────────────────
  // Report Search API with Sequential Guard & Fast Filtering
  // ─────────────────────────────────────────────────────────────
  async function searchReports(query: string) {
    const seq = ++reportReqSeq;
    isSearchingReports = true;
    try {
      const res = await fetch(`/api/chat/reports-search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (seq === reportReqSeq && data.ok && data.grouped) {
        reportGroups = data.grouped;
        selectedReportIndex = 0;
        showReportPicker = true;
      }
    } catch (err) {
      console.error('Failed searching reports:', err);
    } finally {
      if (seq === reportReqSeq) isSearchingReports = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // User Mention Search API with Sequential Guard & Fast Filtering
  // ─────────────────────────────────────────────────────────────
  async function searchUsers(query: string) {
    const seq = ++userReqSeq;
    isSearchingUsers = true;
    try {
      const res = await fetch(`/users/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (seq === userReqSeq && Array.isArray(data)) {
        userSearchResults = data;
        selectedUserIndex = 0;
        showUserPicker = true;
      }
    } catch (err) {
      console.error('Failed searching users:', err);
    } finally {
      if (seq === userReqSeq) isSearchingUsers = false;
    }
  }

  function checkInputTriggers(inputVal: string, cursorPosition: number) {
    const textBeforeCursor = inputVal.slice(0, cursorPosition);

    // 1. Check for @mention trigger (e.g. "@" or "@sheby", strictly no whitespace)
    const mentionMatch = textBeforeCursor.match(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/);
    if (mentionMatch) {
      const query = mentionMatch[1];
      const atSymbolIndex = textBeforeCursor.lastIndexOf('@');
      userMatchStart = atSymbolIndex;
      userSearchQuery = query;
      showReportPicker = false;

      if (userDebounceTimer) clearTimeout(userDebounceTimer);
      userDebounceTimer = setTimeout(() => {
        searchUsers(query);
      }, 40);
      return;
    } else {
      showUserPicker = false;
    }

    // 2. Check for #report trigger (e.g. "#" or "#cras", strictly no whitespace)
    const reportMatch = textBeforeCursor.match(/(?:^|\s)#([a-zA-Z0-9_\-]*)$/);
    if (reportMatch) {
      const query = reportMatch[1];
      const hashSymbolIndex = textBeforeCursor.lastIndexOf('#');
      tagMatchStart = hashSymbolIndex;
      reportSearchQuery = query;
      showUserPicker = false;

      if (reportDebounceTimer) clearTimeout(reportDebounceTimer);
      reportDebounceTimer = setTimeout(() => {
        searchReports(query);
      }, 40);
      return;
    } else {
      showReportPicker = false;
    }
  }

  function handleInputChange(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    autoResize();
    const cursor = target.selectionStart ?? target.value.length;
    checkInputTriggers(target.value, cursor);
  }

  function selectReport(report: TaggedReport) {
    if (tagMatchStart < 0) return;
    const beforeTag = inputText.slice(0, tagMatchStart);
    const afterCursor = inputText.slice(textareaRef?.selectionStart ?? inputText.length);
    // Insert #ID followed by a space
    inputText = `${beforeTag}#${report.id} ${afterCursor}`;
    showReportPicker = false;
    tagMatchStart = -1;
    reportSearchQuery = '';

    setTimeout(() => {
      if (textareaRef) {
        textareaRef.focus();
        const newCursor = beforeTag.length + `#${report.id} `.length;
        textareaRef.setSelectionRange(newCursor, newCursor);
        autoResize();
      }
    }, 10);
  }

  function selectUser(user: MentionUser) {
    if (userMatchStart < 0) return;
    const beforeMention = inputText.slice(0, userMatchStart);
    const afterCursor = inputText.slice(textareaRef?.selectionStart ?? inputText.length);
    // Insert @username followed by a space
    inputText = `${beforeMention}@${user.username} ${afterCursor}`;
    showUserPicker = false;
    userMatchStart = -1;
    userSearchQuery = '';

    setTimeout(() => {
      if (textareaRef) {
        textareaRef.focus();
        const newCursor = beforeMention.length + `@${user.username} `.length;
        textareaRef.setSelectionRange(newCursor, newCursor);
        autoResize();
      }
    }, 10);
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Navigation inside @ User Mention picker
    if (showUserPicker && userSearchResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedUserIndex = (selectedUserIndex + 1) % userSearchResults.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedUserIndex = (selectedUserIndex - 1 + userSearchResults.length) % userSearchResults.length;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const target = userSearchResults[selectedUserIndex];
        if (target) selectUser(target);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        showUserPicker = false;
        return;
      }
    }

    // Navigation inside # Report Tag picker
    if (showReportPicker && flattenedReports.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedReportIndex = (selectedReportIndex + 1) % flattenedReports.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedReportIndex = (selectedReportIndex - 1 + flattenedReports.length) % flattenedReports.length;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const target = flattenedReports[selectedReportIndex];
        if (target) selectReport(target);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        showReportPicker = false;
        return;
      }
    }

    // Cancel edit or reply with Escape
    if (e.key === 'Escape') {
      if (editingMessage) {
        cancelEditing();
        return;
      }
      if (replyingTo) {
        replyingTo = null;
        return;
      }
    }

    // Enter sends message or saves edit (Shift+Enter inserts newline)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendOrSave();
    }
  }

  function handleSendOrSave() {
    if (editingMessage) {
      saveEdit();
    } else {
      sendMessage();
    }
  }

  async function sendMessage() {
    if (!currentUser) return;
    const body = inputText.trim();
    if (!body || isSending) return;

    isSending = true;
    showReportPicker = false;
    showUserPicker = false;

    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: activeChannelId,
          body,
          replyToId: replyingTo?.id || null,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        inputText = '';
        replyingTo = null;
        if (textareaRef) {
          textareaRef.style.height = 'auto';
        }
        await loadMessages(true);
      } else {
        alert(data.error || 'Failed to send message');
      }
    } catch (err) {
      console.error('Failed sending message:', err);
      alert('Failed sending message');
    } finally {
      isSending = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Discord-style Context Menu / Long Press Sheet Handlers
  // ─────────────────────────────────────────────────────────────
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let touchStartX = 0;
  let touchStartY = 0;

  function handleTouchStart(e: TouchEvent, msg: ChatMessage) {
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    longPressTimer = setTimeout(() => {
      openContextMenu(msg, touch.clientX, touch.clientY);
    }, 400);
  }

  function handleTouchMove(e: TouchEvent) {
    if (!longPressTimer) return;
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - touchStartX) > 10 || Math.abs(touch.clientY - touchStartY) > 10) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function handleTouchEnd() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function handleContextMenu(e: MouseEvent, msg: ChatMessage) {
    e.preventDefault();
    openContextMenu(msg, e.clientX, e.clientY);
  }

  function openContextMenu(msg: ChatMessage, x: number, y: number) {
    activeContextMsg = msg;
    hoverReactionMsgId = null;

    if (window.innerWidth <= 768) {
      isMobileSheet = true;
      contextMenuPos = null;
    } else {
      isMobileSheet = false;
      const menuWidth = 220;
      const menuHeight = 260;
      const clampedX = Math.min(x, window.innerWidth - menuWidth - 10);
      const clampedY = Math.min(y, window.innerHeight - menuHeight - 10);
      contextMenuPos = { x: clampedX, y: clampedY };
    }
  }

  function closeContextMenu() {
    activeContextMsg = null;
    contextMenuPos = null;
  }

  function copyMessageText(msg: ChatMessage) {
    navigator.clipboard.writeText(msg.body);
    closeContextMenu();
    showCopiedToast = true;
    setTimeout(() => {
      showCopiedToast = false;
    }, 2000);
  }

  function triggerReply(msg: ChatMessage) {
    replyingTo = msg;
    editingMessage = null;
    closeContextMenu();
    setTimeout(() => {
      if (textareaRef) textareaRef.focus();
    }, 20);
  }

  // ─────────────────────────────────────────────────────────────
  // Edit in Main Bottom Input Box (Discord / Telegram style)
  // ─────────────────────────────────────────────────────────────
  function startEditing(msg: ChatMessage) {
    editingMessage = msg;
    replyingTo = null;
    inputText = msg.body;
    closeContextMenu();
    setTimeout(() => {
      if (textareaRef) {
        textareaRef.focus();
        textareaRef.setSelectionRange(inputText.length, inputText.length);
        autoResize();
      }
    }, 20);
  }

  function cancelEditing() {
    editingMessage = null;
    inputText = '';
    if (textareaRef) {
      textareaRef.style.height = 'auto';
    }
  }

  async function saveEdit() {
    if (!editingMessage) return;
    const trimmed = inputText.trim();
    if (!trimmed || isSavingEdit) return;

    const id = editingMessage.id;
    isSavingEdit = true;
    try {
      const res = await fetch('/api/chat/messages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, body: trimmed }),
      });
      const data = await res.json();
      if (data.ok) {
        messages = messages.map((m) =>
          m.id === id ? { ...m, body: trimmed, isEdited: true, updatedAt: Math.floor(Date.now() / 1000) } : m,
        );
        cancelEditing();
      } else {
        alert(data.error || 'Failed to edit message');
      }
    } catch (err) {
      console.error('Failed saving edit:', err);
      alert('Failed to edit message');
    } finally {
      isSavingEdit = false;
    }
  }

  async function deleteMessage(id: number) {
    closeContextMenu();
    if (!confirm('Are you sure you want to delete this message? This cannot be undone.')) return;

    try {
      const res = await fetch(`/api/chat/messages?id=${id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.ok) {
        messages = messages.filter((m) => m.id !== id);
      } else {
        alert(data.error || 'Failed to delete message');
      }
    } catch (err) {
      console.error('Failed deleting message:', err);
      alert('Failed to delete message');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Emoji Reactions
  // ─────────────────────────────────────────────────────────────
  async function toggleReaction(messageId: number, emoji: string) {
    if (!currentUser) return;
    hoverReactionMsgId = null;
    closeContextMenu();

    // Optimistic UI update
    messages = messages.map((m) => {
      if (m.id !== messageId) return m;
      const current = m.reactions || [];
      const existing = current.find((r) => r.emoji === emoji);

      let nextReactions: ReactionItem[];
      if (existing) {
        if (existing.reactedByMe) {
          if (existing.count <= 1) {
            nextReactions = current.filter((r) => r.emoji !== emoji);
          } else {
            nextReactions = current.map((r) =>
              r.emoji === emoji ? { ...r, count: r.count - 1, reactedByMe: false } : r,
            );
          }
        } else {
          nextReactions = current.map((r) =>
            r.emoji === emoji ? { ...r, count: r.count + 1, reactedByMe: true } : r,
          );
        }
      } else {
        nextReactions = [...current, { emoji, count: 1, reactedByMe: true }];
      }
      return { ...m, reactions: nextReactions };
    });

    try {
      await fetch('/api/chat/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, emoji }),
      });
    } catch (err) {
      console.error('Failed toggling reaction:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Push Notification Subscription
  // ─────────────────────────────────────────────────────────────
  async function togglePush() {
    if (!pushSupported) return;
    if (pushActive) {
      const ok = await unsubscribeFromPush();
      if (ok) pushActive = false;
    } else {
      const sub = await subscribeToPush();
      if (sub) pushActive = true;
    }
  }

  function handleSelectChannel(id: string) {
    if (activeChannelId === id) return;
    activeChannelId = id;
    mobileSidebarOpen = false;
    isLoading = true;
    loadMessages(true);
  }

  function formatTime(timestamp: number) {
    const d = new Date(timestamp * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderKindBadge(kind: string) {
    switch (kind) {
      case 'bug':
        return { label: 'Bug', icon: '🐛', color: 'var(--red-bright, #f87171)' };
      case 'suggestion':
        return { label: 'Suggestion', icon: '💡', color: 'var(--amber-bright, #fbbf24)' };
      case 'extension':
        return { label: 'Extension', icon: '🧩', color: 'var(--blue-bright, #60a5fa)' };
      default:
        return { label: kind, icon: '📋', color: 'var(--text-secondary)' };
    }
  }

  onMount(async () => {
    await loadChannels();
    await loadMessages(true);

    if (isPushSupported()) {
      pushSupported = true;
      const sub = await getPushSubscription();
      pushActive = !!sub;
    }

    pollTimer = setInterval(() => {
      loadMessages(false);
    }, 4000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (reportDebounceTimer) clearTimeout(reportDebounceTimer);
    if (userDebounceTimer) clearTimeout(userDebounceTimer);
  });
</script>

<svelte:window onclick={() => {
  if (contextMenuPos) closeContextMenu();
  if (hoverReactionMsgId !== null) hoverReactionMsgId = null;
}} />

<div class="chat-wrapper">
  <!-- Mobile Header Drawer Toggle -->
  <div class="chat-mobile-bar">
    <button
      class="mobile-toggle-btn"
      onclick={() => (mobileSidebarOpen = !mobileSidebarOpen)}
      aria-label="Toggle Channels"
    >
      <span class="icon">💬</span>
      <span class="curr-channel-name">#{channels.find((c) => c.id === activeChannelId)?.name || 'channels'}</span>
      <span class="arrow">{mobileSidebarOpen ? '▲' : '▼'}</span>
    </button>
    <div class="chat-mobile-actions">
      {#if pushSupported}
        <button
          class="push-toggle-btn-small"
          class:active={pushActive}
          onclick={togglePush}
          title={pushActive ? 'Disable Push' : 'Enable Push'}
        >
          {pushActive ? '🔔' : '🔕'}
        </button>
      {/if}
    </div>
  </div>

  <div class="chat-body-container">
    <!-- Channel Sidebar / Mobile Drawer -->
    <aside class="chat-sidebar" class:mobile-open={mobileSidebarOpen}>
      <div class="sidebar-header">
        <div class="sidebar-title">
          <span class="title-icon">💬</span>
          <span class="title-text">CHANNELS</span>
        </div>
        {#if pushSupported}
          <button
            class="push-toggle-btn"
            class:active={pushActive}
            onclick={togglePush}
            title={pushActive ? 'Push Notifications Active' : 'Enable Push Notifications'}
          >
            {pushActive ? '🔔 Push On' : '🔕 Push Off'}
          </button>
        {/if}
      </div>

      <div class="channels-list">
        {#each channels as channel (channel.id)}
          <button
            class="channel-item"
            class:active={activeChannelId === channel.id}
            onclick={() => handleSelectChannel(channel.id)}
          >
            <span class="chan-icon">{channel.icon}</span>
            <span class="chan-name">#{channel.name}</span>
            {#if channel.isStaffOnly}
              <span class="staff-badge">STAFF</span>
            {/if}
          </button>
        {/each}
      </div>

      <div class="sidebar-info-card">
        <div class="info-title">💡 Pro Tips</div>
        <div class="info-body">
          <p>• Type <strong>#</strong> to link any bug or suggestion report.</p>
          <p>• Type <strong>@</strong> to mention community members.</p>
          <p>• <strong>Right-click</strong> or <strong>long-press</strong> any message for Discord actions & reactions.</p>
        </div>
      </div>
    </aside>

    <!-- Main Chat Column -->
    <main class="chat-main">
      <!-- Active Channel Banner -->
      <div class="channel-header-bar">
        <div class="chan-meta">
          <span class="chan-hash">#</span>
          <span class="chan-title">{channels.find((c) => c.id === activeChannelId)?.name || activeChannelId}</span>
          {#if channels.find((c) => c.id === activeChannelId)?.description}
            <span class="chan-sep">|</span>
            <span class="chan-desc">{channels.find((c) => c.id === activeChannelId)?.description}</span>
          {/if}
        </div>
      </div>

      <!-- Messages Stream (The ONLY area that scrolls) -->
      <div class="messages-stream" id="messages-stream">
        {#if isLoading}
          <div class="stream-state loading">
            <div class="spinner"></div>
            <span>Loading channel conversation...</span>
          </div>
        {:else if messages.length === 0}
          <div class="stream-state empty">
            <div class="empty-icon">💬</div>
            <h3>Welcome to #{channels.find((c) => c.id === activeChannelId)?.name}!</h3>
            <p>This is the start of this channel. Say hello or share what's on your mind!</p>
          </div>
        {:else}
          {#each messages as msg (msg.id)}
            <div
              id="chat-msg-{msg.id}"
              class="message-row"
              class:highlighted={highlightedMessageId === msg.id}
              class:is-me={currentUser && msg.userId === currentUser.id}
              oncontextmenu={(e) => handleContextMenu(e, msg)}
              ontouchstart={(e) => handleTouchStart(e, msg)}
              ontouchmove={handleTouchMove}
              ontouchend={handleTouchEnd}
            >
              <!-- Reply Spine Connector -->
              {#if msg.replyTo}
                <div class="reply-spine" onclick={() => msg.replyTo && scrollToMessage(msg.replyTo.id)}>
                  <span class="spine-curve">╭─</span>
                  <span class="reply-author">@{msg.replyTo.authorName}:</span>
                  <span class="reply-snippet">{msg.replyTo.body.slice(0, 60)}</span>
                </div>
              {/if}

              <div class="message-content-box">
                <!-- Avatar -->
                <div class="author-avatar-wrap">
                  {#if msg.authorAvatar}
                    <img
                      src="https://cdn.discordapp.com/avatars/{msg.userId}/{msg.authorAvatar}.png?size=48"
                      alt={msg.authorName}
                      class="author-avatar"
                      loading="lazy"
                    />
                  {:else}
                    <div class="author-avatar-fallback">
                      {msg.authorName.slice(0, 2).toUpperCase()}
                    </div>
                  {/if}
                </div>

                <div class="message-inner">
                  <!-- Header: Author Name, Role, Timestamp -->
                  <div class="message-meta">
                    <span class="author-name">{msg.authorName}</span>
                    {#if msg.authorRole && msg.authorRole !== 'member'}
                      <span class="role-tag role-{msg.authorRole}">{msg.authorRole}</span>
                    {/if}
                    <span class="message-time">{formatTime(msg.createdAt)}</span>
                    {#if msg.isEdited}
                      <span class="edited-tag">(edited)</span>
                    {/if}
                  </div>

                  <!-- Message Text Body -->
                  <div class="message-text">
                    {#each msg.body.split(/(@[a-zA-Z0-9_.-]+|#\d+)/g) as part}
                      {#if part.startsWith('@')}
                        <span
                          class="mention-chip"
                          class:mention-me={currentUser && part.toLowerCase() === `@${currentUser.username.toLowerCase()}`}
                        >
                          {part}
                        </span>
                      {:else if part.startsWith('#') && /#\d+$/.test(part)}
                        <a href="/report/{part.slice(1)}" class="report-link-chip" target="_blank">
                          {part}
                        </a>
                      {:else}
                        {part}
                      {/if}
                    {/each}
                  </div>

                  <!-- Embedded Report Cards -->
                  {#if msg.taggedReports && msg.taggedReports.length > 0}
                    <div class="tagged-reports-grid">
                      {#each msg.taggedReports as r (r.id)}
                        {@const badge = renderKindBadge(r.kind)}
                        <a href="/report/{r.id}" class="report-embed-card" target="_blank" rel="noopener">
                          <div class="card-left">
                            <span class="card-kind" style="color: {badge.color}">
                              {badge.icon} #{r.id}
                            </span>
                            <span class="card-title">{r.title}</span>
                          </div>
                          <div class="card-right">
                            <span class="card-votes">▲ {r.votes}</span>
                            <span class="card-status status-{r.status}">{r.status}</span>
                          </div>
                        </a>
                      {/each}
                    </div>
                  {/if}

                  <!-- Emoji Reactions Display -->
                  {#if msg.reactions && msg.reactions.length > 0}
                    <div class="reactions-list">
                      {#each msg.reactions as react}
                        <button
                          class="reaction-pill"
                          class:active={react.reactedByMe}
                          onclick={() => toggleReaction(msg.id, react.emoji)}
                          title="React with {react.emoji}"
                        >
                          <span class="pill-emoji">{react.emoji}</span>
                          <span class="pill-count">{react.count}</span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>

                <!-- Clean Discord-Style Hover Bar (Only 3 icons on Desktop) -->
                <div class="desktop-hover-bar">
                  <!-- Quick Reaction Picker Toggle -->
                  <div class="reaction-trigger-wrap">
                    <button
                      class="hover-icon-btn"
                      onclick={(e) => {
                        e.stopPropagation();
                        hoverReactionMsgId = hoverReactionMsgId === msg.id ? null : msg.id;
                      }}
                      title="Add Reaction"
                    >
                      😊
                    </button>
                    {#if hoverReactionMsgId === msg.id}
                      <div class="hover-emoji-picker" onclick={(e) => e.stopPropagation()}>
                        {#each QUICK_EMOJIS as emoji}
                          <button class="picker-emoji-btn" onclick={() => toggleReaction(msg.id, emoji)}>
                            {emoji}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>

                  <!-- Reply -->
                  <button class="hover-icon-btn" onclick={() => triggerReply(msg)} title="Reply">
                    ↩
                  </button>

                  <!-- More Options (...) -->
                  <button
                    class="hover-icon-btn"
                    onclick={(e) => {
                      e.stopPropagation();
                      openContextMenu(msg, e.clientX, e.clientY);
                    }}
                    title="More Options"
                  >
                    ⋯
                  </button>
                </div>
              </div>
            </div>
          {/each}
        {/if}
        <div bind:this={messagesEndRef} class="stream-bottom-anchor"></div>
      </div>

      <!-- Composer Area (Pinned at Bottom, Always 100% Visible) -->
      <div class="composer-container">
        <!-- @ Mention Autocomplete Popover -->
        {#if showUserPicker && userSearchResults.length > 0}
          <div class="autocomplete-popover mention-popover">
            <div class="popover-header">
              <span class="popover-title">MEMBERS MATCHING <strong>@{userSearchQuery}</strong></span>
              <span class="popover-hint">↑↓ navigate · ↵ select · esc dismiss</span>
            </div>
            <div class="popover-scrollable">
              {#each userSearchResults as u, idx (u.id)}
                <div
                  class="user-suggestion-item"
                  class:selected={idx === selectedUserIndex}
                  onclick={() => selectUser(u)}
                >
                  <img src={u.avatarUrl} alt={u.username} class="user-avatar-mini" />
                  <span class="user-suggestion-name">@{u.username}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- # Report Tag Autocomplete Popover -->
        {#if showReportPicker}
          <div class="autocomplete-popover report-popover">
            <div class="popover-header">
              <span class="popover-title">LINK REPORT MATCHING <strong>#{reportSearchQuery}</strong></span>
              {#if isSearchingReports}
                <span class="popover-spinner">Searching...</span>
              {:else}
                <span class="popover-hint">↑↓ navigate · ↵ select · esc dismiss</span>
              {/if}
            </div>

            <div class="popover-scrollable">
              {#if flattenedReports.length === 0}
                <div class="popover-empty">No reports matching "#{reportSearchQuery}"</div>
              {:else}
                {#if reportGroups.bug && reportGroups.bug.length > 0}
                  <div class="group-heading">🐛 BUGS</div>
                  {#each reportGroups.bug as r (r.id)}
                    {@const isSelected = flattenedReports[selectedReportIndex]?.id === r.id}
                    <div
                      class="report-suggestion-item"
                      class:selected={isSelected}
                      onclick={() => selectReport(r)}
                    >
                      <span class="sugg-id">#{r.id}</span>
                      <span class="sugg-title">{r.title}</span>
                      <span class="sugg-status status-{r.status}">{r.status}</span>
                      <span class="sugg-votes">▲ {r.votes}</span>
                    </div>
                  {/each}
                {/if}

                {#if reportGroups.suggestion && reportGroups.suggestion.length > 0}
                  <div class="group-heading">💡 SUGGESTIONS</div>
                  {#each reportGroups.suggestion as r (r.id)}
                    {@const isSelected = flattenedReports[selectedReportIndex]?.id === r.id}
                    <div
                      class="report-suggestion-item"
                      class:selected={isSelected}
                      onclick={() => selectReport(r)}
                    >
                      <span class="sugg-id">#{r.id}</span>
                      <span class="sugg-title">{r.title}</span>
                      <span class="sugg-status status-{r.status}">{r.status}</span>
                      <span class="sugg-votes">▲ {r.votes}</span>
                    </div>
                  {/each}
                {/if}

                {#if reportGroups.extension && reportGroups.extension.length > 0}
                  <div class="group-heading">🧩 EXTENSIONS</div>
                  {#each reportGroups.extension as r (r.id)}
                    {@const isSelected = flattenedReports[selectedReportIndex]?.id === r.id}
                    <div
                      class="report-suggestion-item"
                      class:selected={isSelected}
                      onclick={() => selectReport(r)}
                    >
                      <span class="sugg-id">#{r.id}</span>
                      <span class="sugg-title">{r.title}</span>
                      <span class="sugg-status status-{r.status}">{r.status}</span>
                      <span class="sugg-votes">▲ {r.votes}</span>
                    </div>
                  {/each}
                {/if}
              {/if}
            </div>
          </div>
        {/if}

        <!-- Active Reply Quoting Bar -->
        {#if replyingTo && !editingMessage}
          <div class="active-reply-bar">
            <span class="reply-icon">↪</span>
            <div class="reply-text">
              Replying to <span class="reply-target">@{replyingTo.authorName}</span>:
              <span class="reply-snippet-quote">"{replyingTo.body.slice(0, 80)}"</span>
            </div>
            <button class="reply-cancel-btn" onclick={() => (replyingTo = null)} aria-label="Cancel reply">
              ✕
            </button>
          </div>
        {/if}

        <!-- Active Message Editing Bar (Discord / Telegram style) -->
        {#if editingMessage}
          <div class="active-edit-bar">
            <div class="edit-bar-left">
              <span class="edit-bar-icon">✏️</span>
              <span class="edit-bar-title">Editing message:</span>
              <span class="edit-bar-snippet">"{editingMessage.body.slice(0, 70)}"</span>
            </div>
            <div class="edit-bar-right">
              <span class="edit-hint-text">esc to cancel · enter to save</span>
              <button class="edit-cancel-btn" onclick={cancelEditing} aria-label="Cancel editing">✕</button>
            </div>
          </div>
        {/if}

        <!-- Input Box (Always Visible) -->
        {#if currentUser}
          <div class="composer-box" class:is-editing={!!editingMessage}>
            <textarea
              bind:this={textareaRef}
              class="composer-textarea"
              placeholder={editingMessage
                ? 'Edit your message...'
                : `Message #${channels.find((c) => c.id === activeChannelId)?.name || 'channel'} (Type # to link report, @ to mention)...`}
              bind:value={inputText}
              rows="1"
              oninput={handleInputChange}
              onkeydown={handleKeyDown}
            ></textarea>
            <button
              class="send-btn"
              class:save-btn={!!editingMessage}
              disabled={!inputText.trim() || isSending || isSavingEdit}
              onclick={handleSendOrSave}
              aria-label={editingMessage ? 'Save edit' : 'Send message'}
              title={editingMessage ? 'Save edit (Enter)' : 'Send message (Enter)'}
            >
              {#if isSending || isSavingEdit}
                <span class="sending-spinner"></span>
              {:else if editingMessage}
                <!-- Checkmark Icon for Save -->
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                </svg>
              {:else}
                <!-- Paper Plane Icon for Send -->
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              {/if}
            </button>
          </div>
        {:else}
          <div class="signin-prompt">
            <span>You must be signed in with Discord to participate in chat.</span>
            <a href="/login" class="login-link">Sign In</a>
          </div>
        {/if}
      </div>
    </main>
  </div>
</div>

<!-- ─────────────────────────────────────────────────────────────
     Discord Context Menu (Desktop Right Click / "..." Menu)
     ───────────────────────────────────────────────────────────── -->
{#if activeContextMsg && contextMenuPos && !isMobileSheet}
  <div
    class="discord-context-menu"
    style="top: {contextMenuPos.y}px; left: {contextMenuPos.x}px;"
    onclick={(e) => e.stopPropagation()}
  >
    <!-- Quick Reactions Row -->
    <div class="context-reactions-bar">
      {#each QUICK_EMOJIS as emoji}
        <button
          class="context-emoji-btn"
          onclick={() => activeContextMsg && toggleReaction(activeContextMsg.id, emoji)}
          title="React {emoji}"
        >
          {emoji}
        </button>
      {/each}
    </div>

    <div class="context-divider"></div>

    <button class="context-menu-item" onclick={() => activeContextMsg && triggerReply(activeContextMsg)}>
      <span class="item-icon">↩</span>
      <span class="item-label">Reply</span>
    </button>

    <button class="context-menu-item" onclick={() => activeContextMsg && copyMessageText(activeContextMsg)}>
      <span class="item-icon">📋</span>
      <span class="item-label">Copy Text</span>
    </button>

    {#if currentUser && (currentUser.id === activeContextMsg.userId || currentUser.isStaff)}
      <div class="context-divider"></div>
      <button class="context-menu-item" onclick={() => activeContextMsg && startEditing(activeContextMsg)}>
        <span class="item-icon">✏️</span>
        <span class="item-label">Edit Message</span>
      </button>
      <button class="context-menu-item danger" onclick={() => activeContextMsg && deleteMessage(activeContextMsg.id)}>
        <span class="item-icon">🗑️</span>
        <span class="item-label">Delete Message</span>
      </button>
    {/if}
  </div>
{/if}

<!-- ─────────────────────────────────────────────────────────────
     Discord Mobile Action Sheet (Mobile Long Press / "..." Menu)
     ───────────────────────────────────────────────────────────── -->
{#if activeContextMsg && isMobileSheet}
  <div class="mobile-sheet-backdrop" onclick={closeContextMenu}>
    <div class="mobile-sheet-card" onclick={(e) => e.stopPropagation()}>
      <div class="sheet-drag-handle"></div>

      <!-- Quick Reactions Row -->
      <div class="sheet-reactions-bar">
        {#each QUICK_EMOJIS as emoji}
          <button
            class="sheet-emoji-btn"
            onclick={() => activeContextMsg && toggleReaction(activeContextMsg.id, emoji)}
          >
            {emoji}
          </button>
        {/each}
      </div>

      <div class="sheet-items-list">
        <button class="sheet-item" onclick={() => activeContextMsg && triggerReply(activeContextMsg)}>
          <span class="sheet-icon">↩</span>
          <span class="sheet-label">Reply</span>
        </button>

        <button class="sheet-item" onclick={() => activeContextMsg && copyMessageText(activeContextMsg)}>
          <span class="sheet-icon">📋</span>
          <span class="sheet-label">Copy Text</span>
        </button>

        {#if currentUser && (currentUser.id === activeContextMsg.userId || currentUser.isStaff)}
          <button class="sheet-item" onclick={() => activeContextMsg && startEditing(activeContextMsg)}>
            <span class="sheet-icon">✏️</span>
            <span class="sheet-label">Edit Message</span>
          </button>
          <button class="sheet-item danger" onclick={() => activeContextMsg && deleteMessage(activeContextMsg.id)}>
            <span class="sheet-icon">🗑️</span>
            <span class="sheet-label">Delete Message</span>
          </button>
        {/if}
      </div>

      <button class="sheet-cancel-btn" onclick={closeContextMenu}>
        Cancel
      </button>
    </div>
  </div>
{/if}

<!-- Copied Toast -->
{#if showCopiedToast}
  <div class="copied-toast">
    <span>✓ Copied to clipboard</span>
  </div>
{/if}

<style>
  .chat-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--bg-surface-1, #0c0d0e);
    color: var(--text-primary, #f4f4f5);
    overflow: hidden;
    position: relative;
  }

  .chat-body-container {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    overflow: hidden;
    position: relative;
  }

  /* ─────────────────────────────────────────────────────────────
     Mobile Bar
     ───────────────────────────────────────────────────────────── */
  .chat-mobile-bar {
    display: none;
    align-items: center;
    justify-content: space-between;
    height: 48px;
    padding: 0 var(--space-4, 16px);
    background: var(--bg-surface-2, #141517);
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
    z-index: 20;
  }

  .mobile-toggle-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    color: var(--text-primary, #fff);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    padding: 6px 10px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.05);
  }

  .push-toggle-btn-small {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text-secondary);
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
  }
  .push-toggle-btn-small.active {
    background: rgba(16, 185, 129, 0.15);
    border-color: rgba(16, 185, 129, 0.4);
    color: #34d399;
  }

  /* ─────────────────────────────────────────────────────────────
     Sidebar
     ───────────────────────────────────────────────────────────── */
  .chat-sidebar {
    width: 250px;
    min-width: 250px;
    max-width: 250px;
    background: var(--bg-surface-2, #121316);
    border-right: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .sidebar-header {
    padding: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
  }

  .sidebar-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    color: var(--text-muted, #71717a);
  }

  .push-toggle-btn {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text-secondary, #a1a1aa);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .push-toggle-btn.active {
    background: rgba(16, 185, 129, 0.15);
    border-color: rgba(16, 185, 129, 0.4);
    color: #34d399;
  }

  .channels-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 8px;
    flex: 1 1 auto;
  }

  .channel-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    border-radius: 8px;
    background: transparent;
    border: none;
    color: var(--text-secondary, #a1a1aa);
    font-size: 14px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    width: 100%;
  }

  .channel-item:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-primary, #fff);
  }

  .channel-item.active {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-primary, #fff);
    font-weight: 600;
  }

  .chan-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .staff-badge {
    font-size: 9px;
    font-weight: 800;
    padding: 2px 5px;
    border-radius: 4px;
    background: rgba(239, 68, 68, 0.2);
    color: #f87171;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .sidebar-info-card {
    margin: 12px;
    padding: 12px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    font-size: 12px;
    color: var(--text-muted, #71717a);
  }

  .info-title {
    font-weight: 700;
    color: var(--text-secondary, #a1a1aa);
    margin-bottom: 6px;
  }

  .info-body p {
    margin: 4px 0;
    line-height: 1.4;
  }

  /* ─────────────────────────────────────────────────────────────
     Main Chat Column
     ───────────────────────────────────────────────────────────── */
  .chat-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-surface-1, #0c0d0e);
    position: relative;
    overflow: hidden;
  }

  .channel-header-bar {
    height: 48px;
    padding: 0 20px;
    display: flex;
    align-items: center;
    background: var(--bg-surface-1, #0c0d0e);
    border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
    z-index: 10;
  }

  .chan-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
  }

  .chan-hash {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-muted, #71717a);
  }

  .chan-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-primary, #fff);
  }

  .chan-sep {
    color: var(--border-subtle, rgba(255, 255, 255, 0.15));
  }

  .chan-desc {
    font-size: 13px;
    color: var(--text-muted, #71717a);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ─────────────────────────────────────────────────────────────
     Messages Stream (The ONLY scrollable container!)
     ───────────────────────────────────────────────────────────── */
  .messages-stream {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overscroll-behavior-y: contain;
  }

  .stream-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin: auto;
    text-align: center;
    color: var(--text-muted, #71717a);
    padding: 40px 20px;
  }

  .stream-state.empty .empty-icon {
    font-size: 40px;
    margin-bottom: 12px;
  }

  .stream-state.empty h3 {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary, #fff);
    margin: 0 0 6px 0;
  }

  .stream-state.loading .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid rgba(255, 255, 255, 0.1);
    border-top-color: var(--accent-gold, #f59e0b);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 10px;
  }

  /* Message Row */
  .message-row {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 6px 10px;
    border-radius: 8px;
    transition: background 0.12s ease;
    user-select: text;
  }

  .message-row:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .message-row:hover .desktop-hover-bar {
    opacity: 1;
    pointer-events: auto;
  }

  .message-row.highlighted {
    background: rgba(245, 158, 11, 0.15);
    box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.4);
  }

  /* Reply Spine */
  .reply-spine {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted, #71717a);
    margin-left: 24px;
    margin-bottom: 3px;
    cursor: pointer;
  }

  .spine-curve {
    font-family: monospace;
    color: var(--border-strong, #52525b);
  }

  .reply-author {
    font-weight: 600;
    color: var(--accent-gold, #f59e0b);
  }

  .reply-snippet {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 400px;
  }

  .message-content-box {
    display: flex;
    gap: 12px;
    position: relative;
  }

  .author-avatar-wrap {
    flex-shrink: 0;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.08);
  }

  .author-avatar {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .author-avatar-fallback {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    color: var(--text-secondary);
  }

  .message-inner {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .message-meta {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .author-name {
    font-size: 14px;
    font-weight: 700;
    color: var(--text-primary, #fff);
  }

  .role-tag {
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 4px;
  }
  .role-tag.role-owner {
    background: rgba(234, 179, 8, 0.2);
    color: #facc15;
    border: 1px solid rgba(234, 179, 8, 0.4);
  }
  .role-tag.role-admin {
    background: rgba(239, 68, 68, 0.2);
    color: #f87171;
    border: 1px solid rgba(239, 68, 68, 0.4);
  }
  .role-tag.role-mod {
    background: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.4);
  }

  .message-time {
    font-size: 11px;
    color: var(--text-muted, #71717a);
  }

  .edited-tag {
    font-size: 10px;
    color: var(--text-muted, #71717a);
    font-style: italic;
  }

  .message-text {
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-secondary, #d4d4d8);
    word-break: break-word;
    white-space: pre-wrap;
  }

  .mention-chip {
    font-weight: 600;
    color: var(--accent-gold, #f59e0b);
    background: rgba(245, 158, 11, 0.1);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .mention-chip.mention-me {
    background: rgba(245, 158, 11, 0.25);
    border: 1px solid rgba(245, 158, 11, 0.5);
    color: #fbbf24;
  }

  .report-link-chip {
    color: #60a5fa;
    background: rgba(96, 165, 250, 0.12);
    padding: 1px 5px;
    border-radius: 4px;
    font-weight: 600;
    text-decoration: none;
  }
  .report-link-chip:hover {
    text-decoration: underline;
  }

  /* Tagged Report Cards */
  .tagged-reports-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
    max-width: 600px;
  }

  .report-embed-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    border-radius: 8px;
    text-decoration: none;
    transition: background 0.12s, border-color 0.12s;
  }

  .report-embed-card:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .card-left {
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
  }

  .card-kind {
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary, #fff);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .card-votes {
    font-size: 11px;
    font-weight: 700;
    color: var(--accent-gold, #f59e0b);
  }

  .card-status {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-secondary);
  }
  .card-status.status-fixed {
    background: rgba(16, 185, 129, 0.2);
    color: #34d399;
  }
  .card-status.status-open {
    background: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
  }
  .card-status.status-in_progress {
    background: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
  }

  /* Reactions List */
  .reactions-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }

  .reaction-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 2px 8px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.12s ease;
  }

  .reaction-pill:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .reaction-pill.active {
    background: rgba(245, 158, 11, 0.18);
    border-color: rgba(245, 158, 11, 0.4);
    color: #fbbf24;
  }

  /* ─────────────────────────────────────────────────────────────
     Discord-style Clean Hover Bar (Desktop)
     ───────────────────────────────────────────────────────────── */
  .desktop-hover-bar {
    position: absolute;
    right: 8px;
    top: -12px;
    display: flex;
    align-items: center;
    background: var(--bg-surface-2, #18191c);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.15));
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
    z-index: 5;
    overflow: visible;
  }

  .hover-icon-btn {
    background: none;
    border: none;
    color: var(--text-secondary, #a1a1aa);
    padding: 4px 7px;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hover-icon-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }

  .reaction-trigger-wrap {
    position: relative;
  }

  .hover-emoji-picker {
    position: absolute;
    bottom: calc(100% + 4px);
    right: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-surface-2, #18191c);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.18));
    border-radius: 8px;
    padding: 4px 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    z-index: 50;
  }

  .picker-emoji-btn {
    background: none;
    border: none;
    font-size: 16px;
    padding: 3px 5px;
    cursor: pointer;
    border-radius: 4px;
    transition: transform 0.1s, background 0.1s;
  }

  .picker-emoji-btn:hover {
    transform: scale(1.25);
    background: rgba(255, 255, 255, 0.1);
  }

  /* ─────────────────────────────────────────────────────────────
     Discord Context Menu (Desktop Right Click)
     ───────────────────────────────────────────────────────────── */
  .discord-context-menu {
    position: fixed;
    width: 220px;
    background: #18191c;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    padding: 6px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .context-reactions-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px;
  }

  .context-emoji-btn {
    background: none;
    border: none;
    font-size: 18px;
    padding: 3px;
    cursor: pointer;
    border-radius: 4px;
    transition: transform 0.1s;
  }
  .context-emoji-btn:hover {
    transform: scale(1.3);
  }

  .context-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.08);
    margin: 4px 2px;
  }

  .context-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    background: none;
    color: var(--text-secondary, #d4d4d8);
    font-size: 13px;
    font-weight: 500;
    border-radius: 5px;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s, color 0.1s;
  }

  .context-menu-item:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }

  .context-menu-item.danger {
    color: #f87171;
  }
  .context-menu-item.danger:hover {
    background: rgba(239, 68, 68, 0.2);
    color: #fca5a5;
  }

  .item-icon {
    font-size: 14px;
    width: 18px;
    text-align: center;
  }

  /* ─────────────────────────────────────────────────────────────
     Discord Mobile Action Sheet (Mobile Long Press)
     ───────────────────────────────────────────────────────────── */
  .mobile-sheet-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }

  .mobile-sheet-card {
    background: #18191c;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 16px 16px 0 0;
    padding: 12px 16px calc(16px + env(safe-area-inset-bottom, 0px)) 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .sheet-drag-handle {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.2);
    margin: 0 auto 4px auto;
  }

  .sheet-reactions-bar {
    display: flex;
    align-items: center;
    justify-content: space-around;
    padding: 6px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .sheet-emoji-btn {
    background: none;
    border: none;
    font-size: 24px;
    padding: 6px;
    cursor: pointer;
  }

  .sheet-items-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .sheet-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    border: none;
    color: #fff;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
  }

  .sheet-item:active {
    background: rgba(255, 255, 255, 0.1);
  }

  .sheet-item.danger {
    color: #f87171;
    background: rgba(239, 68, 68, 0.1);
  }

  .sheet-icon {
    font-size: 18px;
    width: 22px;
  }

  .sheet-cancel-btn {
    padding: 12px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.06);
    border: none;
    color: var(--text-secondary);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    margin-top: 4px;
  }

  @keyframes slideUp {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }

  /* Copied Toast */
  .copied-toast {
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(24, 25, 28, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: #fff;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    z-index: 1100;
  }

  /* ─────────────────────────────────────────────────────────────
     Composer Area (PINNED AT BOTTOM, ALWAYS VISIBLE!)
     ───────────────────────────────────────────────────────────── */
  .composer-container {
    position: relative;
    padding: 12px 20px;
    background: var(--bg-surface-1, #0c0d0e);
    border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
    z-index: 20;
  }

  /* Autocomplete Popovers */
  .autocomplete-popover {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 20px;
    right: 20px;
    max-width: 650px;
    background: var(--bg-surface-2, #141518);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.18));
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
    overflow: hidden;
    z-index: 100;
  }

  .popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    font-size: 11px;
    color: var(--text-muted, #71717a);
  }

  .popover-title strong {
    color: var(--accent-gold, #f59e0b);
  }

  .popover-scrollable {
    max-height: 240px;
    overflow-y: auto;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .popover-empty {
    padding: 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .group-heading {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    padding: 6px 8px 2px 8px;
  }

  /* Autocomplete Items */
  .report-suggestion-item,
  .user-suggestion-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.1s;
  }

  .report-suggestion-item:hover,
  .user-suggestion-item:hover,
  .report-suggestion-item.selected,
  .user-suggestion-item.selected {
    background: rgba(255, 255, 255, 0.08);
  }

  .report-suggestion-item.selected,
  .user-suggestion-item.selected {
    outline: 1px solid var(--accent-gold, #f59e0b);
  }

  .sugg-id {
    font-weight: 700;
    color: var(--accent-gold, #f59e0b);
    min-width: 44px;
  }

  .sugg-title {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #fff;
  }

  .sugg-status {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .sugg-votes {
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 600;
  }

  .user-avatar-mini {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    object-fit: cover;
  }

  .user-suggestion-name {
    font-weight: 600;
    color: #fff;
  }

  /* Active Quoted Reply Bar */
  .active-reply-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(245, 158, 11, 0.08);
    border-left: 3px solid var(--accent-gold, #f59e0b);
    border-radius: 4px;
    font-size: 12px;
  }

  .reply-icon {
    color: var(--accent-gold, #f59e0b);
  }

  .reply-text {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
  }

  .reply-target {
    font-weight: 700;
    color: var(--accent-gold, #f59e0b);
  }

  .reply-snippet-quote {
    color: var(--text-muted);
    margin-left: 4px;
  }

  .reply-cancel-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px 6px;
    font-size: 12px;
  }
  .reply-cancel-btn:hover {
    color: #fff;
  }

  /* Active Message Editing Bar */
  .active-edit-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    background: rgba(59, 130, 246, 0.12);
    border-left: 3px solid #60a5fa;
    border-radius: 4px;
    font-size: 12px;
  }

  .edit-bar-left {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
  }

  .edit-bar-icon {
    font-size: 13px;
  }

  .edit-bar-title {
    font-weight: 700;
    color: #93c5fd;
    white-space: nowrap;
  }

  .edit-bar-snippet {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 350px;
  }

  .edit-bar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .edit-hint-text {
    font-size: 11px;
    color: var(--text-muted);
  }

  .edit-cancel-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px 6px;
    font-size: 12px;
  }
  .edit-cancel-btn:hover {
    color: #fff;
  }

  /* Composer Input Box */
  .composer-box {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--bg-surface-2, #141517);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
    border-radius: 12px;
    padding: 6px 10px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .composer-box:focus-within {
    border-color: var(--accent-gold, #f59e0b);
    box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.2);
  }

  .composer-box.is-editing {
    border-color: #60a5fa;
    box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.3);
  }

  .composer-textarea {
    flex: 1 1 auto;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary, #fff);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.4;
    resize: none;
    max-height: 180px;
    padding: 4px 2px;
  }

  .composer-textarea::placeholder {
    color: var(--text-muted, #71717a);
  }

  .send-btn {
    background: var(--accent-gold, #f59e0b);
    border: none;
    border-radius: 8px;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #000;
    cursor: pointer;
    transition: opacity 0.12s, transform 0.1s, background 0.12s;
    flex-shrink: 0;
  }

  .send-btn.save-btn {
    background: #3b82f6;
    color: #fff;
  }

  .send-btn:hover:not(:disabled) {
    transform: scale(1.05);
  }

  .send-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .signin-prompt {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px dashed rgba(255, 255, 255, 0.15);
    border-radius: 10px;
    font-size: 13px;
    color: var(--text-muted);
  }

  .login-link {
    color: #000;
    background: var(--accent-gold, #f59e0b);
    padding: 4px 12px;
    border-radius: 6px;
    font-weight: 700;
    text-decoration: none;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     Mobile Responsiveness (< 768px)
     ───────────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .chat-mobile-bar {
      display: flex;
    }

    .chat-sidebar {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 50;
      box-shadow: 4px 0 24px rgba(0, 0, 0, 0.8);
      transform: translateX(-100%);
      transition: transform 0.2s ease-in-out;
    }

    .chat-sidebar.mobile-open {
      transform: translateX(0);
    }

    .composer-container {
      padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px)) 12px;
    }

    .messages-stream {
      padding: 10px 12px;
    }

    .desktop-hover-bar {
      display: none;
    }

    .autocomplete-popover {
      left: 8px;
      right: 8px;
    }

    .edit-hint-text {
      display: none;
    }
  }
</style>
