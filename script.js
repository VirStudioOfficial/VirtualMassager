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

// ---- Attachment size limits ----
const MAX_IMAGE_FILE_MB = 15;
const MAX_VIDEO_FILE_MB = 100;     // raw input cap, before compression
const VIDEO_COMPRESS_TARGET_MB = 40; // if the (possibly compressed) result is still bigger than this, we keep compressing/lower bitrate
const VIDEO_COMPRESS_MAX_WIDTH = 1280; // downscale wide videos before re-encoding, faster + smaller

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
let pendingAttachment = null; // { file, kind: 'image'|'video'|'file' }
let videoCompressionInProgress = false;
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
let pendingIceCandidates = [];
let processedSignalIds = new Set();
let callState = 'idle'; // idle | outgoing | ringing | connecting | connected | ending | ended | failed
let callGeneration = 0;
let pendingIncomingCall = null; // { call row, caller profile }
let chatsCache = [];          // enriched chat list for sidebar
let typingPingTimer = null;
let typingStaleTimer = null;
let isOtherTyping = false;
let localSeq = 0;             // for temp ids on optimistic messages
let reactionsChannel = null;
let currentMessageReactions = new Map(); // messageId -> [{ user_id, emoji }]
let showingArchived = false;  // toggles between normal chat list and archived list
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const MUTE_DURATIONS = {
  "1h": 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000
  // "always" is handled separately (far-future timestamp)
};

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
function resetCallSignalingState() {
  pendingIceCandidates = [];
  processedSignalIds.clear();
}

function cleanupAllChannels() {
  if (messagesChannel) { sb.removeChannel(messagesChannel); messagesChannel = null; }
  if (reactionsChannel) { sb.removeChannel(reactionsChannel); reactionsChannel = null; }
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
  applyTheme(myProfile.theme_preference || "system");
}

// ---- Theme ----
function applyTheme(preference) {
  const effective = preference === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : preference;
  document.documentElement.setAttribute("data-theme", effective);

  document.querySelectorAll("#themeSwitch button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === preference);
  });
}

$("themeSwitch").addEventListener("click", async (e) => {
  const preference = e.target.dataset.theme;
  if (!preference) return;
  applyTheme(preference);

  const { error } = await sb
    .from("profiles")
    .update({ theme_preference: preference })
    .eq("id", currentUser.id);

  if (error) return toast(error.message);
  myProfile.theme_preference = preference;
});

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

$("archiveToggleButton").addEventListener("click", async () => {
  showingArchived = true;
  $("archivedBanner").classList.remove("hidden");
  await loadChats();
});

$("backFromArchiveButton").addEventListener("click", async () => {
  showingArchived = false;
  $("archivedBanner").classList.add("hidden");
  await loadChats();
});

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
  // See get_chat_list() in fix_n1_query.sql / feature_additions.sql — it does
  // the join, last-message, unread-count, and pin/mute/archive work server-side.
  const { data, error } = await sb.rpc("get_chat_list", { p_include_archived: showingArchived });

  if (error) {
    toast(error.message);
    return;
  }

  const chatList = $("chatList");
  const rows = showingArchived ? (data || []).filter(row => row.archived_at) : (data || []).filter(row => !row.archived_at);

  if (!rows.length) {
    chatList.innerHTML = `<div class="empty-state" style="padding:25px">${showingArchived ? "آرشیوی نداری." : "هنوز گفتگویی نداری."}</div>`;
    chatsCache = [];
    return;
  }

  chatsCache = rows.map(row => ({
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
    unreadCount: row.unread_count || 0,
    pinnedAt: row.pinned_at,
    archivedAt: row.archived_at,
    mutedUntil: row.muted_until
  }));

  renderChatList();
}

function isChatMuted(item) {
  return !!item.mutedUntil && new Date(item.mutedUntil).getTime() > Date.now();
}

async function togglePinChat(chatId) {
  const item = chatsCache.find(c => c.chatId === chatId);
  if (!item) return;
  const nextValue = item.pinnedAt ? null : new Date().toISOString();
  const { error } = await sb
    .from("chat_members")
    .update({ pinned_at: nextValue })
    .eq("chat_id", chatId)
    .eq("user_id", currentUser.id);
  if (error) return toast(error.message);
  await loadChats();
}

async function setMuteChat(chatId, durationKey) {
  let mutedUntil = null;
  if (durationKey === "always") {
    mutedUntil = new Date("2999-01-01").toISOString();
  } else if (durationKey && MUTE_DURATIONS[durationKey]) {
    mutedUntil = new Date(Date.now() + MUTE_DURATIONS[durationKey]).toISOString();
  } // durationKey === "off" / falsy -> mutedUntil stays null (unmute)

  const { error } = await sb
    .from("chat_members")
    .update({ muted_until: mutedUntil })
    .eq("chat_id", chatId)
    .eq("user_id", currentUser.id);
  if (error) return toast(error.message);
  toast(mutedUntil ? "چت بی‌صدا شد." : "چت باصدا شد.");
  await loadChats();
}

async function toggleArchiveChat(chatId) {
  const item = chatsCache.find(c => c.chatId === chatId);
  if (!item) return;
  const nextValue = item.archivedAt ? null : new Date().toISOString();
  const { error } = await sb
    .from("chat_members")
    .update({ archived_at: nextValue })
    .eq("chat_id", chatId)
    .eq("user_id", currentUser.id);
  if (error) return toast(error.message);
  toast(nextValue ? "چت آرشیو شد." : "چت از آرشیو خارج شد.");
  await loadChats();
}

// "Clear history" = delete for me only. Sets a per-member timestamp; the
// other person's copy of the chat and its messages are untouched.
async function clearChatHistory(chatId) {
  if (!confirm("تاریخچه‌ی این گفتگو فقط برای شما پاک بشه؟ (طرف مقابل هنوز می‌بینه)")) return;

  const { error } = await sb
    .from("chat_members")
    .update({ cleared_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("user_id", currentUser.id);

  if (error) return toast(error.message);

  if (currentChatId === chatId) {
    currentMessagesCache = [];
    renderMessages(currentMessagesCache);
  }
  toast("تاریخچه پاک شد.");
  await loadChats();
}

// "Delete for everyone" = removes the chat row entirely; messages cascade
// with it (see schema). Irreversible for both members, so confirm clearly.
async function deleteChatForEveryone(chatId) {
  if (!confirm("این گفتگو برای هر دو نفر حذف بشه؟ این کار برگشت‌ناپذیره.")) return;

  const { error } = await sb.from("chats").delete().eq("id", chatId);
  if (error) return toast(error.message);

  if (currentChatId === chatId) {
    currentChatId = null;
    currentOtherUser = null;
    $("messages").innerHTML = `<div class="empty-state">از سمت راست یک گفتگو انتخاب کن 👉</div>`;
    $("chatTitle").textContent = "یک گفتگو انتخاب کن";
    $("chatStatus").textContent = "";
    $("messageForm").classList.add("hidden");
    $("voiceCallButton").classList.add("hidden");
    $("videoCallButton").classList.add("hidden");
    $("chatHeaderAvatar").classList.add("hidden");
  }
  toast("گفتگو حذف شد.");
  await loadChats();
}

function renderChatList() {
  const chatList = $("chatList");

  chatList.innerHTML = chatsCache.map(item => {
    const p = item.profile;
    const lm = item.lastMessage;
    let previewText = "شروع گفتگو کن 👋";

    if (lm) {
      const prefix = lm.sender_id === currentUser.id ? "شما: " : "";
      previewText = prefix + messagePreviewLabel(lm);
    }

    const isTypingHere = isOtherTyping && currentChatId === item.chatId;
    const muted = isChatMuted(item);

    return `
      <div class="chat-item ${currentChatId === item.chatId ? "active" : ""} ${item.pinnedAt ? "pinned" : ""}" data-chat-id="${item.chatId}" data-user-id="${p.id}">
        <div class="avatar">
          ${avatarHtml(p)}
          ${onlineUsers.has(p.id) ? '<span class="online-dot"></span>' : ''}
        </div>
        <div class="info">
          <div class="name-row">
            <div class="name">
              ${item.pinnedAt ? '<span class="pin-indicator" title="پین شده">📌</span>' : ""}
              <span class="truncate">${escapeHtml(p.display_name || p.username)}</span>
              ${muted ? '<span class="mute-indicator" title="بی‌صدا">🔕</span>' : ""}
            </div>
            <span class="time">${lm ? formatListTime(lm.created_at) : ""}</span>
          </div>
          <div class="preview-row">
            <div class="preview ${isTypingHere ? "typing" : ""}">${isTypingHere ? "در حال نوشتن..." : escapeHtml(previewText)}</div>
            ${item.unreadCount > 0 ? `<span class="unread-badge ${muted ? "muted" : ""}">${item.unreadCount > 99 ? "99+" : item.unreadCount}</span>` : ""}
          </div>
        </div>
        <button class="icon-button chat-item-menu-btn" data-chat-menu="${item.chatId}" title="گزینه‌ها" type="button">⋮</button>
      </div>
    `;
  }).join("");

  chatList.querySelectorAll(".chat-item").forEach(el => {
    el.addEventListener("click", async (e) => {
      if (e.target.closest("[data-chat-menu]")) return; // menu button handled separately
      const item = chatsCache.find(c => c.chatId === el.dataset.chatId);
      openChat(el.dataset.chatId, item ? item.profile : await getProfile(el.dataset.userId));
    });
  });

  chatList.querySelectorAll("[data-chat-menu]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openChatItemMenu(btn.dataset.chatMenu, btn);
    });
  });
}

// ---- Chat item context menu (pin / mute / archive) ----
function closeChatItemMenu() {
  document.querySelector(".chat-item-menu")?.remove();
  document.removeEventListener("click", closeChatItemMenu);
}

function openChatItemMenu(chatId, anchorEl) {
  closeChatItemMenu();
  const item = chatsCache.find(c => c.chatId === chatId);
  if (!item) return;

  const menu = document.createElement("div");
  menu.className = "chat-item-menu";
  menu.innerHTML = `
    <button data-action="pin">${item.pinnedAt ? "برداشتن پین" : "پین کردن"}</button>
    <button data-action="mute-1h">بی‌صدا ۱ ساعت</button>
    <button data-action="mute-8h">بی‌صدا ۸ ساعت</button>
    <button data-action="mute-24h">بی‌صدا ۲۴ ساعت</button>
    <button data-action="mute-always">بی‌صدا همیشه</button>
    ${isChatMuted(item) ? `<button data-action="unmute">باصدا کردن</button>` : ""}
    <button data-action="archive">${item.archivedAt ? "خروج از آرشیو" : "آرشیو کردن"}</button>
    <div class="chat-item-menu-divider"></div>
    <button data-action="clear" class="danger-text">پاک کردن تاریخچه (فقط برای من)</button>
    <button data-action="delete-everyone" class="danger-text">حذف برای همه</button>
  `;
  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${rect.left + window.scrollX - 140}px`;

  menu.addEventListener("click", async (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    closeChatItemMenu();
    if (action === "pin") await togglePinChat(chatId);
    else if (action === "clear") await clearChatHistory(chatId);
    else if (action === "delete-everyone") await deleteChatForEveryone(chatId);
    else if (action === "archive") await toggleArchiveChat(chatId);
    else if (action === "unmute") await setMuteChat(chatId, "off");
    else if (action.startsWith("mute-")) await setMuteChat(chatId, action.replace("mute-", ""));
  });

  setTimeout(() => document.addEventListener("click", closeChatItemMenu), 0);
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
  subscribeToReactions();
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

  // Fetch this member's own clear-point for the chat, so cleared history
  // stays hidden on this device without affecting the other member.
  const { data: memberRow } = await sb
    .from("chat_members")
    .select("cleared_at")
    .eq("chat_id", currentChatId)
    .eq("user_id", currentUser.id)
    .single();

  if (currentChatId !== chatIdAtCall) return;

  let query = sb
    .from("messages")
    .select("id, sender_id, content, attachment_url, attachment_type, attachment_name, created_at, edited_at, read_at, reply_to_id, forwarded_from_id")
    .eq("chat_id", currentChatId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (memberRow?.cleared_at) {
    query = query.gt("created_at", memberRow.cleared_at);
  }

  const { data, error } = await query;

  // The user may have switched chats while this request was in flight —
  // discard the stale result instead of overwriting the newer chat's messages.
  if (currentChatId !== chatIdAtCall) return;

  if (error) {
    toast(error.message);
    return;
  }

  // Drop messages this user deleted "for me" locally.
  const hiddenIds = await getHiddenMessageIds((data || []).map(m => m.id));
  currentMessagesCache = (data || []).filter(m => !hiddenIds.has(m.id));

  await loadReactionsForChat(currentChatId, chatIdAtCall);
  renderMessages(currentMessagesCache);
}

async function getHiddenMessageIds(messageIds) {
  if (!messageIds.length) return new Set();
  const { data, error } = await sb
    .from("message_hidden_for")
    .select("message_id")
    .eq("user_id", currentUser.id)
    .in("message_id", messageIds);
  if (error) return new Set(); // fail open — better to show a message than crash the view
  return new Set((data || []).map(r => r.message_id));
}


async function loadReactionsForChat(chatId, chatIdAtCall) {
  const ids = currentMessagesCache.map(m => m.id).filter(id => !id.toString().startsWith("temp-"));
  currentMessageReactions = new Map();
  if (!ids.length) return;

  const { data, error } = await sb
    .from("message_reactions")
    .select("message_id, user_id, emoji")
    .in("message_id", ids);

  if (currentChatId !== chatIdAtCall) return; // stale response from a chat switch
  if (error) return; // reactions are non-critical — fail silently, message list still renders

  for (const row of data || []) {
    if (!currentMessageReactions.has(row.message_id)) currentMessageReactions.set(row.message_id, []);
    currentMessageReactions.get(row.message_id).push(row);
  }
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
    renderTypingIndicator();
    return;
  }

  // Full rebuild only when the list was empty/placeholder, or the message
  // count shrank (deletions/clear) — recomputing indices is cheap either way.
  const existingEls = box.querySelectorAll(".message[data-message-id]");
  const existingIds = Array.from(existingEls).map(el => el.dataset.messageId);
  const newIds = messages.map(m => String(m.id));

  const sameOrderPrefix = existingIds.length > 0 &&
    existingIds.every((id, i) => id === newIds[i]);

  if (!sameOrderPrefix) {
    // Structure changed (first load, chat switch, delete, reorder) — full rebuild.
    box.innerHTML = messages.map(renderMessage).join("");
    attachMessageActions();
  } else {
    // Same prefix: only update rows whose content actually changed, and
    // append any new rows at the end. Avoids re-parsing/re-painting the
    // whole message list (which was the main cause of visible lag/jank
    // after every single message, edit, or reaction on longer chats).
    existingEls.forEach((el, i) => {
      const msg = messages[i];
      if (!msg) return;
      const newHtml = renderMessage(msg);
      if (el.outerHTML !== newHtml) {
        el.outerHTML = newHtml;
      }
    });

    if (newIds.length > existingIds.length) {
      const appendedHtml = messages.slice(existingIds.length).map(renderMessage).join("");
      box.insertAdjacentHTML("beforeend", appendedHtml);
    }

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
  const withinDeleteForEveryoneWindow = mine && (Date.now() - new Date(message.created_at).getTime()) <= 48 * 60 * 60 * 1000;

  let mediaHtml = "";
  if (message.attachment_url) {
    if (message.attachment_type === "image") {
      mediaHtml = `<img class="message-image" src="${escapeHtml(message.attachment_url)}" data-view-image="${escapeHtml(message.attachment_url)}" alt="عکس" loading="lazy" decoding="async">`;
    } else if (message.attachment_type === "video") {
      mediaHtml = `
        <div class="message-video-wrap" data-view-video="${escapeHtml(message.attachment_url)}">
          <video src="${escapeHtml(message.attachment_url)}" preload="metadata" muted playsinline></video>
          <div class="message-video-play"><span>▶</span></div>
        </div>
      `;
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
        : escapeHtml(messagePreviewLabel(original));
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

  const reactionsForMessage = currentMessageReactions.get(message.id) || [];
  const reactionHtml = reactionsForMessage.length ? renderReactionChips(message.id, reactionsForMessage) : "";

  return `
    <div class="message ${mine ? "mine" : ""} ${pending ? "pending" : ""} ${selected ? "selected" : ""}"
         data-message-id="${message.id}"
         data-ctx-menu="1"
         data-ctx-mine="${mine ? "1" : "0"}"
         data-ctx-pending="${pending ? "1" : "0"}"
         data-ctx-has-content="${message.content ? "1" : "0"}"
         data-ctx-has-attachment="${message.attachment_url ? "1" : "0"}"
         data-ctx-can-delete-everyone="${withinDeleteForEveryoneWindow ? "1" : "0"}">
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
      ${reactionHtml}
    </div>
  `;
}

// Shared short label for a message when it's referenced elsewhere (reply
// quotes, reply-preview bar, sidebar last-message line) — covers every
// attachment type so location/contact messages don't fall through to a
// generic or misleading label.
function messagePreviewLabel(message) {
  if (message.content) return message.content;
  switch (message.attachment_type) {
    case "image": return "📷 عکس";
    case "video": return "🎥 ویدیو";
    default: return "📎 فایل";
  }
}

// Groups reactions by emoji into small tappable chips, e.g. "👍 2" — highlighted
// if the current user is among the reactors (tapping toggles their own reaction off).
function renderReactionChips(messageId, reactions) {
  const counts = new Map();
  for (const r of reactions) {
    if (!counts.has(r.emoji)) counts.set(r.emoji, []);
    counts.get(r.emoji).push(r.user_id);
  }
  const chips = [...counts.entries()].map(([emoji, userIds]) => {
    const mineReacted = userIds.includes(currentUser.id);
    return `<button class="reaction-chip ${mineReacted ? "mine" : ""}" data-reaction-chip="${messageId}" data-emoji="${emoji}">${emoji} <span>${userIds.length}</span></button>`;
  }).join("");
  return `<div class="reaction-row">${chips}</div>`;
}

// ---- Message context menu (right-click / long-press) ----
// Replaces the old always-visible hover action row with a proper context
// menu: a quick-reaction strip above a dropdown of actions, matching the
// reference messenger UI (reply / edit / copy image / copy text / pin /
// download / forward / select / delete, with delete set apart in red).
let activeContextMenuMessageId = null;

function closeMessageContextMenu() {
  document.querySelector(".msg-context-menu")?.remove();
  document.querySelector(".msg-context-backdrop")?.remove();
  activeContextMenuMessageId = null;
  document.removeEventListener("keydown", handleContextMenuEscape);
}

function handleContextMenuEscape(e) {
  if (e.key === "Escape") closeMessageContextMenu();
}

function openMessageContextMenu(messageEl, clientX, clientY) {
  closeMessageContextMenu();
  document.querySelector(".reaction-picker")?.remove();

  const messageId = messageEl.dataset.messageId;
  const mine = messageEl.dataset.ctxMine === "1";
  const pending = messageEl.dataset.ctxPending === "1";
  if (pending) return; // nothing to do on an optimistic bubble that hasn't landed yet

  const hasContent = messageEl.dataset.ctxHasContent === "1";
  const hasAttachment = messageEl.dataset.ctxHasAttachment === "1";
  const isImage = messageEl.querySelector(".message-image") !== null;
  const canDeleteEveryone = messageEl.dataset.ctxCanDeleteEveryone === "1";
  activeContextMenuMessageId = messageId;

  const myReaction = (currentMessageReactions.get(messageId) || []).find(r => r.user_id === currentUser.id);

  // Invisible backdrop so any outside click/tap closes the menu.
  const backdrop = document.createElement("div");
  backdrop.className = "msg-context-backdrop";
  backdrop.addEventListener("click", closeMessageContextMenu);
  backdrop.addEventListener("contextmenu", (e) => { e.preventDefault(); closeMessageContextMenu(); });
  document.body.appendChild(backdrop);

  const wrap = document.createElement("div");
  wrap.className = "msg-context-menu";

  const reactionStrip = `
    <div class="msg-context-reactions">
      ${REACTION_EMOJIS.map(e => `<button data-ctx-emoji="${e}" class="${myReaction?.emoji === e ? "mine" : ""}">${e}</button>`).join("")}
    </div>
  `;

  const items = [];
  items.push({ action: "reply", icon: "↩", label: "پاسخ" });
  if (mine && !hasAttachment) items.push({ action: "edit", icon: "✎", label: "ویرایش" });
  if (isImage) items.push({ action: "copy-image", icon: "🖼", label: "کپی تصویر" });
  if (hasContent) items.push({ action: "copy", icon: "⧉", label: "کپی متن" });
  items.push({ action: "pin", icon: "📌", label: "سنجاق کردن" });
  if (hasAttachment) items.push({ action: "download", icon: "⭳", label: "دانلود" });
  items.push({ action: "forward", icon: "➦", label: "بازارسال" });
  items.push({ action: "select", icon: "✓", label: "انتخاب" });

  const itemsHtml = items.map(it =>
    `<button data-ctx-action="${it.action}"><span class="ctx-item-label">${it.label}</span><span class="ctx-item-icon">${it.icon}</span></button>`
  ).join("");

  const deleteHtml = `
    <div class="msg-context-divider"></div>
    <button data-ctx-action="delete-for-me" class="ctx-danger"><span class="ctx-item-label">حذف برای من</span><span class="ctx-item-icon">🗑</span></button>
    ${canDeleteEveryone ? `<button data-ctx-action="delete-everyone" class="ctx-danger"><span class="ctx-item-label">حذف برای همه</span><span class="ctx-item-icon">🗑</span></button>` : ""}
  `;

  wrap.innerHTML = reactionStrip + `<div class="msg-context-items">${itemsHtml}</div>` + deleteHtml;
  document.body.appendChild(wrap);

  // Position within viewport bounds so it never renders off-screen.
  const menuRect = wrap.getBoundingClientRect();
  const margin = 8;
  let left = clientX;
  let top = clientY;
  if (left + menuRect.width + margin > window.innerWidth) left = window.innerWidth - menuRect.width - margin;
  if (left < margin) left = margin;
  if (top + menuRect.height + margin > window.innerHeight) top = window.innerHeight - menuRect.height - margin;
  if (top < margin) top = margin;
  wrap.style.left = `${left + window.scrollX}px`;
  wrap.style.top = `${top + window.scrollY}px`;

  wrap.addEventListener("click", async (e) => {
    e.stopPropagation();

    const emojiBtn = e.target.closest("[data-ctx-emoji]");
    if (emojiBtn) {
      closeMessageContextMenu();
      await toggleReaction(messageId, emojiBtn.dataset.ctxEmoji);
      return;
    }

    const actionBtn = e.target.closest("[data-ctx-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.ctxAction;
    closeMessageContextMenu();

    switch (action) {
      case "reply":
        startReply(messageId);
        break;
      case "edit": {
        editingMessageId = messageId;
        const message = findCachedMessage(messageId) || await getMessage(messageId);
        if (!message) break;
        $("editInput").value = message.content || "";
        $("editModal").classList.remove("hidden");
        $("editInput").focus();
        break;
      }
      case "copy-image": {
        const img = messageEl.querySelector(".message-image");
        if (!img) break;
        try {
          const resp = await fetch(img.src);
          const blob = await resp.blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          toast("تصویر کپی شد.");
        } catch {
          toast("کپی تصویر ناموفق بود.");
        }
        break;
      }
      case "copy": {
        const message = findCachedMessage(messageId);
        if (!message?.content) break;
        try {
          await navigator.clipboard.writeText(message.content);
          toast("پیام کپی شد.");
        } catch {
          toast("کپی ناموفق بود.");
        }
        break;
      }
      case "pin":
        toast("سنجاق کردن پیام به‌زودی اضافه می‌شود.");
        break;
      case "download": {
        const message = findCachedMessage(messageId);
        if (!message?.attachment_url) break;
        const a = document.createElement("a");
        a.href = message.attachment_url;
        a.download = message.attachment_name || "";
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        break;
      }
      case "forward":
        openForwardPicker(messageId);
        break;
      case "select":
        selectionMode = true;
        selectedMessageIds.add(messageId);
        renderMessages(currentMessagesCache);
        break;
      case "delete-for-me": {
        const { error } = await sb
          .from("message_hidden_for")
          .upsert({ message_id: messageId, user_id: currentUser.id }, { onConflict: "message_id,user_id" });
        if (error) { toast(error.message); break; }
        currentMessagesCache = currentMessagesCache.filter(m => m.id !== messageId);
        renderMessages(currentMessagesCache);
        toast("پیام برای شما حذف شد.");
        break;
      }
      case "delete-everyone": {
        if (!confirm("این پیام برای هر دو نفر حذف بشه؟")) break;
        const { error } = await sb.from("messages").delete().eq("id", messageId).eq("sender_id", currentUser.id);
        if (error) toast(error.message);
        break;
      }
    }
  });

  document.addEventListener("keydown", handleContextMenuEscape);
}

// ---- Reactions ----
async function toggleReaction(messageId, emoji) {

  if (existing && existing.emoji === emoji) {
    // Tapping the same emoji again removes it.
    const { error } = await sb
      .from("message_reactions")
      .delete()
      .eq("message_id", messageId)
      .eq("user_id", currentUser.id);
    if (error) toast(error.message);
    return;
  }

  // Upsert: one reaction per user per message, so picking a new emoji replaces the old one.
  const { error } = await sb
    .from("message_reactions")
    .upsert({ message_id: messageId, user_id: currentUser.id, emoji }, { onConflict: "message_id,user_id" });
  if (error) toast(error.message);
}

function subscribeToReactions() {
  if (reactionsChannel) {
    sb.removeChannel(reactionsChannel);
    reactionsChannel = null;
  }

  const chatIdAtSubscribe = currentChatId;

  reactionsChannel = sb
    .channel(`reactions-${currentChatId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "message_reactions" },
      (payload) => {
        if (currentChatId !== chatIdAtSubscribe) return;
        const row = payload.new?.message_id ? payload.new : payload.old;
        // Only re-render if this reaction belongs to a message currently on screen.
        if (!currentMessagesCache.some(m => m.id === row.message_id)) return;

        if (payload.eventType === "DELETE") {
          const list = currentMessageReactions.get(row.message_id) || [];
          currentMessageReactions.set(row.message_id, list.filter(r => r.user_id !== row.user_id));
        } else {
          const list = currentMessageReactions.get(row.message_id) || [];
          const filtered = list.filter(r => r.user_id !== row.user_id);
          filtered.push({ message_id: row.message_id, user_id: row.user_id, emoji: row.emoji });
          currentMessageReactions.set(row.message_id, filtered);
        }
        renderMessages(currentMessagesCache);
      }
    )
    .subscribe();
}

// Bound after every render (new elements only, via the __longPressBound
// guard) — long-press on touch devices opens the same context menu that
// right-click opens on desktop.
function attachMessageActions() {
  const box = $("messages");
  box.querySelectorAll(".message[data-ctx-menu]").forEach(el => {
    if (el.__longPressBound) return; // avoid re-binding on elements untouched by incremental render
    el.__longPressBound = true;
    let pressTimer = null;
    let startX = 0, startY = 0;
    const start = (e) => {
      const point = e.touches ? e.touches[0] : e;
      startX = point.clientX;
      startY = point.clientY;
      pressTimer = setTimeout(() => {
        openMessageContextMenu(el, startX, startY);
      }, 500);
    };
    const cancel = () => clearTimeout(pressTimer);
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchend", cancel);
    el.addEventListener("touchmove", cancel);
    el.addEventListener("touchcancel", cancel);
  });
}

// Bound once, ever, on init(). Handles every click inside the messages
// list by inspecting event.target — works for elements that don't exist
// yet at bind time, so incremental re-renders never need to re-wire clicks.
// Also owns the right-click / long-press context menu trigger.
function bindMessageActionsDelegation() {
  const box = $("messages");
  if (!box || box.__delegationBound) return;
  box.__delegationBound = true;

  box.addEventListener("click", (e) => {
    const reactionChipBtn = e.target.closest("[data-reaction-chip]");
    if (reactionChipBtn) {
      e.stopPropagation();
      toggleReaction(reactionChipBtn.dataset.reactionChip, reactionChipBtn.dataset.emoji);
      return;
    }

    const jumpEl = e.target.closest("[data-jump-to]");
    if (jumpEl) {
      const target = document.querySelector(`[data-message-id="${jumpEl.dataset.jumpTo}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("flash-highlight");
        setTimeout(() => target.classList.remove("flash-highlight"), 900);
      }
      return;
    }

    const viewImg = e.target.closest("[data-view-image]");
    if (viewImg) {
      $("imageViewerImg").src = viewImg.dataset.viewImage;
      $("imageViewerImg").classList.remove("hidden");
      $("imageViewerVideo").classList.add("hidden");
      $("imageViewerVideo").pause();
      $("imageViewer").classList.remove("hidden");
      return;
    }

    const viewVideoWrap = e.target.closest("[data-view-video]");
    if (viewVideoWrap) {
      $("imageViewerVideo").src = viewVideoWrap.dataset.viewVideo;
      $("imageViewerVideo").classList.remove("hidden");
      $("imageViewerImg").classList.add("hidden");
      $("imageViewer").classList.remove("hidden");
      $("imageViewerVideo").play().catch(() => {});
      return;
    }
  });

  box.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-select-checkbox]");
    if (!cb) return;
    const id = cb.dataset.selectCheckbox;
    if (cb.checked) selectedMessageIds.add(id);
    else selectedMessageIds.delete(id);
    updateSelectionBar();
  });

  // Desktop: right-click on a message opens the context menu.
  box.addEventListener("contextmenu", (e) => {
    const messageEl = e.target.closest(".message[data-ctx-menu]");
    if (!messageEl) return;
    if (e.target.closest("a, .message-select")) return; // let links / checkbox keep native behavior
    e.preventDefault();
    openMessageContextMenu(messageEl, e.clientX, e.clientY);
  });
}

// Mobile / touch: long-press on a message opens the same context menu
// (instead of the old long-press-to-select behavior). Bound once per
// message element via attachMessageActions below.

// ---- Reply ----
function startReply(messageId) {
  const message = findCachedMessage(messageId);
  if (!message) return;
  replyingToMessageId = messageId;

  const mine = message.sender_id === currentUser.id;
  const senderName = mine ? "شما" : (currentOtherUser?.display_name || currentOtherUser?.username || "");
  const preview = message.content
    ? message.content.slice(0, 100)
    : messagePreviewLabel(message);

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
  $("imageViewerVideo").pause();
  $("imageViewerVideo").src = "";
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

$("fileInput").addEventListener("change", async () => {
  const file = $("fileInput").files[0];
  if (!file) return;

  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");
  const kind = isImage ? "image" : (isVideo ? "video" : "file");

  const maxMb = isVideo ? MAX_VIDEO_FILE_MB : MAX_IMAGE_FILE_MB;
  if (file.size > maxMb * 1024 * 1024) {
    toast(`حجم فایل نباید بیشتر از ${maxMb} مگابایت باشد.`);
    $("fileInput").value = "";
    return;
  }

  if (isVideo) {
    await handleVideoPicked(file);
    return;
  }

  pendingAttachment = { file, kind };
  showAttachmentPreview();
  $("messageInput").focus();
});

// Shows the attachment preview strip for whatever `pendingAttachment` currently is.
function showAttachmentPreview() {
  if (!pendingAttachment) return;
  const { file, kind } = pendingAttachment;

  const preview = $("attachmentPreview");
  preview.classList.remove("hidden");

  $("attachmentPreviewImg").classList.add("hidden");
  $("attachmentPreviewVideo").classList.add("hidden");
  $("attachmentPreviewFile").classList.add("hidden");
  $("attachmentCompressNote").classList.add("hidden");

  if (kind === "image") {
    $("attachmentPreviewImg").src = URL.createObjectURL(file);
    $("attachmentPreviewImg").classList.remove("hidden");
  } else if (kind === "video") {
    $("attachmentPreviewVideo").src = URL.createObjectURL(file);
    $("attachmentPreviewVideo").classList.remove("hidden");
    $("attachmentCompressNote").textContent = `ویدیو · ${formatFileSize(file.size)}`;
    $("attachmentCompressNote").classList.remove("hidden");
  } else {
    $("attachmentPreviewFile").classList.remove("hidden");
    $("attachmentPreviewName").textContent = `${file.name} · ${formatFileSize(file.size)}`;
  }
}

// Compresses the picked video client-side (re-encode at a lower resolution/
// bitrate via MediaRecorder) before it becomes the pending attachment, so
// slow connections upload less data. Falls back to the original file if
// compression isn't supported or fails — never blocks sending.
async function handleVideoPicked(file) {
  const note = $("attachmentCompressNote");
  const preview = $("attachmentPreview");
  preview.classList.remove("hidden");
  $("attachmentPreviewImg").classList.add("hidden");
  $("attachmentPreviewFile").classList.add("hidden");
  $("attachmentPreviewVideo").classList.add("hidden");
  note.classList.remove("hidden");
  note.textContent = "در حال فشرده‌سازی ویدیو...";
  videoCompressionInProgress = true;

  let finalFile = file;
  try {
    const compressed = await compressVideoFile(file, (pct) => {
      note.textContent = `در حال فشرده‌سازی ویدیو... ${pct}%`;
    });
    if (compressed && compressed.size < file.size) {
      finalFile = compressed;
    }
  } catch (err) {
    console.warn("Video compression skipped:", err);
    // Fall back silently to the original file.
  }

  videoCompressionInProgress = false;
  pendingAttachment = { file: finalFile, kind: "video" };

  $("attachmentPreviewVideo").src = URL.createObjectURL(finalFile);
  $("attachmentPreviewVideo").classList.remove("hidden");

  const savedPct = file.size > finalFile.size
    ? Math.round((1 - finalFile.size / file.size) * 100)
    : 0;
  note.textContent = savedPct > 0
    ? `ویدیو · ${formatFileSize(finalFile.size)} (${savedPct}% کوچک‌تر شد)`
    : `ویدیو · ${formatFileSize(finalFile.size)}`;

  $("messageInput").focus();
}

// Re-encodes a video using the browser's own decode (via a <video> element)
// and MediaRecorder + canvas capture pipeline. This re-compresses at a capped
// resolution/bitrate without any server round-trip. Resolves to a new File,
// or null if the browser can't do it (caller falls back to the original).
function compressVideoFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder === "undefined" || !window.MediaRecorder) {
      return reject(new Error("MediaRecorder not supported"));
    }

    const videoEl = document.createElement("video");
    videoEl.src = URL.createObjectURL(file);
    videoEl.muted = true;
    videoEl.playsInline = true;

    videoEl.addEventListener("error", () => reject(new Error("video decode failed")));

    videoEl.addEventListener("loadedmetadata", () => {
      const duration = videoEl.duration;
      if (!isFinite(duration) || duration <= 0) {
        return reject(new Error("invalid video duration"));
      }

      const scale = Math.min(1, VIDEO_COMPRESS_MAX_WIDTH / (videoEl.videoWidth || VIDEO_COMPRESS_MAX_WIDTH));
      const outWidth = Math.round((videoEl.videoWidth || VIDEO_COMPRESS_MAX_WIDTH) * scale / 2) * 2;
      const outHeight = Math.round((videoEl.videoHeight || 720) * scale / 2) * 2;

      const canvas = document.createElement("canvas");
      canvas.width = outWidth;
      canvas.height = outHeight;
      const ctx = canvas.getContext("2d");

      const canvasStream = canvas.captureStream(30);

      // Preserve audio by routing the source video's audio track into the
      // recorded stream alongside the re-scaled video frames.
      let combinedStream = canvasStream;
      try {
        if (videoEl.captureStream) {
          const sourceStream = videoEl.captureStream();
          const audioTracks = sourceStream.getAudioTracks();
          if (audioTracks.length) {
            combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
          }
        }
      } catch { /* audio capture is best-effort; video-only fallback is fine */ }

      const mimeCandidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
      ];
      const mimeType = mimeCandidates.find(m => MediaRecorder.isTypeSupported(m)) || "";
      if (!mimeType) return reject(new Error("no supported recording mime type"));

      // Bitrate scales down for longer videos so total size stays reasonable,
      // but never below a floor that would make it unwatchable.
      const targetBitrate = Math.max(700_000, Math.min(2_500_000, (VIDEO_COMPRESS_TARGET_MB * 8_000_000) / Math.max(duration, 1)));

      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: Math.round(targetBitrate)
      });

      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

      recorder.onstop = () => {
        URL.revokeObjectURL(videoEl.src);
        if (!chunks.length) return reject(new Error("no data recorded"));
        const blob = new Blob(chunks, { type: mimeType });
        const newName = file.name.replace(/\.[^.]+$/, "") + ".webm";
        resolve(new File([blob], newName, { type: mimeType }));
      };

      recorder.onerror = (e) => reject(e.error || new Error("recorder error"));

      let drawing = true;
      const drawFrame = () => {
        if (!drawing) return;
        ctx.drawImage(videoEl, 0, 0, outWidth, outHeight);
        if (onProgress && duration > 0) {
          onProgress(Math.min(99, Math.round((videoEl.currentTime / duration) * 100)));
        }
        requestAnimationFrame(drawFrame);
      };

      videoEl.addEventListener("ended", () => {
        drawing = false;
        recorder.stop();
      });

      recorder.start(250);
      videoEl.play().then(drawFrame).catch((err) => {
        drawing = false;
        try { recorder.stop(); } catch {}
        reject(err);
      });
    }, { once: true });
  });
}

$("removeAttachment").addEventListener("click", clearAttachment);

function clearAttachment() {
  pendingAttachment = null;
  videoCompressionInProgress = false;
  $("fileInput").value = "";
  $("attachmentPreview").classList.add("hidden");
  $("attachmentPreviewImg").src = "";
  $("attachmentPreviewVideo").src = "";
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
  if (videoCompressionInProgress) { toast("صبر کن تا فشرده‌سازی ویدیو تمام بشه."); return; }
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
    attachment_url: attachment && (attachment.kind === "image" || attachment.kind === "video") ? URL.createObjectURL(attachment.file) : null,
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
    // Add a TURN server here later for stricter NAT/firewall networks.
  ],
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require"
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
        if (callId !== currentCallId) return; // stale call event
        const status = payload.new.status;
        if (status === "rejected") {
          toast("تماس رد شد.");
          endCall(false, callId);
        } else if (status === "missed") {
          toast("پاسخ داده نشد.");
          endCall(false, callId);
        } else if (status === "accepted") {
          stopRingtone();
          if (callState === "outgoing" || callState === "ringing") callState = "connecting";
        } else if (status === "ended") {
          endCall(false, callId);
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
  callState = "outgoing";
  callGeneration++;
  resetCallSignalingState();

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
      endCall(false, call.id);
    }
  }, 30000);
}

function openCallModal(callType) {
  const remoteEl = $("remoteVideo");
  const localEl = $("localVideo");
  remoteEl.autoplay = true;
  remoteEl.playsInline = true;
  remoteEl.muted = false;
  localEl.autoplay = true;
  localEl.playsInline = true;
  localEl.muted = true;
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
  const localEl = $("localVideo");
  const remoteEl = $("remoteVideo");
  localEl.pause?.();
  remoteEl.pause?.();
  localEl.srcObject = null;
  remoteEl.srcObject = null;
  remoteEl.muted = false;
}

async function createPeerConnection() {
  const callIdAtCreation = currentCallId;
  const generationAtCreation = callGeneration;
  const candidateQueue = [];
  let disconnectGraceTimer = null;
  let failedTimer = null;

  pc = new RTCPeerConnection(RTC_CONFIG);
  const thisPc = pc;

  if (!localStream) throw new Error("Local media stream is missing");
  localStream.getTracks().forEach(track => thisPc.addTrack(track, localStream));

  remoteStream = new MediaStream();
  const remoteVideoEl = $("remoteVideo");
  remoteVideoEl.autoplay = true;
  remoteVideoEl.playsInline = true;
  remoteVideoEl.muted = false;
  remoteVideoEl.srcObject = remoteStream;

  thisPc.ontrack = async (event) => {
    if (thisPc !== pc || callIdAtCreation !== currentCallId || generationAtCreation !== callGeneration) return;
    if (!remoteStream.getTracks().some(t => t.id === event.track.id)) {
      remoteStream.addTrack(event.track);
    }
    event.track.onended = () => {
      if (thisPc === pc && currentCallId === callIdAtCreation) {
        // Do not end the whole call for a single media track ending.
        // A camera track can end while audio remains alive.
      }
    };
    try {
      await remoteVideoEl.play();
    } catch {
      // Browser autoplay policy: retry after a user interaction.
      const resume = () => remoteVideoEl.play().catch(() => {});
      document.addEventListener("touchstart", resume, { once: true, passive: true });
      document.addEventListener("click", resume, { once: true });
    }
  };

  thisPc.onicecandidate = async (event) => {
    if (!event.candidate || thisPc !== pc || currentCallId !== callIdAtCreation) return;
    try {
      await sendSignal("ice-candidate", event.candidate.toJSON(), callIdAtCreation);
    } catch {
      // A transient signaling failure should not kill an otherwise healthy call.
    }
  };

  thisPc.oniceconnectionstatechange = () => {
    if (thisPc !== pc || currentCallId !== callIdAtCreation) return;
    const state = thisPc.iceConnectionState;
    if (state === "connected" || state === "completed") {
      clearTimeout(disconnectGraceTimer);
      clearTimeout(failedTimer);
    } else if (state === "disconnected") {
      clearTimeout(disconnectGraceTimer);
      disconnectGraceTimer = setTimeout(() => {
        if (thisPc === pc && currentCallId === callIdAtCreation &&
            (thisPc.iceConnectionState === "disconnected" || thisPc.iceConnectionState === "failed")) {
          toast("اتصال تماس قطع شد.");
          endCall(false, callIdAtCreation);
        }
      }, 10000);
    } else if (state === "failed") {
      clearTimeout(failedTimer);
      failedTimer = setTimeout(() => {
        if (thisPc === pc && currentCallId === callIdAtCreation && thisPc.iceConnectionState === "failed") {
          toast("اتصال تماس برقرار نشد.");
          endCall(false, callIdAtCreation);
        }
      }, 2500);
    }
  };

  thisPc.onconnectionstatechange = () => {
    if (thisPc !== pc || currentCallId !== callIdAtCreation || generationAtCreation !== callGeneration) return;
    const state = thisPc.connectionState;
    if (state === "connected") {
      clearTimeout(disconnectGraceTimer);
      clearTimeout(failedTimer);
      callState = "connected";
      stopRingtone();
    } else if (state === "connecting") {
      callState = "connecting";
    } else if (state === "disconnected") {
      clearTimeout(disconnectGraceTimer);
      disconnectGraceTimer = setTimeout(() => {
        if (thisPc === pc && currentCallId === callIdAtCreation && thisPc.connectionState === "disconnected") {
          toast("اتصال تماس قطع شد.");
          endCall(false, callIdAtCreation);
        }
      }, 10000);
    } else if (state === "failed") {
      clearTimeout(failedTimer);
      failedTimer = setTimeout(() => {
        if (thisPc === pc && currentCallId === callIdAtCreation && thisPc.connectionState === "failed") {
          toast("اتصال تماس برقرار نشد.");
          endCall(false, callIdAtCreation);
        }
      }, 2500);
    } else if (state === "closed") {
      if (currentCallId === callIdAtCreation && callState !== "ending" && callState !== "ended") {
        endCall(false, callIdAtCreation);
      }
    }
  };

  // Keep a per-PC queue so ICE that arrives before remoteDescription is not lost.
  thisPc.__candidateQueue = candidateQueue;
  return thisPc;
}

async function createAndSendOffer() {
  if (!pc || !currentCallId) return;
  const callId = currentCallId;
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  if (!pc || currentCallId !== callId) return;
  await pc.setLocalDescription(offer);
  if (currentCallId !== callId) return;
  await sendSignal("offer", pc.localDescription?.toJSON?.() || pc.localDescription, callId);
}

async function sendSignal(signalType, payload, callId = currentCallId) {
  if (!callId || callId !== currentCallId) return;
  const { error } = await sb.from("call_signals").insert({
    call_id: callId,
    sender_id: currentUser.id,
    signal_type: signalType,
    payload
  });
  if (error) throw error;
}

function subscribeToCallSignals(callId) {
  if (callSignalsChannel) {
    sb.removeChannel(callSignalsChannel);
    callSignalsChannel = null;
  }
  resetCallSignalingState();

  callSignalsChannel = sb
    .channel(`call-signals-${callId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "call_signals", filter: `call_id=eq.${callId}` },
      async (payload) => {
        if (currentCallId !== callId) return;
        try { await handleIncomingSignal(payload.new); } catch (err) {
          console.warn("Call signaling error", err);
        }
      }
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED" && currentCallId === callId) {
        const { data: backlog } = await sb
          .from("call_signals")
          .select("*")
          .eq("call_id", callId)
          .neq("sender_id", currentUser.id)
          .order("created_at", { ascending: true });
        for (const row of backlog || []) {
          if (currentCallId !== callId) break;
          try { await handleIncomingSignal(row); } catch (err) {
            console.warn("Call backlog signal error", err);
          }
        }
      }
    });
}

async function flushPendingIceCandidates() {
  if (!pc || !pc.remoteDescription) return;
  const queue = pendingIceCandidates.splice(0);
  for (const candidate of queue) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {
      console.warn("ICE candidate error", err);
    }
  }
}

async function handleIncomingSignal(row) {
  if (!row || row.sender_id === currentUser.id) return;
  if (row.call_id !== currentCallId || !pc) return;
  if (row.id && processedSignalIds.has(row.id)) return;
  if (row.id) processedSignalIds.add(row.id);

  if (row.signal_type === "offer") {
    if (pc.signalingState === "stable" || pc.signalingState === "have-remote-offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(row.payload));
      await flushPendingIceCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSignal("answer", pc.localDescription?.toJSON?.() || pc.localDescription, row.call_id);
      callState = "connecting";
    }
  } else if (row.signal_type === "answer") {
    if (pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(row.payload));
      await flushPendingIceCandidates();
      stopRingtone();
      callState = "connecting";
    }
  } else if (row.signal_type === "ice-candidate") {
    if (!pc.remoteDescription) {
      pendingIceCandidates.push(row.payload);
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(row.payload)); } catch (err) {
      console.warn("ICE candidate error", err);
    }
  } else if (row.signal_type === "hangup") {
    await endCall(false, row.call_id);
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
  callState = "ringing";
  callGeneration++;
  resetCallSignalingState();
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

let callEndingInProgress = false;

async function endCall(notifyPeer, callIdGuard = null) {
  // Guard against stale/duplicate triggers (a late "failed" event, a hangup
  // signal that arrives after the user already hung up manually, etc.)
  // acting on a call that has already ended or been replaced by a new one —
  // this was the cause of a new call being silently killed by a leftover
  // event from the previous one, and of "still thinks I'm in a call" state.
  if (callIdGuard && callIdGuard !== currentCallId) return;
  if (!currentCallId && !pc && !localStream) return; // already fully ended
  if (callEndingInProgress) return;
  callEndingInProgress = true;
  const endingCallId = currentCallId;
  callState = "ending";
  callGeneration++;

  try {
    stopRingtone();
    clearTimeout(ringTimeoutId);

    if (notifyPeer && currentCallId) {
      try {
        await sendSignal("hangup", {}, endingCallId);
        await sb.from("calls").update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", endingCallId);
      } catch { /* best-effort — don't let a failed status update block cleanup */ }
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
    if (remoteStream) remoteStream.getTracks().forEach(track => track.stop());
    remoteStream = null;
    resetCallSignalingState();
    currentCallId = null;
    currentCallType = null;
    isMuted = false;
    isCameraOff = false;

    closeCallModal();
    callState = "ended";
  } finally {
    callEndingInProgress = false;
  }
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
bindMessageActionsDelegation();
init();
