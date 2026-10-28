"use client";

// An icon reference drawn small: library symbols in the text color (from the symbols file once it is there, their SVG
// as a mask before), emoji and uploads as their own images. Icons by zoom as their icons in order.
import { Box } from "@mui/material";
import { Fragment, type ReactNode } from "react";

import { defaultResolveIcon } from "@/lib/style/compile/images";

import {
  type LibrarySymbol,
  iconBackground,
  useSymbols,
} from "@/components/map/panels/styleEditor/pickers/iconRefs";

/** A library icon in the text color: drawn from the symbols file, or while that does not load, its SVG as a mask. */
export function SymbolGlyph({
  symbol,
  url,
  size = 20,
  color = "text.primary",
}: {
  symbol?: LibrarySymbol;
  url?: string;
  size?: number;
  /** The tint: the text's color, or the icon color on a marker's shape. */
  color?: string;
}) {
  if (symbol)
    return (
      <Box
        component="svg"
        viewBox={symbol.viewBox}
        aria-hidden="true"
        sx={{ width: size, height: size, color, fill: "currentColor" }}>
        {symbol.paths.map((d, i) => (
          <path
            key={i}
            d={d}
            fillRule={symbol.evenodd ? "evenodd" : undefined}
            clipRule={symbol.evenodd ? "evenodd" : undefined}
          />
        ))}
      </Box>
    );
  if (!url) return <Box sx={{ width: size, height: size }} />;
  const mask = `url("${url}")`;
  return (
    <Box
      sx={{ width: size, height: size, bgcolor: color }}
      style={{
        maskImage: mask,
        WebkitMaskImage: mask,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}

export function IconGlyph({ iconRef, size = 18, color }: { iconRef: string; size?: number; color?: string }) {
  const symbols = useSymbols();
  if (iconRef.startsWith("goat:"))
    return (
      <SymbolGlyph
        symbol={symbols?.get(iconRef.slice("goat:".length))}
        url={defaultResolveIcon(iconRef)?.url}
        size={size}
        color={color}
      />
    );
  const background = iconBackground(iconRef);
  return background ? (
    <Box aria-hidden="true" sx={{ width: size, height: size, flex: "none", background }} />
  ) : null;
}

/** The icons of a value by zoom, in zoom order with arrows between ("⊗ → 📡"); their names on hover and for screen
 * readers. */
export function IconStops({
  value,
  name,
  size = 16,
  renderIcon,
}: {
  value: unknown;
  name: (ref: string) => string;
  size?: number;
  /** Draws one stop's icon (in the marker's shape); the icon alone without. */
  renderIcon?: (ref: string, size: number) => ReactNode;
}) {
  const stops =
    value && typeof value === "object" && "zoom" in value && Array.isArray(value.zoom) ? value.zoom : [];
  const refs = stops.map((stop) => (Array.isArray(stop) ? stop[1] : undefined));
  const names = refs.map((ref) => (typeof ref === "string" ? name(ref) : "…")).join(" → ");
  return (
    <Box
      component="span"
      role="img"
      aria-label={names}
      title={names}
      sx={{ display: "inline-flex", alignItems: "center", gap: 1, verticalAlign: "middle" }}>
      {refs.map((ref, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <Box component="span" aria-hidden="true" sx={{ color: "text.secondary" }}>
              →
            </Box>
          )}
          {typeof ref === "string" ? (
            (renderIcon?.(ref, size) ?? <IconGlyph iconRef={ref} size={size} />)
          ) : (
            <span>…</span>
          )}
        </Fragment>
      ))}
    </Box>
  );
}
