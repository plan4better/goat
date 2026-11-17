"use client";

// An icon reference drawn small: library symbols in the text color (from the symbols file once it is there, their SVG
// as a mask before), emoji and uploads as their own images, a placeholder where one does not load. Icons by zoom as
// their icons in order.
import { Box } from "@mui/material";
import { Fragment, type ReactNode, useState } from "react";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { defaultResolveIcon } from "@/lib/style/compile/images";

import { type LibrarySymbol, useSymbols } from "@/components/map/panels/styleEditor/pickers/iconRefs";

/** An upload's or an emoji's image in a `size` px square; where it does not load, a neutral image glyph instead of the
 * browser's broken image. Loaded as a CORS request, as the map loads icons to draw them onto a canvas, so both share
 * what the browser caches for the URL. */
export function IconImage({ src, size }: { src: string; size: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src)
    return (
      <Box
        component="span"
        data-icon-failed
        aria-hidden="true"
        sx={{
          width: size,
          height: size,
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
        <Icon
          iconName={ICON_NAME.IMAGE}
          sx={{ fontSize: Math.round(size * 0.75), color: "text.secondary" }}
        />
      </Box>
    );
  return (
    <Box
      component="img"
      src={src}
      alt=""
      crossOrigin="anonymous"
      onError={() => setFailed(src)}
      sx={{ width: size, height: size, flex: "none", objectFit: "contain" }}
    />
  );
}

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
  const url = defaultResolveIcon(iconRef)?.url;
  return url ? <IconImage src={url} size={size} /> : null;
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
