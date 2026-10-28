// The style panel of dashboards and mobile maps: the layer's opacity, and for a published map's
// viewer the choice between the layer's named styles. What a change does (a style save, view state) is the caller's.
import { Box } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MapLayer } from "@/hooks/map/useMapLayers";

import { ChoiceRow } from "@/components/map/panels/styleEditor/rows/ChoiceRow";
import { SliderRow } from "@/components/map/panels/styleEditor/rows/SliderRow";

interface SimpleLayerStyleProps {
  layer: MapLayer | null | undefined;
  /** The released opacity. */
  onOpacityChange: (layer: MapLayer, opacity: number) => void;
  /** Another named style picked; only where the viewer may switch. */
  onStyleChange?: (layer: MapLayer, styleId: string) => void;
}

/** The viewer's opacity, else the style's (a zoom curve shows as fully opaque; a change replaces it). */
const opacityOf = (layer: MapLayer | null | undefined): number => {
  const styled = layer?.style?.document.opacity;
  return layer?.opacity ?? (typeof styled === "number" ? styled : 1);
};

const SimpleLayerStyle = ({ layer, onOpacityChange, onStyleChange }: SimpleLayerStyleProps) => {
  const { t } = useTranslation("common");
  const [opacity, setOpacity] = useState(() => opacityOf(layer));
  const stored = opacityOf(layer);
  // Another layer, or the stored value moved: follow it.
  useEffect(() => setOpacity(stored), [layer?.id, stored]);

  if (!layer) {
    return (
      <Box sx={{ p: 2 }}>
        <div>{t("no_layer_selected", { defaultValue: "No layer selected" })}</div>
      </Box>
    );
  }

  const styles = layer.style ? [layer.style, ...layer.otherStyles] : [];
  return (
    <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 0.5 }}>
      {onStyleChange && layer.style && styles.length > 1 && (
        <ChoiceRow
          label={t("style_editor.named_style")}
          value={layer.style.id}
          options={styles.map((style) => ({ value: style.id, label: style.name }))}
          onChange={(styleId) => {
            if (styleId !== layer.style?.id) onStyleChange(layer, styleId);
          }}
        />
      )}
      <SliderRow
        label={t("style_editor.opacity")}
        min={0}
        max={1}
        step={0.01}
        pct
        value={opacity}
        onChange={setOpacity}
        onCommit={(value) => onOpacityChange(layer, value)}
      />
    </Box>
  );
};

export default SimpleLayerStyle;
