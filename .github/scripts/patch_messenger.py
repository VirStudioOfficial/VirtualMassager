from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
index = ROOT / 'index.html'
script = ROOT / 'script.js'

html = index.read_text(encoding='utf-8')
js = script.read_text(encoding='utf-8')

if 'messenger-enhancements.css' not in html:
    html = html.replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="messenger-enhancements.css">')
if 'messenger-enhancements.js' not in html:
    html = html.replace('</body>', '  <script src="messenger-enhancements.js" defer></script>\n</body>')
if 'id="callConnectionProgress"' not in html:
    needle = '<div id="callStatusBadge" class="call-status-badge hidden">در حال اتصال...</div>'
    replacement = needle + '\n            <div id="callConnectionProgress" class="call-connection-progress" aria-live="polite"><span class="call-connection-dot"></span><span id="callConnectionText">آماده</span></div>'
    html = html.replace(needle, replacement)

# 720p/24fps is a practical starting point: good quality, lower startup cost.
video_old = 'video: callType === "video"'
video_new = '''video: callType === "video" ? {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 24, max: 30 },
        facingMode: "user"
      } : false'''
js = js.replace(video_old, video_new)
video_old2 = 'video: call.call_type === "video"'
video_new2 = '''video: call.call_type === "video" ? {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 24, max: 30 },
        facingMode: "user"
      } : false'''
js = js.replace(video_old2, video_new2)

# Client-side image compression: resize to <=1920px and encode as WebP.
if 'function compressImageFile(' not in js:
    helper = r'''
// ---- Image compression / normalization ----
async function compressImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return file;
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const maxSide = 1920;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.84));
    if (!blob || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    return new File([blob], `${base}.webp`, { type: "image/webp", lastModified: Date.now() });
  } catch (err) {
    console.warn("Image compression skipped:", err);
    return file;
  }
}

'''
    js = js.replace('// ---- Attachment picking ----', helper + '// ---- Attachment picking ----', 1)

old = '  pendingAttachment = { file, kind };\n  showAttachmentPreview();'
new = '  const preparedFile = isImage ? await compressImageFile(file) : file;\n  pendingAttachment = { file: preparedFile, kind };\n  showAttachmentPreview();'
if old in js:
    js = js.replace(old, new, 1)

# Connection UI + conservative sender bitrate cap.
if 'function vmSetCallConnectionState(' not in js:
    helper2 = r'''
function vmSetCallConnectionState(state) {
  const wrap = document.getElementById("callConnectionProgress");
  const text = document.getElementById("callConnectionText");
  if (!wrap || !text) return;
  const labels = {
    idle: "آماده", outgoing: "در حال تماس...", ringing: "در انتظار پاسخ...",
    connecting: "در حال برقراری ارتباط...", connected: "متصل شد",
    disconnected: "اتصال ناپایدار", failed: "اتصال ناموفق", ended: "تماس پایان یافت"
  };
  text.textContent = labels[state] || state;
  wrap.dataset.state = state;
}

function vmTuneVideoSenders(peer) {
  try {
    peer.getSenders().forEach(sender => {
      if (sender.track?.kind !== "video") return;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 1800000;
      params.encodings[0].maxFramerate = 24;
      sender.setParameters(params).catch(() => {});
    });
  } catch (_) {}
}

'''
    js = js.replace('async function createPeerConnection() {', helper2 + 'async function createPeerConnection() {', 1)

js = js.replace('  localStream.getTracks().forEach(track => thisPc.addTrack(track, localStream));', '  localStream.getTracks().forEach(track => thisPc.addTrack(track, localStream));\n  vmTuneVideoSenders(thisPc);', 1)
js = js.replace('      callState = "connected";\n      stopRingtone();', '      callState = "connected";\n      vmSetCallConnectionState("connected");\n      stopRingtone();', 1)
js = js.replace('      callState = "connecting";\n    } else if (state === "disconnected") {', '      callState = "connecting";\n      vmSetCallConnectionState("connecting");\n    } else if (state === "disconnected") {', 1)

# The first failed branch belongs to ICE state; mark it too.
js = js.replace('    } else if (state === "failed") {\n      clearTimeout(failedTimer);', '    } else if (state === "failed") {\n      vmSetCallConnectionState("failed");\n      clearTimeout(failedTimer);', 1)
js = js.replace('  $("callModal").classList.remove("hidden");', '  $("callModal").classList.remove("hidden");\n  vmSetCallConnectionState(callState || "connecting");', 1)

index.write_text(html, encoding='utf-8')
script.write_text(js, encoding='utf-8')
