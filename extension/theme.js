/* Optimizers brand: dark by default, light behind a toggle, choice remembered. */
(function () {
  let theme = 'dark';
  try { theme = localStorage.getItem('theme') === 'light' ? 'light' : 'dark'; } catch (_) {}
  document.documentElement.setAttribute('data-theme', theme);
  function apply(next) {
    theme = next; document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (_) {}
    const logo = document.getElementById('brandLogo'), button = document.getElementById('theme-toggle');
    if (logo) logo.src = theme === 'dark' ? 'assets/optimizers-logo-white.png' : 'assets/optimizers-logo-black.png';
    if (button) button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  document.addEventListener('DOMContentLoaded', () => {
    apply(theme);
    document.getElementById('theme-toggle').addEventListener('click', () => apply(theme === 'dark' ? 'light' : 'dark'));
  });
})();
