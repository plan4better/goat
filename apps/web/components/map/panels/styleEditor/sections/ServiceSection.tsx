"use client";

// A map service layer (spec 9.8): it sends finished pictures, so it draws as an image, in one of the styles the
// service offers. The styles come from the layer's configuration (stored when the layer was added) or, for a layer
// added before that, from the service's capabilities.
import { useTranslation } from "react-i18next";
import useSWR from "swr";

import { type ServiceStyle, parseCapabilities } from "@/lib/utils/externalService";

import { useEditor, useStyleData, useStyleValue } from "@/components/map/panels/styleEditor/context";
import { ChoiceRow, PanelSection } from "@/components/map/panels/styleEditor/rows";

type Service = NonNullable<ReturnType<typeof useStyleData>["service"]>;

/** The styles of the service's one layer: stored, else read from its capabilities; none when that read fails. */
function useServiceStyles(service: Service | undefined): ServiceStyle[] {
  const live =
    !!service && !service.styles.length && service.kind === "wms" && service.layerNames.length === 1;
  const { data } = useSWR(live ? ["service-styles", service.url, service.layerNames[0]] : null, async () => {
    if (!service) return [];
    const address = `${service.url.split("?")[0]}?SERVICE=WMS&REQUEST=GetCapabilities`;
    const response = await fetch(address, { headers: { Accept: "application/xml, text/xml, */*" } });
    if (!response.ok) return [];
    const capabilities = parseCapabilities(address, await response.text());
    const layer = capabilities.groups
      .flatMap((group) => group.layers)
      .find((candidate) => candidate.id === service.layerNames[0]);
    return layer?.styles ?? [];
  });
  if (!service) return [];
  return service.styles.length ? service.styles : (data ?? []);
}

/** The legend image of the style the layer draws in (spec 9.8), else the layer's legend image. */
export function useServiceLegendUrl(): string | undefined {
  const { service } = useStyleData();
  const styles = useServiceStyles(service);
  const chosen = useStyleValue<unknown>("render.service_style");
  const style = typeof chosen === "string" ? styles.find((s) => s.name === chosen) : undefined;
  return style?.legendUrl ?? service?.legendUrl;
}

export function ServiceSection() {
  const { service } = useStyleData();
  if (!service) return null;
  return <ServiceRows service={service} />;
}

function ServiceRows({ service }: { service: Service }) {
  const { t } = useTranslation("common");
  const store = useEditor();
  const styles = useServiceStyles(service);
  const chosen = useStyleValue<unknown>("render.service_style");
  // WMS lists one style per layer: the choice is offered for a layer of one service layer (spec 9.8).
  const choice = service.kind === "wms" && service.layers === 1 && styles.length > 1;
  const label = t("style_editor.service_style");
  return (
    <PanelSection title={t("style_editor.section_general")}>
      <ChoiceRow<string>
        label={t("style_editor.draw_as")}
        value="image"
        fixed
        options={[{ value: "image", label: t("style_editor.raster_type_image") }]}
        onChange={() => undefined}
      />
      {choice && (
        <ChoiceRow<string>
          label={label}
          value={typeof chosen === "string" ? chosen : styles[0].name}
          options={styles.map((style) => ({ value: style.name, label: style.title }))}
          onChange={(name) => store.set("render.service_style", name === styles[0].name ? undefined : name)}
        />
      )}
    </PanelSection>
  );
}
