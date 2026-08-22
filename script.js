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
let pendingAttachment = null; // { file, kind: 'image'|'file' }
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
    return `<img src="${escapeHtml(profile.avatar_url)}" alt="">`;
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
  await sb.auth.signOut();
});

// ===============================
// 5) Bootstrap
// ===============================
async function init() {
  const { data } = await sb.auth.getSession();
  await handleSession(data.session);

  sb.auth.onAuthStateChange(async (_event, session) => {
    await handleSession(session);
  });
}

async function handleSession(session) {
  if (!session) {
    currentUser = null;
    myProfile = null;
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    return;
  }

  currentUser = session.user;
  authView.classList.add("hidden");
  appView.classList.remove("hidden");

  await ensureProfile();
  await loadChats();
  await startPresence();
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
  $("chatStatus").textContent = onlineUsers.has(otherUser.id) ? "آنلاین" : "آفلاین";
  $("messageForm").classList.remove("hidden");

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
  const { data, error } = await sb
    .from("messages")
    .select("id, sender_id, content, attachment_url, attachment_type, attachment_name, created_at, edited_at, read_at")
    .eq("chat_id", currentChatId)
    .order("created_at", { ascending: true });

  if (error) {
    toast(error.message);
    return;
  }

  renderMessages(data || []);
}

function renderMessages(messages) {
  const box = $("messages");

  if (!messages.length) {
    box.innerHTML = `<div class="empty-state">اولین پیام رو بفرست 👋</div>`;
  } else {
    box.innerHTML = messages.map(renderMessage).join("");
    attachMessageActions();
  }

  renderTypingIndicator();
  box.scrollTop = box.scrollHeight;
}

function renderMessage(message) {
  const mine = message.sender_id === currentUser.id;
  const pending = message.id.toString().startsWith("temp-");

  const actions = (mine && !pending && !message.attachment_url) ? `
    <div class="message-actions">
      <button data-edit="${message.id}">ویرایش</button>
      <button class="delete" data-delete="${message.id}">حذف</button>
    </div>
  ` : (mine && !pending ? `
    <div class="message-actions">
      <button class="delete" data-delete="${message.id}">حذف</button>
    </div>
  ` : "");

  let mediaHtml = "";
  if (message.attachment_url) {
    if (message.attachment_type === "image") {
      mediaHtml = `<img class="message-image" src="${escapeHtml(message.attachment_url)}" data-view-image="${escapeHtml(message.attachment_url)}" alt="عکس">`;
    } else {
      mediaHtml = `
        <a class="message-file" href="${escapeHtml(message.attachment_url)}" target="_blank" rel="noopener">
          <span class="file-icon">📎</span>
          <span class="file-name">${escapeHtml(message.attachment_name || "فایل")}</span>
        </a>
      `;
    }
  }

  const textHtml = message.content
    ? `<div class="message-text">${escapeHtml(message.content)}</div>`
    : "";

  const readTick = mine
    ? `<span class="read-tick ${message.read_at ? "read" : ""}">${message.read_at ? "✓✓" : "✓"}</span>`
    : "";

  return `
    <div class="message ${mine ? "mine" : ""} ${pending ? "pending" : ""}" data-message-id="${message.id}">
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
      const message = await getMessage(editingMessageId);
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

  document.querySelectorAll("[data-view-image]").forEach(img => {
    img.addEventListener("click", () => {
      $("imageViewerImg").src = img.dataset.viewImage;
      $("imageViewer").classList.remove("hidden");
    });
  });
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

  if (!content && !attachment) return;
  if (!currentChatId) return;

  input.value = "";
  clearAttachment();
  clearTyping();

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
    read_at: null
  };

  box.insertAdjacentHTML("beforeend", renderMessage(optimisticMessage));
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
        attachment_name
      });

    if (error) throw error;

    // Realtime subscription will re-render with the real row;
    // remove the temp bubble to avoid a duplicate.
    const tempEl = box.querySelector(`[data-message-id="${tempId}"]`);
    if (tempEl) tempEl.remove();
  } catch (error) {
    toast(error.message || "ارسال پیام ناموفق بود.");
    const tempEl = box.querySelector(`[data-message-id="${tempId}"]`);
    if (tempEl) tempEl.remove();
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
  }

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
        await loadMessages();
        if (payload.eventType === "INSERT" && payload.new.sender_id !== currentUser.id) {
          await markChatAsRead();
        }
        await loadChats();
      }
    )
    .subscribe();
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
    $("chatStatus").textContent = onlineUsers.has(currentOtherUser.id) ? "آنلاین" : "آفلاین";
  }
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
    $("chatStatus").textContent =
      onlineUsers.has(currentOtherUser.id) ? "آنلاین" : "آفلاین";
  }
  renderChatList();
}

// Clean up typing status when leaving the page.
window.addEventListener("beforeunload", () => {
  if (currentChatId && currentUser) {
    navigator.sendBeacon?.(
      `${SUPABASE_URL}/rest/v1/typing_status?chat_id=eq.${currentChatId}&user_id=eq.${currentUser.id}`
    );
  }
});

// Start.
init();
