import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type FilterExpression, FilterType } from "@/lib/validations/workflow";

import { LogicalConditionRow, logicalRowComplete } from "@/components/workflows/panels/IfNodeSettings";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const row = (expression: string, value: FilterExpression["value"], attribute = "open"): FilterExpression => ({
  id: "r1",
  type: FilterType.Logical,
  attribute,
  expression,
  value,
});

/** The text in the box with this placeholder. */
const boxValue = (placeholder: string) =>
  (screen.getByPlaceholderText(placeholder) as HTMLInputElement).value;

describe("if node logical condition row", () => {
  it("asks for no value for is true and is false", () => {
    render(
      <LogicalConditionRow
        expression={row("is_true", "")}
        fields={[{ name: "open", type: "boolean" }]}
        variables={[]}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.queryByText("select_value")).toBeNull();
  });

  it("takes a range as its two bounds, from and to", () => {
    const onUpdate = vi.fn();
    render(
      <LogicalConditionRow
        expression={row("is_between", ["2024-05-01", ""], "built")}
        fields={[{ name: "built", type: "date" }]}
        variables={[]}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
      />
    );
    expect(boxValue("from")).toBe("2024-05-01");
    fireEvent.change(screen.getByPlaceholderText("to"), { target: { value: "2024-05-31" } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ value: ["2024-05-01", "2024-05-31"] }));
  });

  it("shows a number range stored before as low-high text as its two bounds", () => {
    render(
      <LogicalConditionRow
        expression={row("is_between", "10-20", "pop")}
        fields={[{ name: "pop", type: "number" }]}
        variables={[]}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(boxValue("from")).toBe("10");
    expect(boxValue("to")).toBe("20");
  });
});

describe("logicalRowComplete", () => {
  it("needs no value for is true and is false, two for a range", () => {
    expect(logicalRowComplete(row("is_true", ""))).toBe(true);
    expect(logicalRowComplete(row("is_false", ""))).toBe(true);
    expect(logicalRowComplete(row("is_blank", ""))).toBe(true);
    expect(logicalRowComplete(row("is", ""))).toBe(false);
    expect(logicalRowComplete(row("is_between", ["2024-05-01", ""], "built"))).toBe(false);
    expect(logicalRowComplete(row("is_between", ["2024-05-01", "2024-05-31"], "built"))).toBe(true);
    expect(logicalRowComplete(row("is_not_between", "10-20", "pop"))).toBe(true);
  });
});
