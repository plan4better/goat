"use client";

import { Box, alpha, darken, lighten, useTheme } from "@mui/material";
import type { ReactNode } from "react";
import { useState } from "react";

import { Icon } from "@p4b/ui/components/Icon";

import type { MarkKind } from "@/lib/catalog/kind";
import { markFor, toneColorOf, toneFor } from "@/lib/catalog/kind";

/** A card's picture: the item's own thumbnail when one is published, and a
 * drawn stand-in when not. Shared by the catalog's results and the Content
 * feed, so a dataset promoted out of the catalog keeps the picture it had. */

type Texture = "dots" | "raked" | "mesh" | "rules" | "pixels" | "graticule";

const textureFor = (kind: MarkKind, geometryType?: string | null): Texture => {
  if (kind === "table") return "rules";
  if (kind === "raster") return "pixels";
  switch (geometryType) {
    case "point":
      return "dots";
    case "line":
      return "raked";
    case "polygon":
      return "mesh";
    default:
      return "graticule";
  }
};

/** The ground pattern, as CSS gradients rather than an image or an SVG defs block: a tile is 32–200px wide and there can be 24 of them on screen, so the pattern has to cost nothing to paint and stay crisp at every size. */
const textureCss = (texture: Texture, line: string): string => {
  switch (texture) {
    case "dots":
      return `radial-gradient(${line} 1.4px, transparent 1.5px)`;
    case "raked":
      return `repeating-linear-gradient(28deg, ${line} 0 1.5px, transparent 1.5px 13px)`;
    case "mesh":
      return (
        `repeating-linear-gradient(60deg, ${line} 0 1.5px, transparent 1.5px 16px),` +
        `repeating-linear-gradient(-60deg, ${line} 0 1.5px, transparent 1.5px 16px)`
      );
    case "rules":
      return `repeating-linear-gradient(to bottom, ${line} 0 1.5px, transparent 1.5px 12px)`;
    case "pixels":
      return (
        `repeating-linear-gradient(to right, ${line} 0 1px, transparent 1px 10px),` +
        `repeating-linear-gradient(to bottom, ${line} 0 1px, transparent 1px 10px)`
      );
    case "graticule":
      return (
        `linear-gradient(to right, ${line} 1px, transparent 1px),` +
        `linear-gradient(to bottom, ${line} 1px, transparent 1px)`
      );
  }
};

const textureSize = (texture: Texture): string | undefined => {
  if (texture === "dots") return "11px 11px";
  if (texture === "pixels") return "10px 10px";
  if (texture === "graticule") return "14px 14px";
  return undefined;
};

type Props = {
  kind: MarkKind;
  /** The data's shape, where the item states one. */
  geometryType?: string | null;
  /**
   * `grid` is the catalog tile's 176px band, `card` the Content tile's shorter
   * 132px one, `list` a 200×130 tile beside the title, and `mark` a small
   * square for a phone — where a full-width band is 200px of decoration that
   * pushes the next item off the screen.
   */
  variant?: "grid" | "list" | "mark" | "card";
  /** Shown as a badge on a bundle. */
  memberCount?: number;
  href?: string;
  /** Overrides the band's own height — or, for `mark`, the square's side. */
  height?: number;
  /**
   * Drawn in the frame instead of the kind's texture mark whenever there is
   * no picture to show — no `href`, or an `href` that failed to load. What a
   * template card hands in is its preview scaffold, so the card shows the
   * same drawing its preview dialog does. Callers that leave it unset keep
   * the texture mark.
   */
  fallback?: ReactNode;
  /**
   * How the picture meets the frame. `cover` fills it and crops, which is
   * what a tile wants; `contain` shows the whole picture with letterboxing,
   * which is what a preview of an uploaded image wants — a user who framed
   * a map or a layout expects to see all of it.
   */
  fit?: "cover" | "contain";
};

const BAND_HEIGHT = { grid: 176, card: 132 } as const;

const ContentThumbnail = ({
  kind,
  geometryType,
  variant = "grid",
  memberCount,
  href,
  fit = "cover",
  height,
  fallback,
}: Props) => {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const dark = theme.palette.mode === "dark";
  // A project, a folder and a template are the things the catalog has no
  // picture for: there is no dataset to draw a stand-in of, so they take a
  // flat tint of the brand accent and their own glyph instead of the drawn
  // ground.
  const flat = kind === "project" || kind === "folder" || kind === "template";

  // Flat kinds take their own tone (project/folder = primary, template =
  // secondary) rather than one shared color, so a template reads as its own
  // kind next to a project or folder tile.
  const flatColor = toneColorOf(theme, toneFor(kind));

  /**
   * One cool-blue family, mixed from `info.main` so the drawn stand-in reads as
   * a picture rather than as a hole in the card, and so both themes are one
   * decision rather than four hand-picked hexes.
   */
  const ground = flat
    ? alpha(flatColor, 0.1)
    : dark
      ? darken(theme.palette.info.main, 0.88)
      : lighten(theme.palette.info.main, 0.95);
  const accent = flat
    ? flatColor
    : dark
      ? lighten(theme.palette.info.main, 0.42)
      : darken(theme.palette.info.main, 0.5);
  const pattern = alpha(accent, dark ? 0.2 : 0.14);

  const frame = {
    position: "relative",
    flexShrink: 0,
    overflow: "hidden",
    borderRadius: 2,
    // A height, not a ratio: `aspect-ratio` against a percentage width contributes
    // nothing to how tall the card says it is, so a grid row sized itself without
    // counting this band and the card's own body spilled past its clipped edge.
    ...(variant === "mark"
      ? { width: height ?? 44, height: height ?? 44 }
      : variant === "list"
        ? { width: 200, height: 130 }
        : { width: "100%", height: height ?? BAND_HEIGHT[variant] }),
  } as const;

  if (href && !failed) {
    return (
      <Box sx={frame}>
        <Box
          component="img"
          src={href}
          alt=""
          loading="lazy"
          // A dead thumbnail falls back to the stand-in rather than leaving a
          // broken-image glyph in the grid.
          onError={() => setFailed(true)}
          sx={{ width: "100%", height: "100%", objectFit: fit, display: "block" }}
        />
      </Box>
    );
  }

  // Nothing to show: a caller's own drawing takes the frame the image would
  // have filled, so an item with no picture and one whose picture is dead
  // both land on the same stand-in.
  if (fallback) {
    return (
      <Box sx={{ ...frame, display: "flex", alignItems: "center", justifyContent: "center" }}>{fallback}</Box>
    );
  }

  const texture = textureFor(kind, geometryType);

  return (
    <Box
      data-testid="content-thumbnail-mark"
      sx={{
        ...frame,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: ground,
      }}
      aria-hidden>
      {!flat && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            backgroundImage: textureCss(texture, pattern),
            backgroundSize: textureSize(texture),
            // Centred so the pattern is symmetrical in the frame whatever the tile's size — a graticule cropped hard on one edge looks like a rendering mistake.
            backgroundPosition: "center",
          }}
        />
      )}
      <Icon
        iconName={markFor({ kind, geometryType })}
        style={{
          fontSize: variant === "mark" ? 17 : 30,
          // Above the texture, and given a little air so the pattern does not
          // read as part of the glyph.
          position: "relative",
          filter: flat ? undefined : `drop-shadow(0 0 6px ${ground})`,
        }}
        htmlColor={accent}
      />
      {/* No count badge on a small mark — the card's own footer says how many. */}
      {kind === "bundle" && !!memberCount && variant !== "mark" && (
        <Box
          sx={{
            position: "absolute",
            // Top-right on a row, bottom-right on a tile, where the save control does not sit.
            ...(variant === "list" ? { top: 8 } : { bottom: 8 }),
            right: 8,
            minWidth: 24,
            height: 24,
            px: 1,
            borderRadius: "999px",
            // A neutral scrim, not the brand's dark green: the chip states a
            // number, it is not something to act on.
            backgroundColor: alpha(theme.palette.common.black, dark ? 0.66 : 0.52),
            color: theme.palette.common.white,
            fontSize: 12,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
          {memberCount}
        </Box>
      )}
    </Box>
  );
};

export default ContentThumbnail;
