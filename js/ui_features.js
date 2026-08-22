// UI feature layer - Phase 3

export const uiFeatures = {
  darkMode: true,
  animations: true,
  messageBubbles: true,
  emojiPicker: true,
  stickerSupport: true
};

export function setTheme(theme = "system") {
  return { theme };
}

export function createReaction(messageId, emoji) {
  return { messageId, emoji };
}

export function createSticker(stickerId) {
  return { stickerId };
}
