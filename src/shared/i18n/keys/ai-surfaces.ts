/**
 * i18n keys owned EXCLUSIVELY by the ai-surfaces screens.
 *
 * Split out of en.ts deliberately: `t()` is typed on `keyof typeof en`, so every
 * new screen must add keys, and when several authors append to one 10k-line file
 * concurrently the last writer silently wins — that is how 297 keys were lost
 * once already. One file per author, spread into `en`, removes the race.
 */
export const keysAiSurfaces = {} as const;
