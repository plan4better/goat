import type { Theme } from "@mui/material";

/** A stable hue for one account, from its id: the same person gets the same
 * colour on every card, row and list, so initials avatars tell people apart
 * at a glance without being read. */
const hueOf = (seed: string): number => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
};

/** Background and ink for an initials avatar: a tinted ground with legible
 * ink in both themes — muted on light paper, deeper on dark. */
export const avatarPalette = (seed: string, theme: Theme): { bgcolor: string; color: string } => {
  const hue = hueOf(seed);
  return theme.palette.mode === "dark"
    ? { bgcolor: `hsl(${hue} 32% 30%)`, color: `hsl(${hue} 55% 86%)` }
    : { bgcolor: `hsl(${hue} 48% 88%)`, color: `hsl(${hue} 45% 30%)` };
};

// Built with the constructor: the shared tsconfig targets es5, so TypeScript
// refuses the `u` flag in a literal; every browser GOAT supports runs it.
const LETTER = new RegExp("\\p{L}", "u");

/** Up to two initials from a display name — "Marie Klein" → "MK". Words
 * without a letter (a team name's "-", a year) are skipped — "Harthof - P4B"
 * → "HP" — unless no word has one. */
export const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const lettered = words.filter((word) => LETTER.test(word));
  return (lettered.length ? lettered : words)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
};
