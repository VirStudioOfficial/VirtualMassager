// Phase 1 Telegram-style features layer
// Safe extension layer. Existing legacy logic remains untouched.

export const messageFeatures = {
  reactions: ["👍","❤️","😂","😮","😢","🙏"],
  canEdit: true,
  canReply: true,
  canForward: true,
  multiSelect: true
};

export function toggleReaction(messageId, emoji){
  return { messageId, emoji };
}

export function createReplyPreview(message){
  return {
    id: message.id,
    text: message.content || "",
  };
}
