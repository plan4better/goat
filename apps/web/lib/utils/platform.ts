/**
 * Which keyboard the person is on, for the modifier a shortcut hint names.
 *
 * Only Apple keyboards carry a Command key, so ⌘ must never be shown anywhere
 * else: a Windows or Linux reader sees a key they cannot press and concludes
 * the shortcut is broken, which is exactly what was reported.
 */

/** The parts of `navigator` this reads, so a caller can pass a stand-in. */
export interface PlatformInfo {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
}

/**
 * True on macOS, iPadOS and iOS. `navigator.platform` is deprecated but is
 * still the only signal most browsers give, so the modern hint is preferred
 * and it is the fallback. An iPad reports a Mac platform and belongs here
 * anyway: a keyboard attached to one has a Command key.
 */
export const isApplePlatform = (info: PlatformInfo): boolean => {
  const hinted = info.userAgentData?.platform;
  if (hinted) return /mac|ios/i.test(hinted);
  return /mac|iphone|ipad|ipod/i.test(info.platform || info.userAgent || "");
};

/**
 * How a Ctrl/Cmd shortcut is written on this platform: `⌘K` on Apple, where
 * the convention is the bare symbol, and `Ctrl+K` everywhere else, where it is
 * spelled out.
 */
export const shortcutLabel = (letter: string, info: PlatformInfo): string =>
  isApplePlatform(info) ? `⌘${letter}` : `Ctrl+${letter}`;

// Throwaway change to test the PR checks; this branch is never merged.
