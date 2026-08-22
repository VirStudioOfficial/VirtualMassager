// ===============================
// 1) Supabase config
// ===============================
// فقط این دو مقدار را با اطلاعات Supabase خودت عوض کن.
// SECRET KEY را هرگز اینجا قرار نده.
const SUPABASE_URL = "https://oysthmbsfxfgdyldkqwd.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_7RGLJX4gs3cVZAEsEGqPIA_S0fkKVuI";

const sb = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);

const ATTACHMENTS_BUCKET = "chat-attachments";
const TYPING_TIMEOUT_MS = 4000; // how long before a "typing" row is considered stale
const TYPING_PING_MS = 2000;    // how often we refresh our own typing row while typing

// ===============================
// 2) State
// ===============================
let currentUser = null;
let myProfile = null;
let currentChatId = null;
let currentOtherUser = null;
let messagesChannel = null;
let typingChannel = null;
let onlineChannel = null;
let onlineUsers = new Set();
let authMode = "login";
let editingMessageId = null;
let replyingToMessageId = null;
let forwardingMessageId = null;
let pendingAttachment = null; // { file, kind: 'image'|'file' }
let selectedMessageIds = new Set();
let selectionMode = false;
let currentMessagesCache = []; // last loaded messages for the open chat (for reply/forward lookups)
let sendingLock = false; // prevents double-send on rapid double click / double submit
let pc = null;
let localStream = null;
let remoteStream = null;
let currentCallId = null;
let currentCallType = null; // 'voice' | 'video'
let callSignalsChannel = null;
let callStatusChannel = null;
let ringTimeoutId = null;
let incomingCallsChannel = null;
let isMuted = false;
let isCameraOff = false;
let pendingIncomingCall = null; // { call row, caller profile }
let chatsCache = [];          // enriched chat list for sidebar
let typingPingTimer = null;
let typingStaleTimer = null;
let isOtherTyping = false;
let localSeq = 0;             // for temp ids on optimistic messages

// ===============================
// 3) DOM
// ===============================
const $ = (id) => document.getElementById(id);

const authView = $("authView");
const appView = $("appView");
const authForm = $("authForm");
const authButton = $("authButton");
const toggleAuth = $("toggleAuth");
const authSubtitle = $("authSubtitle");

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.style.display = "none", 2500);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("fa-IR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatListTime(date) {
  const d = new Date(date);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("fa-IR", { month: "short", day: "numeric" });
}

function initials(name = "?") {
  return escapeHtml(name.trim().slice(0, 1).toUpperCase() || "?");
}

function avatarHtml(profile, size) {
  if (profile?.avatar_url) {
    return `<img src="${escapeHtml(profile.avatar_url)}" alt="" loading="lazy" decoding="async">`;
  }
  return initials(profile?.display_name || profile?.username || "?");
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ===============================
// 4) Auth - Username + Password
// ===============================
// Supabase Auth internally needs an email for password accounts.
// We generate a hidden internal email from the username.
//
// IMPORTANT:
// Supabase Dashboard -> Authentication -> Providers -> Email
// Turn OFF "Confirm email" for this simple private project.

toggleAuth.addEventListener("click", () => {
  authMode = authMode === "login" ? "register" : "login";
  authButton.textContent = authMode === "login" ? "ورود" : "ثبت‌نام";
  authSubtitle.textContent = authMode === "login"
    ? "با نام کاربری وارد شو"
    : "حساب جدید بساز";
  toggleAuth.textContent = authMode === "login"
    ? "حساب نداری؟ ثبت‌نام کن"
    : "حساب داری؟ وارد شو";
});

function internalEmail(username) {
  return `${username.toLowerCase()}@local.messenger`;
}

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const username = $("username").value.trim().toLowerCase();
  const password = $("password").value;

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    toast("نام کاربری: ۳ تا ۳۰ کاراکتر، فقط حروف انگلیسی، عدد و _");
    return;
  }

  authButton.disabled = true;

  try {
    const email = internalEmail(username);

    if (authMode === "register") {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: { username }
        }
      });

      if (error) throw error;

      if (data.session) {
        toast("حساب ساخته شد!");
      } else {
        toast("حساب ساخته شد. Confirm Email را در Supabase خاموش کن.");
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;
    }
  } catch (error) {
    toast(error.message || "نام کاربری یا رمز عبور اشتباه است.");
  } finally {
    authButton.disabled = false;
  }
});

$("logoutButton").addEventListener("click", async () => {
  try { await sb.rpc("touch_last_seen"); } catch { /* best-effort */ }
  if (currentCallId) await endCall(true);
  cleanupAllChannels();
  await sb.auth.signOut();
});

// Cleans up every realtime channel and timers — called on logout and
// before subscribing to a new chat, to avoid duplicate subscriptions
// and memory leaks (previously channels could pile up across chat switches).
function cleanupAllChannels() {
  if (messagesChannel) { sb.removeChannel(messagesChannel); messagesChannel = null; }
  if (typingChannel) { sb.removeChannel(typingChannel); typingChannel = null; }
  if (onlineChannel) { sb.removeChannel(onlineChannel); onlineChannel = null; }
  if (callSignalsChannel) { sb.removeChannel(callSignalsChannel); callSignalsChannel = null; }
  if (callStatusChannel) { sb.removeChannel(callStatusChannel); callStatusChannel = null; }
  if (incomingCallsChannel) { sb.removeChannel(incomingCallsChannel); incomingCallsChannel = null; }
  clearTimeout(typingPingTimer);
  clearTimeout(typingStaleTimer);
}

// ===============================
// 5) Bootstrap
// ===============================
async function init() {
  const { data } = await sb.auth.getSession();
  await handleSession(data.session);

  sb.auth.onAuthStateChange(async (event, session) => {
    // TOKEN_REFRESHED / USER_UPDATED fire for the same signed-in user and
    // don't need a full re-init (was re-subscribing everything on every
    // token refresh, duplicating realtime work). Only react to real
    // sign-in/sign-out transitions.
    if (event === "TOKEN_REFRESHED" && currentUser) return;
    await handleSession(session);
  });
}

async function handleSession(session) {
  if (!session) {
    cleanupAllChannels();
    currentUser = null;
    myProfile = null;
    currentChatId = null;
    currentOtherUser = null;
    chatsCache = [];
    currentMessagesCache = [];
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }

  currentUser = session.user;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");

  // These three don't depend on each other's results, so run them
  // concurrently instead of one-after-another — was adding up to a
  // noticeably slower "stuck on load" feel, especially on slower connections.
  await Promise.all([
    ensureProfile(),
    loadChats(),
    startPresence()
  ]);
  subscribeToIncomingCalls();
}

async function ensureProfile() {
  const { data, error } = await sb
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (error) {
    toast(error.message);
    return;
  }

  if (data) {
    myProfile = data;
  } else {
    const username = currentUser.user_metadata?.username ||
      `user_${currentUser.id.slice(0, 8)}`;

    const { data: created, error: createError } = await sb
      .from("profiles")
      .insert({
        id: currentUser.id,
        username,
        display_name: username
      })
      .select()
      .single();

    if (createError) {
      toast(createError.message);
      return;
    }

    myProfile = created;
  }

  $("myUsername").textContent = "@" + myProfile.username;
  $("myDisplayName").textContent = myProfile.display_name || myProfile.username;
  $("myAvatar").innerHTML = avatarHtml(myProfile);
}

// ===============================
// 5b) Profile settings
// ===============================
let pendingAvatarFile = null;
let avatarRemoved = false;

function openSettingsModal() {
  if (!myProfile) return;
  $("settingsDisplayName").value = myProfile.display_name || "";
  $("settingsStatus").value = myProfile.status || "";
  $("settingsBio").value = myProfile.bio || "";
  $("bioCharCount").textContent = (myProfile.bio || "").length;
  $("settingsNewPassword").value = "";
  $("settingsConfirmPassword").value = "";
  $("settingsAvatarPreview").innerHTML = avatarHtml(myProfile);
  pendingAvatarFile = null;
  avatarRemoved = false;
  $("settingsModal").classList.remove("hidden");
}

function closeSettingsModal() {
  $("settingsModal").classList.add("hidden");
}

$("openSettings").addEventListener("click", openSettingsModal);
$("settingsButton").addEventListener("click", openSettingsModal);
$("closeSettings").addEventListener("click", closeSettingsModal);
$("cancelSettings").addEventListener("click", closeSettingsModal);

$("settingsBio").addEventListener("input", () => {
  $("bioCharCount").textContent = $("settingsBio").value.length;
});

$("uploadAvatarBtn").addEventListener("click", () => $("avatarInput").click());

$("avatarInput").addEventListener("change", () => {
  const file = $("avatarInput").files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("فقط فایل تصویری مجاز است.");
    return;
  }
  pendingAvatarFile = file;
  avatarRemoved = false;
  $("settingsAvatarPreview").innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
});

$("removeAvatarBtn").addEventListener("click", () => {
  pendingAvatarFile = null;
  avatarRemoved = true;
  $("settingsAvatarPreview").innerHTML = initials(
    $("settingsDisplayName").value || myProfile.username
  );
});

async function uploadAvatar(file) {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "jpg";
  const path = `${currentUser.id}/avatar-${Date.now()}.${ext}`;

  const { error } = await sb.storage.from(ATTACHMENTS_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false
  });

  if (error) throw error;

  const { data } = sb.storage.from(ATTACHMENTS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

$("saveSettings").addEventListener("click", async () => {
  const displayName = $("settingsDisplayName").value.trim();
  const status = $("settingsStatus").value.trim();
  const bio = $("settingsBio").value.trim();
  const newPassword = $("settingsNewPassword").value;
  const confirmPassword = $("settingsConfirmPassword").value;

  if (!displayName) {
    toast("نام نمایشی نمی‌تواند خالی باشد.");
    return;
  }

  if (newPassword || confirmPassword) {
    if (newPassword.length < 6) {
      toast("رمز عبور جدید باید حداقل ۶ کاراکتر باشد.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast("رمز عبور جدید و تکرار آن یکسان نیستند.");
      return;
    }
  }

  const saveBtn = $("saveSettings");
  saveBtn.disabled = true;

  try {
    const updates = {
      display_name: displayName,
      status: status || null,
      bio: bio || null
    };

    if (pendingAvatarFile) {
      updates.avatar_url = await uploadAvatar(pendingAvatarFile);
    } else if (avatarRemoved) {
      updates.avatar_url = null;
    }

    const { data: updated, error } = await sb
      .from("profiles")
      .update(updates)
      .eq("id", currentUser.id)
      .select()
      .single();

    if (error) throw error;

    if (newPassword) {
      const { error: passError } = await sb.auth.updateUser({ password: newPassword });
      if (passError) throw passError;
    }

    myProfile = updated;
    $("myUsername").textContent = "@" + myProfile.username;
    $("myDisplayName").textContent = myProfile.display_name || myProfile.username;
    $("myAvatar").innerHTML = avatarHtml(myProfile);

    toast("تغییرات ذخیره شد.");
    closeSettingsModal();
  } catch (error) {
    toast(error.message || "ذخیره تغییرات ناموفق بود.");
  } finally {
    saveBtn.disabled = false;
  }
});

// ===============================
// 6) Search users
// ===============================
let searchTimer;

$("userSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchUsers, 250);
});

async function searchUsers() {
  const query = $("userSearch").value.trim();
  const box = $("searchResults");

  if (!query) {
    box.innerHTML = "";
    return;
  }

  const { data, error } = await sb
    .from("profiles")
    .select("id, username, display_name, avatar_url")
    .neq("id", currentUser.id)
    .ilike("username", `%${query}%`)
    .limit(10);

  if (error) {
    toast(error.message);
    return;
  }

  box.innerHTML = data.length
    ? data.map(user => `
      <div class="user-result" data-user-id="${user.id}">
        <div class="avatar">${avatarHtml(user)}</div>
        <div>
          <strong>${escapeHtml(user.display_name || user.username)}</strong>
          <small>@${escapeHtml(user.username)}</small>
        </div>
      </div>
    `).join("")
    : `<div class="empty-state">کاربری پیدا نشد</div>`;

  box.querySelectorAll(".user-result").forEach(el => {
    el.addEventListener("click", () => {
      $("userSearch").value = "";
      box.innerHTML = "";
      openOrCreateChat(el.dataset.userId);
    });
  });
}

// ===============================
// 7) Chats
// ===============================
async function loadChats() {
  // Single RPC call replaces what used to be 1 + N*2 separate queries.
  // See get_chat_list() in fix_n1_query.sql — it does the join,
  // last-message, and unread-count work in one query on the server.
  const { data, error } = await sb.rpc("get_chat_list");

  if (error) {
    toast(error.message);
    return;
  }

  const chatList = $("chatList");

  if (!data || !data.length) {
    chatList.innerHTML = `<div class="empty-state" style="padding:25px">هنوز گفتگویی نداری.</div>`;
    chatsCache = [];
    return;
  }

  chatsCache = data.map(row => ({
    chatId: row.chat_id,
    profile: {
      id: row.other_user_id,
      username: row.other_username,
      display_name: row.other_display_name,
      avatar_url: row.other_avatar_url
    },
    lastMessage: row.last_created_at ? {
      content: row.last_content,
      attachment_type: row.last_attachment_type,
      created_at: row.last_created_at,
      sender_id: row.last_sender_id
    } : null,
    unreadCount: row.unread_count || 0
  }));

  renderChatList();
}

function renderChatList() {
  const chatList = $("chatList");

  chatList.innerHTML = chatsCache.map(item => {
    const p = item.profile;
    const lm = item.lastMessage;
    let previewText = "شروع گفتگو کن 👋";

    if (lm) {
      if (lm.content) {
        previewText = (lm.sender_id === currentUser.id ? "شما: " : "") + lm.content;
      } else if (lm.attachment_type === "image") {
        previewText = (lm.sender_id === currentUser.id ? "شما: " : "") + "📷 عکس";
      } else if (lm.attachment_type === "file") {
        previewText = (lm.sender_id === currentUser.id ? "شما: " : "") + "📎 فایل";
      }
    }

    const isTypingHere = isOtherTyping && currentChatId === item.chatId;

    return `
      <div class="chat-item ${currentChatId === item.chatId ? "active" : ""}" data-chat-id="${item.chatId}" data-user-id="${p.id}">
        <div class="avatar">
          ${avatarHtml(p)}
          ${onlineUsers.has(p.id) ? '<span class="online-dot"></span>' : ''}
        </div>
        <div class="info">
          <div class="name-row">
            <div class="name"><span class="truncate">${escapeHtml(p.display_name || p.username)}</span></div>
            <span class="time">${lm ? formatListTime(lm.created_at) : ""}</span>
          </div>
          <div class="preview-row">
            <div class="preview ${isTypingHere ? "typing" : ""}">${isTypingHere ? "در حال نوشتن..." : escapeHtml(previewText)}</div>
            ${item.unreadCount > 0 ? `<span class="unread-badge">${item.unreadCount > 99 ? "99+" : item.unreadCount}</span>` : ""}
          </div>
        </div>
      </div>
    `;
  }).join("");

  chatList.querySelectorAll(".chat-item").forEach(el => {
    el.addEventListener("click", async () => {
      const item = chatsCache.find(c => c.chatId === el.dataset.chatId);
      openChat(el.dataset.chatId, item ? item.profile : await getProfile(el.dataset.userId));
    });
  });
}

async function getProfile(userId) {
  const { data } = await sb
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  return data;
}

async function openOrCreateChat(otherUserId) {
  const { data: mine, error: mineError } = await sb
    .from("chat_members")
    .select("chat_id")
    .eq("user_id", currentUser.id);

  if (mineError) return toast(mineError.message);

  const myChatIds = mine.map(x => x.chat_id);

  if (myChatIds.length) {
    const { data: shared } = await sb
      .from("chat_members")
      .select("chat_id")
      .eq("user_id", otherUserId)
      .in("chat_id", myChatIds)
      .limit(1);

    if (shared?.length) {
      const profile = await getProfile(otherUserId);
      await openChat(shared[0].chat_id, profile);
      return;
    }
  }

  const { data: chat, error: chatError } = await sb
    .from("chats")
    .insert({ type: "private" })
    .select()
    .single();

  if (chatError) return toast(chatError.message);

  const { error: membersError } = await sb
    .from("chat_members")
    .insert([
      { chat_id: chat.id, user_id: currentUser.id },
      { chat_id: chat.id, user_id: otherUserId }
    ]);

  if (membersError) {
    await sb.from("chats").delete().eq("id", chat.id);
    return toast(membersError.message);
  }

  const profile = await getProfile(otherUserId);
  await loadChats();
  await openChat(chat.id, profile);
}

async function openChat(chatId, otherUser) {
  currentChatId = chatId;
  currentOtherUser = otherUser;
  isOtherTyping = false;
  clearAttachment();

  $("chatTitle").textContent = otherUser.display_name || otherUser.username;
  $("chatStatus").textContent = statusTextFor(otherUser);
  $("messageForm").classList.remove("hidden");
  $("voiceCallButton").classList.remove("hidden");
  $("videoCallButton").classList.remove("hidden");

  const headerAvatar = $("chatHeaderAvatar");
  headerAvatar.innerHTML = avatarHtml(otherUser);
  headerAvatar.classList.remove("hidden");

  document.querySelector(".sidebar").classList.add("chat-open");
  $("backButton").classList.remove("hidden");

  document.querySelectorAll(".chat-item").forEach(el => {
    el.classList.toggle("active", el.dataset.chatId === chatId);
  });

  await loadMessages();
  subscribeToMessages();
  subscribeToTyping();
  await markChatAsRead();
}

$("backButton").addEventListener("click", () => {
  document.querySelector(".sidebar").classList.remove("chat-open");
});

// ===============================
// 8) Messages
// ===============================
async function loadMessages() {
  const chatIdAtCall = currentChatId;

  const { data, error } = await sb
    .from("messages")
    .select("id, sender_id, content, attachment_url, attachment_type, attachment_name, created_at, edited_at, read_at, reply_to_id, forwarded_from_id")
    .eq("chat_id", currentChatId)
    .order("created_at", { ascending: true })
    .limit(200);

  // The user may have switched chats while this request was in flight —
  // discard the stale result instead of overwriting the newer chat's messages.
  if (currentChatId !== chatIdAtCall) return;

  if (error) {
    toast(error.message);
    return;
  }

  currentMessagesCache = data || [];
  renderMessages(currentMessagesCache);
}

function findCachedMessage(id) {
  return currentMessagesCache.find(m => m.id === id);
}

function renderMessages(messages) {
  const box = $("messages");

  // Preserve scroll position unless the user is already near the bottom —
  // avoids yanking them to the bottom when an incremental realtime update
  // (edit/delete elsewhere in the list) re-renders while they're reading history.
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  if (!messages.length) {
    box.innerHTML = `<div class="empty-state">اولین پیام رو بفرست 👋</div>`;
  } else {
    box.innerHTML = messages.map(renderMessage).join("");
    attachMessageActions();
  }

  renderTypingIndicator();
  if (wasNearBottom) {
    box.scrollTop = box.scrollHeight;
  }
}

function renderMessage(message) {
  const mine = message.sender_id === currentUser.id;
  const pending = message.id.toString().startsWith("temp-");
  const selected = selectedMessageIds.has(message.id);

  const actionButtons = [
    `<button data-reply="${message.id}">پاسخ</button>`,
    `<button data-forward="${message.id}">فوروارد</button>`
  ];
  if (message.content) {
    actionButtons.push(`<button data-copy="${message.id}">کپی</button>`);
  }
  if (mine && !pending) {
    if (!message.attachment_url) {
      actionButtons.push(`<button data-edit="${message.id}">ویرایش</button>`);
    }
    actionButtons.push(`<button class="delete" data-delete="${message.id}">حذف</button>`);
  }
  const actions = pending ? "" : `<div class="message-actions">${actionButtons.join("")}</div>`;

  let mediaHtml = "";
  if (message.attachment_url) {
    if (message.attachment_type === "image") {
      mediaHtml = `<img class="message-image" src="${escapeHtml(message.attachment_url)}" data-view-image="${escapeHtml(message.attachment_url)}" alt="عکس" loading="lazy" decoding="async">`;
    } else {
      mediaHtml = `
        <a class="message-file" href="${escapeHtml(message.attachment_url)}" target="_blank" rel="noopener" download="${escapeHtml(message.attachment_name || "")}">
          <span class="file-icon">📎</span>
          <span class="file-name">${escapeHtml(message.attachment_name || "فایل")}</span>
        </a>
      `;
    }
  }

  let replyHtml = "";
  if (message.reply_to_id) {
    const original = findCachedMessage(message.reply_to_id);
    if (original) {
      const originalMine = original.sender_id === currentUser.id;
      const originalPreview = original.content
        ? escapeHtml(original.content).slice(0, 80)
        : (original.attachment_type === "image" ? "📷 عکس" : "📎 فایل");
      replyHtml = `
        <div class="reply-quote" data-jump-to="${original.id}">
          <strong>${originalMine ? "شما" : escapeHtml(currentOtherUser?.display_name || currentOtherUser?.username || "")}</strong>
          <span>${originalPreview}</span>
        </div>
      `;
    }
  }

  let forwardHtml = "";
  if (message.forwarded_from_id) {
    forwardHtml = `<div class="forwarded-label">فوروارد شده</div>`;
  }

  const textHtml = message.content
    ? `<div class="message-text">${escapeHtml(message.content)}</div>`
    : "";

  const readTick = mine
    ? `<span class="read-tick ${message.read_at ? "read" : ""}">${message.read_at ? "✓✓" : "✓"}</span>`
    : "";

  const checkboxHtml = selectionMode
    ? `<label class="message-select"><input type="checkbox" data-select-checkbox="${message.id}" ${selected ? "checked" : ""}></label>`
    : "";

  return `
    <div class="message ${mine ? "mine" : ""} ${pending ? "pending" : ""} ${selected ? "selected" : ""}" data-message-id="${message.id}">
      ${checkboxHtml}
      ${forwardHtml}
      ${replyHtml}
      ${mediaHtml}
      ${textHtml}
      <div class="message-meta">
        ${message.edited_at ? "<span>ویرایش‌شده</span>" : ""}
        <span>${formatTime(message.created_at)}</span>
        ${readTick}
      </div>
      ${actions}
    </div>
  `;
}

function attachMessageActions() {
  document.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", async () => {
      editingMessageId = btn.dataset.edit;
      const message = findCachedMessage(editingMessageId) || await getMessage(editingMessageId);
      if (!message) return;
      $("editInput").value = message.content || "";
      $("editModal").classList.remove("hidden");
      $("editInput").focus();
    });
  });

  document.querySelectorAll("[data-delete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("این پیام حذف شود؟")) return;

      const { error } = await sb
        .from("messages")
        .delete()
        .eq("id", btn.dataset.delete)
        .eq("sender_id", currentUser.id);

      if (error) toast(error.message);
    });
  });

  document.querySelectorAll("[data-reply]").forEach(btn => {
    btn.addEventListener("click", () => {
      startReply(btn.dataset.reply);
    });
  });

  document.querySelectorAll("[data-copy]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const message = findCachedMessage(btn.dataset.copy);
      if (!message?.content) return;
      try {
        await navigator.clipboard.writeText(message.content);
        toast("پیام کپی شد.");
      } catch {
        toast("کپی ناموفق بود.");
      }
    });
  });

  document.querySelectorAll("[data-forward]").forEach(btn => {
    btn.addEventListener("click", () => {
      openForwardPicker(btn.dataset.forward);
    });
  });

  document.querySelectorAll("[data-jump-to]").forEach(el => {
    el.addEventListener("click", () => {
      const target = document.querySelector(`[data-message-id="${el.dataset.jumpTo}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("flash-highlight");
        setTimeout(() => target.classList.remove("flash-highlight"), 900);
      }
    });
  });

  document.querySelectorAll("[data-select-checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.selectCheckbox;
      if (cb.checked) selectedMessageIds.add(id);
      else selectedMessageIds.delete(id);
      updateSelectionBar();
    });
  });

  document.querySelectorAll("[data-view-image]").forEach(img => {
    img.addEventListener("click", () => {
      $("imageViewerImg").src = img.dataset.viewImage;
      $("imageViewer").classList.remove("hidden");
    });
  });

  // Long-press / long-click on a message enters selection mode (mobile-friendly multi-select).
  document.querySelectorAll(".message").forEach(el => {
    let pressTimer = null;
    const start = () => {
      pressTimer = setTimeout(() => {
        selectionMode = true;
        selectedMessageIds.add(el.dataset.messageId);
        renderMessages(currentMessagesCache);
      }, 500);
    };
    const cancel = () => clearTimeout(pressTimer);
    el.addEventListener("mousedown", start);
    el.addEventListener("touchstart", start, { passive: true });
    ["mouseup", "mouseleave", "touchend", "touchmove"].forEach(evt => el.addEventListener(evt, cancel));
  });
}

// ---- Reply ----
function startReply(messageId) {
  const message = findCachedMessage(messageId);
  if (!message) return;
  replyingToMessageId = messageId;

  const mine = message.sender_id === currentUser.id;
  const senderName = mine ? "شما" : (currentOtherUser?.display_name || currentOtherUser?.username || "");
  const preview = message.content
    ? message.content.slice(0, 100)
    : (message.attachment_type === "image" ? "📷 عکس" : "📎 فایل");

  $("replyPreviewSender").textContent = senderName;
  $("replyPreviewText").textContent = preview;
  $("replyPreviewContainer").classList.remove("hidden");
  $("messageInput").focus();
}

$("cancelReplyBtn").addEventListener("click", cancelReply);

function cancelReply() {
  replyingToMessageId = null;
  $("replyPreviewContainer").classList.add("hidden");
}

// ---- Forward ----
async function openForwardPicker(messageId) {
  forwardingMessageId = messageId;

  if (!chatsCache.length) {
    toast("گفتگویی برای فوروارد کردن وجود ندارد.");
    return;
  }

  const targetUsername = prompt(
    "برای فوروارد، نام کاربری مقصد را وارد کن:\n" +
    chatsCache.map(c => "@" + c.profile.username).join("، ")
  );
  if (!targetUsername) {
    forwardingMessageId = null;
    return;
  }

  const cleanUsername = targetUsername.trim().replace(/^@/, "").toLowerCase();
  const targetChat = chatsCache.find(c => c.profile.username.toLowerCase() === cleanUsername);

  if (!targetChat) {
    toast("کاربری با این نام در لیست گفتگوهات پیدا نشد.");
    forwardingMessageId = null;
    return;
  }

  await forwardMessage(messageId, targetChat.chatId);
}

async function forwardMessage(messageId, targetChatId) {
  const original = findCachedMessage(messageId);
  if (!original) {
    toast("پیام اصلی پیدا نشد.");
    return;
  }

  const { error } = await sb.from("messages").insert({
    chat_id: targetChatId,
    sender_id: currentUser.id,
    content: original.content,
    attachment_url: original.attachment_url,
    attachment_type: original.attachment_type,
    attachment_name: original.attachment_name,
    forwarded_from_id: original.id
  });

  if (error) toast(error.message);
  else toast("پیام فوروارد شد.");

  forwardingMessageId = null;
}

// ---- Multi-select ----
function updateSelectionBar() {
  const count = selectedMessageIds.size;
  let bar = $("selectionBar");

  if (count === 0) {
    selectionMode = false;
    if (bar) bar.remove();
    renderMessages(currentMessagesCache);
    return;
  }

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "selectionBar";
    bar.className = "selection-bar";
    $("chatHeader").insertAdjacentElement("afterend", bar);
  }

  bar.innerHTML = `
    <span>${count} پیام انتخاب شد</span>
    <div class="selection-actions">
      <button id="deleteSelectedBtn" class="ghost-button danger-text">حذف</button>
      <button id="cancelSelectionBtn" class="ghost-button">لغو</button>
    </div>
  `;

  $("deleteSelectedBtn").onclick = async () => {
    if (!confirm(`${count} پیام حذف شود؟`)) return;
    const ids = Array.from(selectedMessageIds);
    const { error } = await sb
      .from("messages")
      .delete()
      .in("id", ids)
      .eq("sender_id", currentUser.id);
    if (error) toast(error.message);
    selectedMessageIds.clear();
    updateSelectionBar();
  };

  $("cancelSelectionBtn").onclick = () => {
    selectedMessageIds.clear();
    updateSelectionBar();
  };
}

$("imageViewer").addEventListener("click", () => {
  $("imageViewer").classList.add("hidden");
  $("imageViewerImg").src = "";
});

async function getMessage(id) {
  const { data } = await sb
    .from("messages")
    .select("*")
    .eq("id", id)
    .single();
  return data;
}

// ---- Attachment picking ----
$("attachButton").addEventListener("click", () => $("fileInput").click());

$("fileInput").addEventListener("change", () => {
  const file = $("fileInput").files[0];
  if (!file) return;

  if (file.size > 15 * 1024 * 1024) {
    toast("حجم فایل نباید بیشتر از ۱۵ مگابایت باشد.");
    $("fileInput").value = "";
    return;
  }

  const kind = file.type.startsWith("image/") ? "image" : "file";
  pendingAttachment = { file, kind };

  const preview = $("attachmentPreview");
  preview.classList.remove("hidden");

  if (kind === "image") {
    $("attachmentPreviewImg").src = URL.createObjectURL(file);
    $("attachmentPreviewImg").classList.remove("hidden");
    $("attachmentPreviewFile").classList.add("hidden");
  } else {
    $("attachmentPreviewImg").classList.add("hidden");
    $("attachmentPreviewFile").classList.remove("hidden");
    $("attachmentPreviewName").textContent = `${file.name} · ${formatFileSize(file.size)}`;
  }

  $("messageInput").focus();
});

$("removeAttachment").addEventListener("click", clearAttachment);

function clearAttachment() {
  pendingAttachment = null;
  $("fileInput").value = "";
  $("attachmentPreview").classList.add("hidden");
  $("attachmentPreviewImg").src = "";
}

async function uploadAttachment(file) {
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "bin";
  const path = `${currentUser.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await sb.storage.from(ATTACHMENTS_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false
  });

  if (error) throw error;

  const { data } = sb.storage.from(ATTACHMENTS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ---- Sending (optimistic) ----
$("messageForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const input = $("messageInput");
  const content = input.value.trim();
  const attachment = pendingAttachment;

  if (!content && !attachment) return; // prevent empty sends
  if (!currentChatId) return;
  if (sendingLock) return; // prevent duplicate sends from rapid double-submit
  sendingLock = true;

  const replyToId = replyingToMessageId;

  input.value = "";
  clearAttachment();
  clearTyping();
  cancelReply();

  const tempId = `temp-${Date.now()}-${localSeq++}`;
  const box = $("messages");
  const wasEmpty = box.querySelector(".empty-state");
  if (wasEmpty) box.innerHTML = "";

  // Optimistic render — appears instantly, before network/upload finishes.
  const optimisticMessage = {
    id: tempId,
    sender_id: currentUser.id,
    content: content || null,
    attachment_url: attachment && attachment.kind === "image" ? URL.createObjectURL(attachment.file) : null,
    attachment_type: attachment ? attachment.kind : null,
    attachment_name: attachment ? attachment.file.name : null,
    created_at: new Date().toISOString(),
    edited_at: null,
    read_at: null,
    reply_to_id: replyToId || null,
    forwarded_from_id: null
  };

  currentMessagesCache.push(optimisticMessage);
  box.insertAdjacentHTML("beforeend", renderMessage(optimisticMessage));
  attachMessageActions();
  box.scrollTop = box.scrollHeight;

  try {
    let attachment_url = null;
    let attachment_type = null;
    let attachment_name = null;

    if (attachment) {
      attachment_url = await uploadAttachment(attachment.file);
      attachment_type = attachment.kind;
      attachment_name = attachment.file.name;
    }

    const { error } = await sb
      .from("messages")
      .insert({
        chat_id: currentChatId,
        sender_id: currentUser.id,
        content: content || null,
        attachment_url,
        attachment_type,
        attachment_name,
        reply_to_id: replyToId || null
      });

    if (error) throw error;

    // Realtime subscription will re-render with the real row;
    // remove the temp bubble to avoid a duplicate.
    const tempEl = box.querySelector(`[data-message-id="${tempId}"]`);
    if (tempEl) tempEl.remove();
    currentMessagesCache = currentMessagesCache.filter(m => m.id !== tempId);
  } catch (error) {
    toast(error.message || "ارسال پیام ناموفق بود.");
    const tempEl = box.querySelector(`[data-message-id="${tempId}"]`);
    if (tempEl) tempEl.remove();
    currentMessagesCache = currentMessagesCache.filter(m => m.id !== tempId);
  } finally {
    sendingLock = false;
  }

  input.focus();
});

$("saveEdit").addEventListener("click", async () => {
  const content = $("editInput").value.trim();

  if (!content || !editingMessageId) return;

  const { error } = await sb
    .from("messages")
    .update({
      content,
      edited_at: new Date().toISOString()
    })
    .eq("id", editingMessageId)
    .eq("sender_id", currentUser.id);

  if (error) toast(error.message);
  else {
    $("editModal").classList.add("hidden");
    editingMessageId = null;
  }
});

$("cancelEdit").addEventListener("click", () => {
  $("editModal").classList.add("hidden");
  editingMessageId = null;
});

// ---- Read receipts ----
async function markChatAsRead() {
  if (!currentChatId) return;

  await sb
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("chat_id", currentChatId)
    .is("read_at", null)
    .neq("sender_id", currentUser.id);

  const item = chatsCache.find(c => c.chatId === currentChatId);
  if (item) {
    item.unreadCount = 0;
    renderChatList();
  }
}

// ===============================
// 9) Realtime messages
// ===============================
function subscribeToMessages() {
  if (messagesChannel) {
    sb.removeChannel(messagesChannel);
    messagesChannel = null;
  }

  const chatIdAtSubscribe = currentChatId;

  messagesChannel = sb
    .channel(`chat-${currentChatId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "messages",
        filter: `chat_id=eq.${currentChatId}`
      },
      async (payload) => {
        // Guard against a stale event arriving after the user switched chats
        // (race condition when subscriptions overlap during a fast chat switch).
        if (currentChatId !== chatIdAtSubscribe) return;

        if (payload.eventType === "INSERT") {
          const row = payload.new;
          const alreadyHave = currentMessagesCache.some(m => m.id === row.id);
          if (!alreadyHave) {
            currentMessagesCache.push(row);
            renderMessages(currentMessagesCache);
          }
          if (row.sender_id !== currentUser.id) {
            await markChatAsRead();
          }
        } else if (payload.eventType === "UPDATE") {
          const idx = currentMessagesCache.findIndex(m => m.id === payload.new.id);
          if (idx !== -1) {
            currentMessagesCache[idx] = payload.new;
            renderMessages(currentMessagesCache);
          }
        } else if (payload.eventType === "DELETE") {
          currentMessagesCache = currentMessagesCache.filter(m => m.id !== payload.old.id);
          renderMessages(currentMessagesCache);
        }

        // Refresh the sidebar preview/unread-count — don't block message
        // rendering on this network round trip (was causing a visible lag
        // spike on every message on slower connections).
        scheduleLoadChats();
      }
    )
    .subscribe();
}

// Coalesces bursts of loadChats() calls (e.g. several messages arriving
// close together) into a single request instead of one per event.
let loadChatsScheduled = false;
function scheduleLoadChats() {
  if (loadChatsScheduled) return;
  loadChatsScheduled = true;
  setTimeout(async () => {
    loadChatsScheduled = false;
    await loadChats();
  }, 300);
}

// ===============================
// 10) Typing indicator
// ===============================
$("messageInput").addEventListener("input", () => {
  if (!currentChatId) return;
  pingTyping();
});

async function pingTyping() {
  clearTimeout(typingPingTimer);

  await sb
    .from("typing_status")
    .upsert(
      { chat_id: currentChatId, user_id: currentUser.id, updated_at: new Date().toISOString() },
      { onConflict: "chat_id,user_id" }
    );

  typingPingTimer = setTimeout(clearTyping, TYPING_PING_MS);
}

async function clearTyping() {
  clearTimeout(typingPingTimer);
  if (!currentChatId) return;
  await sb
    .from("typing_status")
    .delete()
    .eq("chat_id", currentChatId)
    .eq("user_id", currentUser.id);
}

function subscribeToTyping() {
  if (typingChannel) {
    sb.removeChannel(typingChannel);
  }

  typingChannel = sb
    .channel(`typing-${currentChatId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "typing_status",
        filter: `chat_id=eq.${currentChatId}`
      },
      (payload) => {
        const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
        if (!row || row.user_id === currentUser.id) return;

        if (payload.eventType === "DELETE") {
          setOtherTyping(false);
          return;
        }

        setOtherTyping(true);

        clearTimeout(typingStaleTimer);
        typingStaleTimer = setTimeout(() => setOtherTyping(false), TYPING_TIMEOUT_MS);
      }
    )
    .subscribe();
}

function setOtherTyping(value) {
  if (isOtherTyping === value) return;
  isOtherTyping = value;
  renderTypingIndicator();
  renderChatList();
}

function renderTypingIndicator() {
  const box = $("messages");
  const existing = box.querySelector(".typing-indicator");
  if (existing) existing.remove();

  if (isOtherTyping) {
    box.insertAdjacentHTML("beforeend", `
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    `);
    box.scrollTop = box.scrollHeight;
    $("chatStatus").textContent = "در حال نوشتن...";
  } else if (currentOtherUser) {
    $("chatStatus").textContent = statusTextFor(currentOtherUser);
  }
}

function statusTextFor(profile) {
  if (onlineUsers.has(profile.id)) return "آنلاین";
  if (profile.last_seen) {
    return "آخرین بازدید " + formatListTime(profile.last_seen);
  }
  return "آفلاین";
}

// ===============================
// 11) Online presence
// ===============================
async function startPresence() {
  if (onlineChannel) sb.removeChannel(onlineChannel);

  onlineChannel = sb.channel("online-users", {
    config: { presence: { key: currentUser.id } }
  });

  onlineChannel
    .on("presence", { event: "sync" }, () => {
      const state = onlineChannel.presenceState();
      onlineUsers = new Set(Object.keys(state));
      updateOnlineUI();
    })
    .on("presence", { event: "join" }, ({ key }) => {
      onlineUsers.add(key);
      updateOnlineUI();
    })
    .on("presence", { event: "leave" }, ({ key }) => {
      onlineUsers.delete(key);
      updateOnlineUI();
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await onlineChannel.track({
          user_id: currentUser.id,
          online_at: new Date().toISOString()
        });
      }
    });
}

function updateOnlineUI() {
  if (currentOtherUser && !isOtherTyping) {
    $("chatStatus").textContent = statusTextFor(currentOtherUser);
  }
  renderChatList();
}

// Clean up typing status and record last_seen when leaving the page.
window.addEventListener("beforeunload", () => {
  if (currentChatId && currentUser) {
    navigator.sendBeacon?.(
      `${SUPABASE_URL}/rest/v1/typing_status?chat_id=eq.${currentChatId}&user_id=eq.${currentUser.id}`
    );
  }
  if (currentUser) {
    navigator.sendBeacon?.(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${currentUser.id}`,
      new Blob([JSON.stringify({ last_seen: new Date().toISOString() })], { type: "application/json" })
    );
  }
});

// ===============================
// 12) Voice / Video calls (WebRTC + Supabase Realtime signaling)
// ===============================
// Architecture:
// - `calls` row = one call session (ringing/accepted/rejected/ended/missed).
// - `call_signals` rows = SDP offer/answer + ICE candidates, relayed
//   through Supabase Realtime (Postgres changes). Actual audio/video never
//   touches Supabase — it's peer-to-peer via WebRTC once connected.
// - A public STUN server handles NAT traversal for most home/office networks.
//   For networks behind strict NATs/firewalls a TURN server would be needed;
//   swap RTC_CONFIG below to add one when available.
// - Designed for 1:1 calls today; a future group call can reuse `calls` as
//   the "room" and add a call_participants table (one row per participant)
//   without touching this signaling flow.

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

$("voiceCallButton").addEventListener("click", () => startCall("voice"));
$("videoCallButton").addEventListener("click", () => startCall("video"));

// Caller-side: watch this specific call's row for status changes so we can
// stop ringing / auto-close if the callee rejects, or the call times out.
function subscribeToCallStatus(callId) {
  return sb
    .channel(`call-status-${callId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "calls", filter: `id=eq.${callId}` },
      (payload) => {
        if (payload.new.status === "rejected") {
          toast("تماس رد شد.");
          endCall(false);
        } else if (payload.new.status === "missed") {
          toast("پاسخ داده نشد.");
          endCall(false);
        } else if (payload.new.status === "accepted") {
          stopRingtone();
        }
      }
    )
    .subscribe();
}

async function startCall(callType) {
  if (!currentChatId || !currentOtherUser) return;
  if (currentCallId) {
    toast("در حال حاضر یک تماس فعال داری.");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === "video"
    });
  } catch (err) {
    toast("دسترسی به میکروفون/دوربین داده نشد.");
    return;
  }

  const { data: call, error } = await sb
    .from("calls")
    .insert({
      chat_id: currentChatId,
      caller_id: currentUser.id,
      callee_id: currentOtherUser.id,
      call_type: callType,
      status: "ringing"
    })
    .select()
    .single();

  if (error) {
    toast(error.message || "شروع تماس ناموفق بود.");
    stopLocalStream();
    return;
  }

  currentCallId = call.id;
  currentCallType = callType;

  openCallModal(callType);
  startRingtone("outgoing");
  await createPeerConnection();
  subscribeToCallSignals(call.id);
  callStatusChannel = subscribeToCallStatus(call.id);
  await createAndSendOffer();

  // If nobody answers within 30s, mark the call missed and stop trying.
  clearTimeout(ringTimeoutId);
  ringTimeoutId = setTimeout(async () => {
    if (currentCallId === call.id) {
      await sb.from("calls").update({ status: "missed", ended_at: new Date().toISOString() }).eq("id", call.id);
      toast("پاسخ داده نشد.");
      endCall(false);
    }
  }, 30000);
}

function openCallModal(callType) {
  $("callTitle").textContent = callType === "video" ? "تماس تصویری" : "تماس صوتی";
  $("localVideo").classList.toggle("hidden", callType !== "video");
  $("remoteVideo").classList.toggle("hidden", false);
  $("toggleCamBtn").classList.toggle("hidden", callType !== "video");
  $("callModal").classList.remove("hidden");

  if (localStream) {
    $("localVideo").srcObject = localStream;
  }
}

function closeCallModal() {
  $("callModal").classList.add("hidden");
  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;
}

async function createPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  remoteStream = new MediaStream();
  const remoteVideoEl = $("remoteVideo");
  remoteVideoEl.srcObject = remoteStream;

  // Use event.track directly instead of event.streams[0] — more reliable
  // across browsers/tablets, since some don't reliably populate .streams.
  pc.ontrack = (event) => {
    if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
      remoteStream.addTrack(event.track);
    }
    // Mobile browsers (iOS Safari, some Android WebViews) can silently
    // block autoplay for a stream attached outside a user-gesture handler —
    // explicitly call play() and retry once if it's blocked.
    remoteVideoEl.play().catch(() => {
      toast("برای شنیدن صدا روی صفحه لمس کن.");
      const resume = () => {
        remoteVideoEl.play().catch(() => {});
        document.removeEventListener("touchstart", resume);
        document.removeEventListener("click", resume);
      };
      document.addEventListener("touchstart", resume, { once: true });
      document.addEventListener("click", resume, { once: true });
    });
  };

  pc.onicecandidate = async (event) => {
    if (event.candidate && currentCallId) {
      await sendSignal("ice-candidate", event.candidate.toJSON());
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
      endCall(false);
    }
  };
}

async function createAndSendOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal("offer", offer);
}

async function sendSignal(signalType, payload) {
  if (!currentCallId) return;
  await sb.from("call_signals").insert({
    call_id: currentCallId,
    sender_id: currentUser.id,
    signal_type: signalType,
    payload
  });
}

function subscribeToCallSignals(callId) {
  if (callSignalsChannel) {
    sb.removeChannel(callSignalsChannel);
    callSignalsChannel = null;
  }

  callSignalsChannel = sb
    .channel(`call-signals-${callId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "call_signals", filter: `call_id=eq.${callId}` },
      async (payload) => {
        await handleIncomingSignal(payload.new);
      }
    )
    .subscribe(async (status) => {
      // Critical fix: postgres_changes only streams events from the moment
      // subscribe() completes — it never replays past inserts. The caller's
      // offer (and any ICE candidates sent while the callee was still
      // ringing/deciding) would otherwise be silently missed, so audio/video
      // never connects. Catch up by fetching any signals already in the
      // table for this call as soon as the channel is live.
      if (status === "SUBSCRIBED") {
        const { data: backlog } = await sb
          .from("call_signals")
          .select("*")
          .eq("call_id", callId)
          .neq("sender_id", currentUser.id)
          .order("created_at", { ascending: true });

        for (const row of backlog || []) {
          await handleIncomingSignal(row);
        }
      }
    });
}

async function handleIncomingSignal(row) {
  if (row.sender_id === currentUser.id) return; // ignore our own signal echo
  if (!pc) return; // peer connection not ready yet — shouldn't happen, but guard

  if (row.signal_type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(row.payload));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal("answer", answer);
  } else if (row.signal_type === "answer") {
    if (pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(row.payload));
    }
    stopRingtone();
  } else if (row.signal_type === "ice-candidate") {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(row.payload));
    } catch { /* benign if candidate arrives after close */ }
  } else if (row.signal_type === "hangup") {
    endCall(false);
  }
}

// Listen for incoming calls addressed to me, at all times (not just while a chat is open).
function subscribeToIncomingCalls() {
  if (incomingCallsChannel) {
    sb.removeChannel(incomingCallsChannel);
    incomingCallsChannel = null;
  }

  incomingCallsChannel = sb
    .channel(`incoming-calls-${currentUser.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "calls", filter: `callee_id=eq.${currentUser.id}` },
      async (payload) => {
        if (currentCallId) {
          // Already on a call — auto-decline as busy.
          await sb.from("calls").update({ status: "missed", ended_at: new Date().toISOString() }).eq("id", payload.new.id);
          return;
        }
        await showIncomingCall(payload.new);
      }
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "calls", filter: `callee_id=eq.${currentUser.id}` },
      (payload) => {
        // Caller may have cancelled before we answered.
        if (payload.new.status === "ended" && pendingIncomingCall?.call.id === payload.new.id) {
          dismissIncomingCall();
        }
      }
    )
    .subscribe();
}

// ---- Ringtone (WebAudio-based, no external audio file needed) ----
let ringAudioCtx = null;
let ringIntervalId = null;

function startRingtone(pattern = "incoming") {
  stopRingtone();
  try {
    ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return; // WebAudio unavailable — silently skip, ringtone is non-critical
  }

  const playBeepPair = () => {
    if (!ringAudioCtx) return;
    const now = ringAudioCtx.currentTime;
    [0, 0.28].forEach((offset) => {
      const osc = ringAudioCtx.createOscillator();
      const gain = ringAudioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = pattern === "incoming" ? 880 : 440;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.25);
      osc.connect(gain).connect(ringAudioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.26);
    });
  };

  playBeepPair();
  ringIntervalId = setInterval(playBeepPair, 1800);

  if (navigator.vibrate && pattern === "incoming") {
    navigator.vibrate([400, 200, 400, 200, 400]);
  }
}

function stopRingtone() {
  if (ringIntervalId) {
    clearInterval(ringIntervalId);
    ringIntervalId = null;
  }
  if (ringAudioCtx) {
    ringAudioCtx.close().catch(() => {});
    ringAudioCtx = null;
  }
  navigator.vibrate?.(0);
}

async function showIncomingCall(call) {
  const caller = await getProfile(call.caller_id);
  pendingIncomingCall = { call, caller };

  $("incomingCallAvatar").innerHTML = avatarHtml(caller);
  $("incomingCallTitle").textContent = caller?.display_name || caller?.username || "کاربر";
  $("incomingCallSubtitle").textContent = call.call_type === "video" ? "تماس تصویری ورودی" : "تماس صوتی ورودی";
  $("incomingCallModal").classList.remove("hidden");
  startRingtone("incoming");
}

function dismissIncomingCall() {
  pendingIncomingCall = null;
  stopRingtone();
  $("incomingCallModal").classList.add("hidden");
}

$("acceptCallBtn").addEventListener("click", async () => {
  if (!pendingIncomingCall) return;
  const { call, caller } = pendingIncomingCall;
  dismissIncomingCall();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: call.call_type === "video"
    });
  } catch {
    toast("دسترسی به میکروفون/دوربین داده نشد.");
    await sb.from("calls").update({ status: "rejected", ended_at: new Date().toISOString() }).eq("id", call.id);
    return;
  }

  currentCallId = call.id;
  currentCallType = call.call_type;
  currentOtherUser = currentOtherUser || caller;

  await sb.from("calls").update({ status: "accepted" }).eq("id", call.id);

  openCallModal(call.call_type);
  await createPeerConnection();
  subscribeToCallSignals(call.id);
});

$("rejectCallBtn").addEventListener("click", async () => {
  if (!pendingIncomingCall) return;
  const { call } = pendingIncomingCall;
  dismissIncomingCall();
  await sb.from("calls").update({ status: "rejected", ended_at: new Date().toISOString() }).eq("id", call.id);
});

$("hangUpBtn").addEventListener("click", () => endCall(true));

async function endCall(notifyPeer) {
  stopRingtone();
  clearTimeout(ringTimeoutId);
  if (notifyPeer && currentCallId) {
    await sendSignal("hangup", {});
    await sb.from("calls").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", currentCallId);
  }

  if (callSignalsChannel) {
    sb.removeChannel(callSignalsChannel);
    callSignalsChannel = null;
  }

  if (callStatusChannel) {
    sb.removeChannel(callStatusChannel);
    callStatusChannel = null;
  }

  if (pc) {
    pc.close();
    pc = null;
  }

  stopLocalStream();
  remoteStream = null;
  currentCallId = null;
  currentCallType = null;
  isMuted = false;
  isCameraOff = false;

  closeCallModal();
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
}

$("toggleMuteBtn").addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => { track.enabled = !isMuted; });
  $("toggleMuteBtn").textContent = isMuted ? "🔇" : "🎤";
});

$("toggleCamBtn").addEventListener("click", () => {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach(track => { track.enabled = !isCameraOff; });
  $("toggleCamBtn").textContent = isCameraOff ? "📷" : "كامرا";
});

// Start.
init();
