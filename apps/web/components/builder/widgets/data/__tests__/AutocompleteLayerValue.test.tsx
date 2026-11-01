import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AutocompleteLayerValue from "@/components/builder/widgets/data/AutocompleteLayerValue";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CITIES = ["Dresden", "Leipzig", "Chemnitz", "Neustadt an der Weinstraße", "Neustadt in Holstein"];

// Stands in for the server: the debounced search filters like the CQL "like %text%".
// `loading` simulates results that have not arrived yet.
let loading = false;
vi.mock("@/hooks/map/DatasetHooks", () => ({
  useDatasetValueSelectorMethods: () => {
    const [searchText, setSearchText] = useState("");
    const [query, setQuery] = useState("");
    const items = CITIES.filter((c) => c.toLowerCase().includes(query.toLowerCase())).map((value) => ({
      value,
    }));
    return {
      data: loading ? { items: CITIES.map((value) => ({ value })) } : { items },
      isLoading: loading,
      searchText,
      setSearchText,
      debouncedSetSearchText: setQuery,
    };
  },
}));

const renderSingle = (selected: string | null, onChange = vi.fn()) => {
  render(
    <AutocompleteLayerValue
      selectedValues={selected}
      onSelectedValuesChange={onChange}
      layerId="layer"
      fieldName="name"
      placeholder="Suche"
    />
  );
  return onChange;
};

const typeInto = (text: string) => {
  const input = screen.getByRole("combobox");
  fireEvent.mouseDown(input);
  fireEvent.change(input, { target: { value: text } });
  return input;
};

describe("AutocompleteLayerValue (single)", () => {
  beforeEach(() => {
    loading = false;
  });

  it("does not keep the current value on top while typing another one", () => {
    renderSingle("Dresden");
    typeInto("Leipzig");
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Leipzig"]);
  });

  it("takes the best match on Enter when a value is already selected", () => {
    const onChange = renderSingle("Dresden");
    const input = typeInto("leipzig");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("Leipzig");
  });

  it("puts the exact match first when several values match", () => {
    renderSingle(null);
    typeInto("Neustadt in Holstein");
    expect(screen.getAllByRole("option")[0].textContent).toBe("Neustadt in Holstein");
  });

  it("waits for the matches when Enter comes before the results", () => {
    loading = true;
    const onChange = renderSingle("Dresden");
    // Stale list without a match for the typed text
    const input = typeInto("Zwickau");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects the best match once the results arrive after Enter", () => {
    loading = true;
    const onChange = vi.fn();
    const props = { onSelectedValuesChange: onChange, layerId: "layer", fieldName: "name" };
    const { rerender } = render(<AutocompleteLayerValue selectedValues="Dresden" {...props} />);
    const input = typeInto("Chemn");
    fireEvent.keyDown(input, { key: "Enter" });
    // Still loading: nothing is picked from the stale list
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      loading = false;
    });
    rerender(<AutocompleteLayerValue selectedValues="Dresden" {...props} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Chemnitz");
  });
});
