import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FieldInfo, FieldProfile, ProfileSource } from "@/components/map/panels/styleEditor/context";
import { FieldPicker } from "@/components/map/panels/styleEditor/pickers/FieldPicker";

import { renderPanel } from "./renderPanel";

/** Profiles the test answers by hand. */
function source() {
  const cache = new Map<string, FieldProfile>();
  const listeners = new Set<() => void>();
  const load = vi.fn();
  const profiles: ProfileSource = {
    get: (field) => cache.get(field),
    load,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const arrive = (field: string, profile: FieldProfile) => {
    cache.set(field, profile);
    listeners.forEach((listener) => listener());
  };
  return { profiles, load, arrive };
}

const FIELDS: FieldInfo[] = Array.from({ length: 50 }, (_, i) => ({
  name: `n${i}`,
  type: "number" as const,
  label: `n${i}`,
}));

describe("field picker profiles", () => {
  it("a long list asks for no profiles; a search that narrows it asks for the fields shown", () => {
    const { profiles, load } = source();
    renderPanel(
      <FieldPicker
        fields={FIELDS}
        onChange={() => undefined}
        profile={(_, p) => (p ? `${p.min} to ${p.max}` : undefined)}
      />,
      { data: { profiles } }
    );
    expect(load).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "style_editor.search_fields" }), {
      target: { value: "n4" },
    });
    expect(load.mock.calls.map(([field]) => field).sort()).toEqual(
      ["n4", "n40", "n41", "n42", "n43", "n44", "n45", "n46", "n47", "n48", "n49"].sort()
    );
  });

  it("a profile that arrives while the picker is open shows at once", () => {
    const { profiles, arrive } = source();
    renderPanel(
      <FieldPicker
        fields={FIELDS.slice(0, 3)}
        onChange={() => undefined}
        profile={(_, p) => (p ? `${p.min} to ${p.max}` : undefined)}
      />,
      { data: { profiles } }
    );
    expect(screen.queryByText("12 to 9800")).toBeNull();
    act(() => arrive("n1", { min: 12, max: 9800 }));
    expect(screen.getByText("12 to 9800")).toBeDefined();
  });
});
