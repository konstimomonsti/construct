// Apply the saved theme before first paint.
try {
  if (localStorage.getItem('billbuild-theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark'
    document.querySelector('meta[name="theme-color"]').content = '#0d0502'
  }
} catch {
  // Storage may be unavailable in private browsing.
}
