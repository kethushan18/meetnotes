// Hands a claude:// link to the Claude desktop app.
// Chrome may first show "Open Claude?" over this tab, so we never close while that prompt
// could be up. We only tidy up once focus comes back to this tab after it left (you clicked
// Open or Cancel, or you came back from the Claude app).
const target = new URLSearchParams(location.search).get('u') || '';
const ok = /^claude:\/\//.test(target);
const again = document.getElementById('again');
if (ok) again.href = target;
document.getElementById('close').onclick = () => window.close();

let leftAt = 0;
window.addEventListener('blur', () => {
  leftAt = Date.now();
});
window.addEventListener('focus', () => {
  // Focus returning shortly after leaving means the prompt was answered or Claude opened.
  if (leftAt) setTimeout(() => window.close(), 1500);
});

if (ok) {
  // A short delay lets the page paint first, so the prompt has a visible tab to sit on.
  setTimeout(() => (location.href = target), 150);
}
