/**
 * i18n keys for the installable app (PWA) — the install offer and the update notice.
 *
 * THE WORDING AVOIDS "DOWNLOAD FROM THE STORE", because it is not from a store and saying so
 * would send people looking for it there. It is the same system, added to the home screen, and
 * the copy says that plainly.
 *
 * The iOS steps quote Safari's ACTUAL menu wording — "Share", "Add to Home Screen" — because
 * paraphrased instructions for a menu the reader is staring at are worse than none.
 */
export const keysPwa = {
  "pwa.install.title": "Add TT HRMS to your phone",
  "pwa.install.body":
    "Opens from your home screen like an app — full screen, no address bar. It is this same system, not a separate download.",
  "pwa.install.action": "Install app",
  "pwa.install.howTo": "How to add it",

  "pwa.install.iosTitle": "On iPhone or iPad, in Safari",
  "pwa.install.ios1": "Tap the Share button at the bottom of the screen.",
  "pwa.install.ios2": "Scroll down the list and tap “Add to Home Screen”.",
  "pwa.install.ios3": "Tap “Add”. The Tamarind Tree icon appears on your home screen.",

  "pwa.install.otherTitle": "In your browser menu",
  "pwa.install.other1": "Open the browser menu (⋮ or ⋯).",
  "pwa.install.other2": "Choose “Install app” or “Add to Home screen”.",

  "pwa.update.title": "A new version is ready",
  "pwa.update.body": "Reload to use it. Anything you have typed will be lost, so finish first.",
  "pwa.update.action": "Reload now",
  "pwa.update.later": "Later",
} as const;
