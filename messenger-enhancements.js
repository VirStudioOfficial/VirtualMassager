/* Virtual Messenger enhancement layer. Safe, dependency-free. */
(() => {
  const SVG = {
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9V5a3 3 0 0 0-5.8-1"/><path d="M19 10v2a7 7 0 0 1-11.2 5.6"/><path d="M12 19v3"/><path d="m3 3 18 18"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 10 4.6-3.1A1 1 0 0 1 21 7.7v8.6a1 1 0 0 1-1.4.8L15 14"/><rect x="3" y="5" width="12" height="14" rx="2"/></svg>',
    cameraOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18"/><path d="M15 10 19.6 6.9A1 1 0 0 1 21 7.7v8.6a1 1 0 0 1-1.4.8L15 14"/><rect x="3" y="5" width="12" height="14" rx="2"/></svg>'
  };

  function setCallIcon(id, icon, label) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = icon;
    el.setAttribute('aria-label', label);
  }

  function normalizeCallControls() {
    const mute = document.getElementById('toggleMuteBtn');
    const cam = document.getElementById('toggleCamBtn');
    if (!mute || !cam) return;
    if (!mute.dataset.vmBound) {
      mute.dataset.vmBound = '1';
      mute.addEventListener('click', () => setTimeout(() => {
        const muted = window.__vmLastMuteState;
        setCallIcon('toggleMuteBtn', muted ? SVG.micOff : SVG.mic, muted ? 'وصل صدا' : 'قطع صدا');
      }, 0));
    }
    if (!cam.dataset.vmBound) {
      cam.dataset.vmBound = '1';
      cam.addEventListener('click', () => setTimeout(() => {
        const off = window.__vmLastCameraState;
        setCallIcon('toggleCamBtn', off ? SVG.cameraOff : SVG.camera, off ? 'روشن کردن دوربین' : 'خاموش کردن دوربین');
      }, 0));
    }
    setCallIcon('toggleMuteBtn', SVG.mic, 'قطع صدا');
    setCallIcon('toggleCamBtn', SVG.camera, 'خاموش کردن دوربین');
  }

  function patchOnlineIndicator() {
    // Presence dot belongs to the avatar/chat item, never inside profile text.
    document.querySelectorAll('.online-dot').forEach(dot => dot.remove());
    const avatar = document.getElementById('chatHeaderAvatar');
    const status = document.getElementById('chatStatus');
    if (avatar && status) avatar.classList.toggle('is-online', /آنلاین|online/i.test(status.textContent || ''));
  }

  function patchEmojiOnlyButtons() {
    document.querySelectorAll('button').forEach(btn => {
      const text = (btn.textContent || '').trim();
      if (!text) return;
      if (text === '🎤' || text === '🔇') setCallIcon(btn.id, text === '🔇' ? SVG.micOff : SVG.mic, text === '🔇' ? 'وصل صدا' : 'قطع صدا');
      if (text === '📷' || text === 'کامرا') setCallIcon(btn.id, text === '📷' ? SVG.cameraOff : SVG.camera, text === '📷' ? 'روشن کردن دوربین' : 'خاموش کردن دوربین');
    });
  }

  function observe() {
    normalizeCallControls();
    patchOnlineIndicator();
    patchEmojiOnlyButtons();
  }

  const mo = new MutationObserver(observe);
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('load', observe, { once: true });
  setInterval(observe, 1200);
})();
