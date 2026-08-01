/**
 * i18n keys for the installable app (PWA) — the install button, the iOS guide, the update notice.
 *
 * THE WORDING ASSUMES NO TECHNICAL VOCABULARY. Not "PWA", not "progressive web app", not
 * "add to home screen" as a concept the reader is expected to already know. The staff using
 * this are stewards, housekeepers and kitchen staff; the copy says what happens ("the icon
 * appears on your phone") rather than what it is called.
 *
 * THE iOS STEPS QUOTE SAFARI'S ACTUAL MENU WORDING — "Share", "Add to Home Screen" — because
 * paraphrasing a menu the reader is staring at is worse than saying nothing.
 */
export const keysPwa = {
  "pwa.install.title": "Get the app on your phone",
  "pwa.install.body":
    "Opens straight from your home screen — full screen, no address bar. Same login, same data.",
  "pwa.install.action": "Install app",
  "pwa.install.declined": "Not installed. You can tap Install app again whenever you like.",

  "pwa.guide.title": "Two taps and it is yours",
  "pwa.guide.iosLead": "iPhone does this from the Share menu. It takes a moment.",
  "pwa.guide.otherLead": "Your browser does this from its menu. It takes a moment.",

  "pwa.guide.iosStep1": "Tap the Share button",
  "pwa.guide.iosStep2": "Tap “Add to Home Screen”, then “Add”",
  "pwa.guide.iosWhere": "The Share button is at the bottom of your screen",

  "pwa.guide.otherStep1": "Open the browser menu",
  "pwa.guide.otherStep2": "Tap “Install app” or “Add to Home screen”",

  "pwa.guide.done": "Got it",

  "pwa.update.title": "A new version is ready",
  "pwa.update.body": "Reload to use it. Anything you have typed will be lost, so finish first.",
  "pwa.update.action": "Reload now",
  "pwa.update.later": "Later",
} as const;
