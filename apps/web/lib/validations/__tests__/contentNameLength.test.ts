import { describe, expect, it } from "vitest";

import { MAX_CONTENT_NAME_LENGTH } from "@/lib/validations/common";
import { layerMetadataSchema } from "@/lib/validations/layer";
import { projectLayerSchema } from "@/lib/validations/project";

/**
 * The server accepts names up to 255 characters, the client used to stop at 100.
 * A layer named longer than that (a catalog title, a rename through the API)
 * made `useActiveLayer`'s `projectLayerSchema.parse` throw, and its metadata
 * form could not be saved.
 */
const projectLayer = {
  id: 1,
  layer_id: "f99556c1-3442-4712-a947-c0dc804e1e9f",
  type: "feature",
  public_read: false,
  created_at: "2026-08-30T18:49:26.000Z",
  updated_at: "2026-08-30T18:49:26.000Z",
  properties: { visibility: true },
};

describe("content name length", () => {
  const longName = "x".repeat(150);

  it("parses a project layer with a name longer than 100 characters", () => {
    expect(projectLayerSchema.parse({ ...projectLayer, name: longName }).name).toBe(longName);
  });

  it("accepts a long name in the metadata form up to the server's limit", () => {
    expect(layerMetadataSchema.safeParse({ name: longName }).success).toBe(true);
    expect(layerMetadataSchema.safeParse({ name: "x".repeat(MAX_CONTENT_NAME_LENGTH) }).success).toBe(true);
    expect(layerMetadataSchema.safeParse({ name: "x".repeat(MAX_CONTENT_NAME_LENGTH + 1) }).success).toBe(
      false
    );
  });
});
