import { act } from "@testing-library/react";
import { Profiler } from "react";
import { describe, expect, it } from "vitest";

import { useStyleValue } from "@/components/map/panels/styleEditor/context";

import { renderPanel } from "./renderPanel";

function Probe({ path }: { path: string }) {
  const value = useStyleValue(path);
  return <span>{String(value)}</span>;
}

describe("style editor context", () => {
  it("an edit re-renders only the rows that read the path", () => {
    const commits: Record<string, number> = {};
    const count = (id: string) => {
      commits[id] = (commits[id] ?? 0) + 1;
    };
    const paths = ["symbol.fill.color", "symbol.fill.opacity", "symbol.outline.width"];
    const { store, getByText } = renderPanel(
      <>
        {paths.map((path) => (
          <Profiler key={path} id={path} onRender={count}>
            <Probe path={path} />
          </Profiler>
        ))}
      </>,
      {
        document: {
          version: 1,
          kind: "vector",
          symbol: { fill: { color: "#cccccc", opacity: 0.5 }, outline: { width: 1 } },
        },
      }
    );
    for (const path of paths) commits[path] = 0;
    act(() => store.set("symbol.fill.color", "#ff0000"));
    expect(getByText("#ff0000")).toBeDefined();
    expect(commits).toEqual({ "symbol.fill.color": 1, "symbol.fill.opacity": 0, "symbol.outline.width": 0 });
  });
});
