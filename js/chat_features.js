// Telegram-style chat management feature layer

export const chatFeatures = {
  pin: true,
  archive: true,
  mute: true,
  search: true
};

export function togglePin(chatId) {
  return { chatId, pinned: true };
}

export function archiveChat(chatId) {
  return { chatId, archived: true };
}

export function muteChat(chatId, duration = "always") {
  return { chatId, muted: true, duration };
}
