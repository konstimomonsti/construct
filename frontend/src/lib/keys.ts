/** Mac keyboards say ⌘; everyone else presses Ctrl */
export const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'
