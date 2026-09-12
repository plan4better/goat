import { Box, Link, Typography, debounce } from "@mui/material";
import { styled } from "@mui/material/styles";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";

import { ICON_NAME } from "@p4b/ui/components/Icon";

import AppDialog from "@/components/common/AppDialog";

interface AttributionControlProps {
  compact?: boolean;
  customAttribution?: string | Array<string>;
  extraAttribution?: string | null;
}

const GOAT_HREF = "https://www.plan4better.de/en/goat";

// Wraps the (localized) branding label in the GOAT link. "GOAT" is the product
// name and stays as-is; only the surrounding phrase is translated by the caller.
export const goatAttribution = (label: string): string =>
  `<a href="${GOAT_HREF}" target="_blank">${label}</a>`;

export const DEFAULT_ATTRIBUTIONS = [goatAttribution("Made with GOAT")];

export interface AttributionParts {
  madeWith: string[];
  dataSources: string[];
}

export function buildAttributionParts(
  customAttribution: string | string[],
  extraAttribution: string | null | undefined,
  sourceAttributions: string[]
): AttributionParts {
  const madeWith = (Array.isArray(customAttribution) ? customAttribution : [customAttribution])
    .map((s) => String(s).trim())
    .filter(Boolean);

  let dataSources = [...(extraAttribution ? [extraAttribution] : []), ...sourceAttributions]
    .map((s) => String(s).trim())
    .filter(Boolean);

  // Dedupe: drop any entry that is a substring of a longer one (matches legacy behavior).
  dataSources.sort((a, b) => a.length - b.length);
  dataSources = dataSources.filter((attrib, i) => {
    for (let j = i + 1; j < dataSources.length; j++) {
      if (dataSources[j].includes(attrib)) return false;
    }
    return true;
  });

  return { madeWith, dataSources };
}

const Container = styled(Box)(() => ({
  display: "flex",
  alignItems: "center",
  // Cap to the viewport (parent corner boxes are content-sized, so `100%` alone
  // never bounds the strip) — this is what lets the text clip and reveal "more"
  // instead of running off the edge on narrow screens. Full 100vw so the strip
  // spans edge-to-edge on mobile and "more" sits at the right edge.
  maxWidth: "100vw",
  padding: "0px 4px",
  borderRadius: "2px",
  fontSize: "10px",
  zIndex: 1,
  pointerEvents: "all",
  backgroundColor: "hsla(0,0%,100%,.5)",
}));

const linkSx = {
  color: "inherit",
  textDecoration: "none",
  "&:hover": { textDecoration: "underline" },
} as const;

const AttributionControl: React.FC<AttributionControlProps> = ({ customAttribution, extraAttribution }) => {
  const { t } = useTranslation("common");
  /**
   * `current` first: it is the map this control is mounted *inside*, so it is right
   * whenever it exists. `map` — the project map, which `MapProvider` registers under
   * that id — is the fallback for the project layouts, where the control sits in a
   * corner box outside the map.
   *
   * The order matters: with the Add Layer modal open over a project map, both are
   * defined, and preferring the registry made a preview map's strip credit the
   * project's sources instead of its own.
   */
  const { map: projectMap, current } = useMap();
  const map = current ?? projectMap;
  const [parts, setParts] = useState<AttributionParts>({ madeWith: [], dataSources: [] });
  const [overflowing, setOverflowing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);

  const updateAttributions = useCallback(() => {
    const sources = map?.getStyle()?.sources ?? {};
    const sourceAttributions: string[] = [];
    for (const id in sources) {
      // The live source first, then the style's own spec. A source declared
      // with a `url` carries its credit in the TileJSON, which MapLibre merges
      // onto the source object but not into the style `getStyle()` serializes
      // — that returns the spec as written. OpenFreeMap credits itself,
      // OpenMapTiles and OpenStreetMap that way, so reading only the spec
      // leaves an OSM-derived basemap with no attribution at all.
      const live = (map?.getSource?.(id) as { attribution?: string } | undefined)?.attribution;
      const a = live ?? (sources[id] as { attribution?: string }).attribution;
      if (a) sourceAttributions.push(a);
    }
    const custom = customAttribution ?? [goatAttribution(t("made_with_goat"))];
    setParts(buildAttributionParts(custom, extraAttribution, sourceAttributions));
  }, [map, customAttribution, extraAttribution, t]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedUpdateAttributions = useCallback(debounce(updateAttributions, 200), [updateAttributions]);

  useEffect(() => {
    if (!map) return;
    map.on("styledata", debouncedUpdateAttributions);
    map.on("sourcedata", debouncedUpdateAttributions);
    map.on("terrain", debouncedUpdateAttributions);
    updateAttributions();
    return () => {
      map.off("styledata", debouncedUpdateAttributions);
      map.off("sourcedata", debouncedUpdateAttributions);
      map.off("terrain", debouncedUpdateAttributions);
      debouncedUpdateAttributions.clear();
    };
  }, [map, debouncedUpdateAttributions, updateAttributions]);

  // Overflow detection: show the "more" link only when the single line is clipped.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => el.scrollWidth > el.clientWidth;
    // Initial measurement runs synchronously as part of this effect (already
    // inside React's commit), so a plain setState is enough.
    setOverflowing(measure());
    // Later ResizeObserver callbacks fire outside React's normal event/commit
    // loop (in real browsers, and in tests that invoke the observer callback
    // directly), so a plain setState there can be left un-flushed until the
    // next React-driven tick. flushSync forces the commit immediately.
    const ro = new ResizeObserver(() => flushSync(() => setOverflowing(measure())));
    ro.observe(el);
    return () => ro.disconnect();
  }, [parts]);

  const hasContent = parts.madeWith.length > 0 || parts.dataSources.length > 0;
  const dataFromHtml =
    parts.dataSources.length > 0 ? `${t("data_from")} ${parts.dataSources.join(", ")}` : "";
  const inlineHtml = [parts.madeWith.join(". "), dataFromHtml].filter(Boolean).join(". ");

  return (
    <>
      <Container>
        <Typography
          ref={textRef}
          data-testid="attribution-text"
          variant="caption"
          component="div"
          sx={{
            color: "rgba(0,0,0,.75)",
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            "& a": linkSx,
          }}
          dangerouslySetInnerHTML={{
            __html: hasContent ? inlineHtml : t("no_attribution_available"),
          }}
        />
        {overflowing && (
          <Link
            component="button"
            type="button"
            variant="caption"
            onClick={() => setModalOpen(true)}
            sx={{ ...linkSx, flexShrink: 0, ml: 0.5, color: "rgba(0,0,0,.75)", textDecoration: "underline" }}>
            {t("show_more")}
          </Link>
        )}
      </Container>

      <AppDialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        icon={ICON_NAME.INFO}
        title={t("attributions")}
        maxWidth={444}>
        {parts.dataSources.length > 0 && (
          <>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
              {t("data_from")}
            </Typography>
            <Typography
              variant="body2"
              sx={{ "& a": { color: "primary.main" } }}
              dangerouslySetInnerHTML={{ __html: parts.dataSources.join("<br/>") }}
            />
          </>
        )}
      </AppDialog>
    </>
  );
};

export default AttributionControl;
