// Applies the stored theme before React loads so a PWA launch paints the
// right background and status-bar color immediately (no light flash).
// Mirrors theme-provider.tsx — keep storage keys, resolution, and colors in sync.
(function () {
  try {
    var theme = localStorage.getItem('splitup-theme');
    var variant = localStorage.getItem('splitup-dark-variant');
    if (variant !== 'dark' && variant !== 'amoled') {
      variant = theme === 'amoled' ? 'amoled' : 'dark';
    }
    if (theme !== 'light' && theme !== 'dark' && theme !== 'amoled' && theme !== 'system') {
      theme = 'light';
    }
    var resolved =
      theme === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches
          ? variant
          : 'light'
        : theme;
    var root = document.documentElement;
    root.classList.toggle('dark', resolved !== 'light');
    root.classList.toggle('amoled', resolved === 'amoled');
    var colors = { light: '#f3f0ee', dark: '#161514', amoled: '#000000' };
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      metas[i].setAttribute('content', colors[resolved]);
    }
  } catch (e) {
    /* first paint falls back to the static metas */
  }
})();
