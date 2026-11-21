import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

/** The Source and Address rows of the Metadata tab and the dataset detail: every text in both languages, the format or
 * the service's kind in its name, no dashes. */
const KEYS = [
  "source",
  "catalog",
  "address",
  "metadata.source_remote_file",
  "metadata.source_map_service",
  "metadata.source_wfs_copy",
  "metadata.copy_address",
];

describe("metadata origin texts", () => {
  it.each([
    ["en", "Remote file (COG)", "Map service (WMS)", "Copied from WFS", "Address"],
    ["de", "Externe Datei (COG)", "Kartendienst (WMS)", "Kopie aus WFS", "Adresse"],
  ] as const)("%s has every text, without dashes inside it", (language, remoteFile, wms, wfs, address) => {
    const t = commonT(language);
    for (const key of KEYS) {
      expect(t(key), key).not.toBe(key);
      expect(t(key), key).not.toMatch(/[–—]/);
    }
    expect(t("metadata.source_remote_file", { kind: "COG" })).toBe(remoteFile);
    expect(t("metadata.source_map_service", { kind: "WMS" })).toBe(wms);
    expect(t("metadata.source_wfs_copy")).toBe(wfs);
    expect(t("address")).toBe(address);
  });
});
