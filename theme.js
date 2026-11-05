// Loaded synchronously in <head>, before the body is parsed, so the saved (or
// system) theme is applied before the first paint instead of after app.js has
// downloaded; app.js keeps the full theme logic (toggle buttons, live changes).
(function () {
  let mode = 'auto';
  try { mode = localStorage.getItem('theme') || 'auto'; } catch (_) {}
  const light = mode === 'light' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = light ? '#f8fafc' : '#0c0f1a';
})();
