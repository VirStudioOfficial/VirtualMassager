// extracted from script.js
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

