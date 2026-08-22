// stage extraction: message subsystem starts here
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

  const kind = file.type.startsWith("image/") ? "image" : "file"