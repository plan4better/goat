import { describe, expect, it } from "vitest";

import { commonT } from "@/i18n/__tests__/commonI18n";

/** The Metadata tab's Source and Address rows: every text in both languages, the service's kind in its name, no
 * dashes. */
const KEYS = ["source", "catalog", "address", "metadata.source_remote_file", "metadata.copy_address"];

describe("metadata origin texts", () => {
  it.each([
    ["en", "Remote file", "Map service (WMS)", "Address"],
    ["de", "Externe Datei", "Kartendienst (WMS)", "Adresse"],
  ] as const)("%s has every text, without dashes inside it", (language, remoteFile, wms, address) => {
    const t = commonT(language);
    for (const key of KEYS) {
      expect(t(key), key).not.toBe(key);
      expect(t(key), key).not.toMatch(/[–—]/);
    }
    expect(t("metadata.source_remote_file")).toBe(remoteFile);
    expect(t("metadata.source_map_service", { kind: "WMS" })).toBe(wms);
    expect(t("address")).toBe(address);
  });
});
