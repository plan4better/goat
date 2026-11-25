import { describe, expect, it } from "vitest";

import {
  popupFieldConfigOf,
  popupFieldInfo,
  selectPopupProperties,
  splitPopupProperties,
} from "@/lib/utils/map/popupProperties";
import { type Attribute, popupProperties } from "@/lib/validations/layer";

/** The field config of a popup with one field list (none without attributes). */
const fieldConfigOf = (attributes?: Attribute[]) =>
  popupFieldConfigOf(popupProperties.parse({ blocks: attributes ? [{ type: "fieldList", attributes }] : [] }));

describe("selectPopupProperties", () => {
  it("passes raw properties through unchanged when there is no field list", () => {
    const fieldConfig = fieldConfigOf();
    const raw = { name: "Berlin", population: 3700000 };
    expect(selectPopupProperties(fieldConfig, raw)).toBe(raw);
  });

  it("narrows to fieldOrder when a field list is configured", () => {
    const fieldConfig = fieldConfigOf([
              { name: "name", label: "Name", type: "string" },
              { name: "population", label: "Population", type: "number" },
            ]);
    const raw = { name: "Berlin", population: 3700000, extra_secret: "should not leak" };
    expect(selectPopupProperties(fieldConfig, raw)).toEqual({
      name: "Berlin",
      population: 3700000,
    });
  });

  it("skips a field-list entry whose name is a system property key, even though the raw key would be excluded anyway", () => {
    // This documents actual behavior: selectPopupProperties re-checks
    // isSystemPropertyKey per fieldOrder entry, so a field list that
    // (incorrectly) references a system key like "id" is dropped rather
    // than leaking the raw system value into the popup.
    const fieldConfig = fieldConfigOf([
              { name: "name", label: "Name", type: "string" },
              { name: "id", label: "Id", type: "string" },
            ]);
    const raw = { name: "Berlin", id: "abc-123" };
    expect(selectPopupProperties(fieldConfig, raw)).toEqual({ name: "Berlin" });
  });

  it("sets undefined for a fieldOrder entry missing from raw properties", () => {
    const fieldConfig = fieldConfigOf([{ name: "missing", type: "string" }]);
    const result = selectPopupProperties(fieldConfig, { other: "value" });
    expect(result).toEqual({ missing: undefined });
  });
});

describe("popupFieldInfo", () => {
  it("returns {} when there is no field list", () => {
    const fieldConfig = fieldConfigOf();
    expect(popupFieldInfo(fieldConfig)).toEqual({});
  });

  it("always includes fieldLabels/fieldOrder when a field list exists", () => {
    const fieldConfig = fieldConfigOf([{ name: "name", label: "Name", type: "string" }]);
    const info = popupFieldInfo(fieldConfig);
    expect(info.fieldOrder).toEqual(["name"]);
    expect(info.fieldLabels).toEqual({ name: "Name" });
    expect(info.fieldDecorators).toBeUndefined();
  });

  it("includes fieldDecorators only when non-empty", () => {
    const fieldConfig = fieldConfigOf([{ name: "area", label: "Area", type: "number", suffix: "ha" }]);
    const info = popupFieldInfo(fieldConfig);
    expect(info.fieldDecorators).toEqual({ area: { suffix: "ha" } });
  });
});

describe("splitPopupProperties", () => {
  it("returns empty buckets for undefined raw input", () => {
    expect(splitPopupProperties(undefined)).toEqual({ properties: {}, jsonProperties: {} });
  });

  it("routes JSON-object/array-parseable string values to jsonProperties", () => {
    const raw = {
      tags: '{"a":1,"b":2}',
      list: "[1,2,3]",
      name: "Berlin",
    };
    const result = splitPopupProperties(raw);
    expect(result.jsonProperties).toEqual({ tags: { a: 1, b: 2 }, list: [1, 2, 3] });
    expect(result.properties).toEqual({ name: "Berlin" });
  });

  it("routes object and array values (GeoJSON sources) to jsonProperties as they are", () => {
    const raw = { tags: { a: 1, b: 2 }, list: [1, 2, 3], name: "Berlin" };
    const result = splitPopupProperties(raw);
    expect(result.jsonProperties).toEqual({ tags: { a: 1, b: 2 }, list: [1, 2, 3] });
    expect(result.properties).toEqual({ name: "Berlin" });
  });

  it("keeps primitive/non-JSON-parseable values in properties, including numbers and null", () => {
    const raw = { population: 3700000, active: true, note: "hello world", nothing: null };
    const result = splitPopupProperties(raw);
    // JSON.parse(null) coerces to JSON.parse("null") -> null; the `parsedValue !== null`
    // guard rejects it, so it falls through to `properties` rather than `jsonProperties`.
    expect(result.jsonProperties).toEqual({});
    expect(result.properties).toEqual({
      population: 3700000,
      active: true,
      note: "hello world",
      nothing: null,
    });
  });

  it("excludes system property keys from both buckets", () => {
    const raw = {
      layer_id: 1,
      id: 2,
      _rowid: 3,
      feature_id: 4,
      h3_3: "x",
      h3_6: "y",
      cluster: true,
      clustered: true,
      point_count: 5,
      point_count_abbreviated: "5",
      sqrt_point_count: 2.2,
      ags_gemeinde: "0001",
      ags_landkreis: "01",
      name: "kept",
    };
    const result = splitPopupProperties(raw);
    expect(result.properties).toEqual({ name: "kept" });
    expect(result.jsonProperties).toEqual({});
  });
});

describe("popupFieldConfigOf", () => {
  it("a search result shows the fields the style's popup lists, labelled and in order", () => {
    const config = popupFieldConfigOf({
      enabled: true,
      blocks: [
        { id: "a", type: "title", text: "x" },
        {
          id: "b",
          type: "fieldList",
          attributes: [
            { name: "pop", label: "Population", type: "number", prefix: "~" },
            { name: "name", type: "string" },
          ],
        },
        { id: "c", type: "fieldList", attributes: [{ name: "pop", label: "Again", type: "number" }] },
      ],
    } as never);
    expect(config).toEqual({
      fieldOrder: ["pop", "name"],
      fieldLabels: { pop: "Population", name: "name" },
      fieldDecorators: { pop: { prefix: "~" } },
      hasFieldList: true,
    });
    expect(popupFieldConfigOf(undefined).hasFieldList).toBe(false);
  });
});
