// extracted from script.js
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

