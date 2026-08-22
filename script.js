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

// ===============================
// 2) State
// ===============================
let currentUser = null;
let myProfile = null;
let currentChatId = null;
let currentOtherUser = null;
let messagesChannel = null;
let onlineChannel = null;
let onlineUsers = new Set();
let authMode = "login";
let editingMessageId = null;

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
const usernameInput = $("username");

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.style.display = "none", 2500);
}

function escapeHtml(value = "") {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("fa-IR", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function initials(name = "?") {
  return escapeHtml(name.trim().slice(0, 1).toUpperCase() || "?");
}

// ===============================
// 4) Auth - Username + Password
// ===============================
// Supabase Auth internally needs an email for password accounts.
// We generate a hidden internal email from the username.
// The user never sees or enters an email.
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
}

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
    .select("id, username, display_name")
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
        <div class="avatar">${initials(user.display_name || user.username)}</div>
        <div>
          <strong>${escapeHtml(user.display_name || user.username)}</strong>
          <small>@${escapeHtml(user.username)}</small>
        </div>
      </div>
    `).join("")
    : `<div class="empty-state">کاربری پیدا نشد</div>`;

  box.querySelectorAll(".user-result").forEach(el => {
    el.addEventListener("click", () => openOrCreateChat(el.dataset.userId));
  });
}

// ===============================
// 7) Chats
// ===============================
async function loadChats() {
  const { data: memberships, error } = await sb
    .from("chat_members")
    .select("chat_id")
    .eq("user_id", currentUser.id);

  if (error) {
    toast(error.message);
    return;
  }

  const chatList = $("chatList");

  if (!memberships.length) {
    chatList.innerHTML = `<div class="empty-state" style="padding:25px">هنوز گفتگویی نداری.</div>`;
    return;
  }

  const chatIds = memberships.map(x => x.chat_id);

  const { data: members, error: memberError } = await sb
    .from("chat_members")
    .select("chat_id, user_id, profiles(id, username, display_name)")
    .in("chat_id", chatIds)
    .neq("user_id", currentUser.id);

  if (memberError) {
    toast(memberError.message);
    return;
  }

  chatList.innerHTML = members.map(member => {
    const p = member.profiles;
    return `
      <div class="chat-item" data-chat-id="${member.chat_id}" data-user-id="${p.id}">
        <div class="avatar">${initials(p.display_name || p.username)}</div>
        <div class="info">
          <div class="name">
            ${escapeHtml(p.display_name || p.username)}
            ${onlineUsers.has(p.id) ? '<span class="online-dot"></span>' : ''}
          </div>
          <div class="preview">@${escapeHtml(p.username)}</div>
        </div>
      </div>
    `;
  }).join("");

  chatList.querySelectorAll(".chat-item").forEach(el => {
    el.addEventListener("click", async () => {
      const profile = await getProfile(el.dataset.userId);
      openChat(el.dataset.chatId, profile);
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
  $("userSearch").value = "";
  $("searchResults").innerHTML = "";

  // Look for an existing 1-to-1 chat containing both users.
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

  $("chatTitle").textContent = otherUser.display_name || otherUser.username;
  $("chatStatus").textContent = onlineUsers.has(otherUser.id) ? "آنلاین" : "آفلاین";
  $("messageForm").classList.remove("hidden");

  document.querySelectorAll(".chat-item").forEach(el => {
    el.classList.toggle("active", el.dataset.chatId === chatId);
  });

  await loadMessages();
  subscribeToMessages();
}

// ===============================
// 8) Messages
// ===============================
async function loadMessages() {
  const { data, error } = await sb
    .from("messages")
    .select("id, sender_id, content, created_at, edited_at")
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
    return;
  }

  box.innerHTML = messages.map(renderMessage).join("");
  attachMessageActions();
  box.scrollTop = box.scrollHeight;
}

function renderMessage(message) {
  const mine = message.sender_id === currentUser.id;
  const actions = mine ? `
    <div class="message-actions">
      <button data-edit="${message.id}">ویرایش</button>
      <button class="delete" data-delete="${message.id}">حذف</button>
    </div>
  ` : "";

  return `
    <div class="message ${mine ? "mine" : ""}" data-message-id="${message.id}">
      <div class="message-text">${escapeHtml(message.content)}</div>
      <div class="message-meta">
        <span>${formatTime(message.created_at)}</span>
        ${message.edited_at ? "<span>ویرایش‌شده</span>" : ""}
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
      $("editInput").value = message.content;
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
}

async function getMessage(id) {
  const { data } = await sb
    .from("messages")
    .select("*")
    .eq("id", id)
    .single();
  return data;
}

$("messageForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const input = $("messageInput");
  const content = input.value.trim();

  if (!content || !currentChatId) return;

  input.disabled = true;

  const { error } = await sb
    .from("messages")
    .insert({
      chat_id: currentChatId,
      sender_id: currentUser.id,
      content
    });

  if (error) toast(error.message);
  else input.value = "";

  input.disabled = false;
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
      () => loadMessages()
    )
    .subscribe();
}

// ===============================
// 10) Online presence
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
  if (currentOtherUser) {
    $("chatStatus").textContent =
      onlineUsers.has(currentOtherUser.id) ? "آنلاین" : "آفلاین";
  }
  loadChats();
}

// Start.
init();
