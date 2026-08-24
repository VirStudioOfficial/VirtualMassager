from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
index = ROOT / 'index.html'
style = ROOT / 'style.css'
script = ROOT / 'script.js'

# Load files
html = index.read_text(encoding='utf-8')
css = style.read_text(encoding='utf-8')
js = script.read_text(encoding='utf-8')

# 1) Load one consistent SVG icon set (Lucide) and the enhancement layer.
if 'messenger-enhancements.css' not in html:
    html = html.replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="messenger-enhancements.css">')
if 'messenger-enhancements.js' not in html:
    html = html.replace('</body>', '  <script src="messenger-enhancements.js" defer></script>\n</body>')

# 2) Add an explicit call connection status element if the existing badge is missing.
if 'id="callConnectionProgress"' not in html:
    needle = '<div id="callStatusBadge" class="call-status-badge hidden">در حال اتصال...</div>'
    replacement = needle + '\n            <div id="callConnectionProgress" class="call-connection-progress" aria-live="polite"><span class="call-connection-dot"></span><span id="callConnectionText">آماده</span></div>'
    html = html.replace(needle, replacement)

# 3) Keep the original code intact and append the enhancement implementation.
# The companion JS is intentionally standalone so it can be removed without
# touching the core messenger logic.
index.write_text(html, encoding='utf-8')
