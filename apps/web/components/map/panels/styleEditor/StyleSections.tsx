"use client";

// The Style sections of a layer by kind (spec 7): what the panel shows on the project page and on the dev route.
import type { EditorLayer } from "@/components/map/panels/styleEditor/StyleEditor";
import { ClusterSection } from "@/components/map/panels/styleEditor/sections/ClusterSection";
import { GeneralSection } from "@/components/map/panels/styleEditor/sections/GeneralSection";
import { H3Section } from "@/components/map/panels/styleEditor/sections/H3Section";
import { HeatmapSection } from "@/components/map/panels/styleEditor/sections/HeatmapSection";
import { LayerSection } from "@/components/map/panels/styleEditor/sections/LayerSection";
import { LegendSection } from "@/components/map/panels/styleEditor/sections/LegendSection";
import { PopupSection } from "@/components/map/panels/styleEditor/sections/PopupSection";
import { RasterColorSection } from "@/components/map/panels/styleEditor/sections/RasterColorSection";
import { RasterGeneralSection } from "@/components/map/panels/styleEditor/sections/RasterGeneralSection";
import { RasterLayerSection } from "@/components/map/panels/styleEditor/sections/RasterLayerSection";
import { RasterPopupSection } from "@/components/map/panels/styleEditor/sections/RasterPopupSection";
import { RulesSection } from "@/components/map/panels/styleEditor/sections/RulesSection";
import { ServiceSection } from "@/components/map/panels/styleEditor/sections/ServiceSection";
import { SymbolSection } from "@/components/map/panels/styleEditor/sections/SymbolSection";

export function StyleSections({ kind }: { kind: EditorLayer["kind"] }) {
  if (kind === "vector")
    return (
      <>
        <GeneralSection />
        <HeatmapSection />
        <ClusterSection />
        <H3Section />
        <SymbolSection />
        <RulesSection />
        <LayerSection />
        <LegendSection />
        <PopupSection />
      </>
    );
  return (
    <>
      {kind === "raster" && <RasterGeneralSection />}
      {kind === "service" && <ServiceSection />}
      {kind === "raster" && <RasterColorSection />}
      <RasterLayerSection service={kind === "service"} />
      <LegendSection />
      {kind === "raster" && <RasterPopupSection />}
    </>
  );
}
