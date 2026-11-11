import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(path.join(__dirname, "..", "..", "..", file), "utf8");
const staticImports = (text: string) =>
  [...text.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

describe("dashboard header imports", () => {
  it("keeps maplibre, the project menu and its dialogs out of the shared header", () => {
    const imports = staticImports(source("components/header/Header.tsx"));
    for (const heavy of [
      "@/components/header/ProjectMenu",
      "maplibre-gl",
      "react-map-gl/maplibre",
      "@/components/modals/Metadata",
      "@/components/modals/ContentDelete",
      "@/components/modals/content/ProjectShareDialog",
      "@/components/templates/SaveTemplateDialog",
    ]) {
      expect(imports, heavy).not.toContain(heavy);
    }
  });

  it("loads the onboarding tray's Add Layer dialog on first open", () => {
    expect(staticImports(source("hooks/dashboard/home/useHomeCreate.tsx"))).not.toContain(
      "@/components/addLayer/AddLayerDialog"
    );
  });
});
