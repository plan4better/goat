// The panel's notes in the panel's language: a code the locale words is built from the issue's params, any other
// shows the server's English message.
import { act, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import de from "@/i18n/locales/de/common.json";
import en from "@/i18n/locales/en/common.json";

import type { LayerStyle } from "@/lib/style/generated/types";
import type { StyleIssue } from "@/lib/style/save";

import { DamagedNotice, IssueNotice, IssuesProvider } from "@/components/map/panels/styleEditor/IssueNotice";

import { i18n, renderPanel } from "./renderPanel";

const DOC = {
  version: "1.0.0",
  kind: "vector",
  classify: [{ id: "population", field: "population", method: "quantile", count: 6 }],
} as LayerStyle;

const MERGED: StyleIssue = {
  level: "info",
  code: "classes_merged",
  path: "/classify/population",
  message: "Many values are the same, so some class limits fell on the same value: 5 classes instead of 6.",
  params: { case: "repeated_values", asked: 6, made: 5 },
};

function notes(issues: StyleIssue[]) {
  return renderPanel(
    <IssuesProvider issues={issues}>
      <DamagedNotice />
      {issues.map((issue, i) => (
        <IssueNotice key={i} issue={issue} />
      ))}
    </IssuesProvider>,
    { document: DOC }
  );
}

beforeAll(() => {
  i18n.addResourceBundle("en", "common", en);
  i18n.addResourceBundle("de", "common", de);
});
afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the style panel's notes", () => {
  it("say in German why a quantile made fewer classes, with the numbers", async () => {
    await act(() => i18n.changeLanguage("de"));
    notes([MERGED]);
    expect(
      screen.getByText(
        "Viele Werte sind gleich, daher fallen Klassengrenzen auf denselben Wert: 5 Klassen statt 6. " +
          "Wählen Sie weniger Klassen oder eine andere Methode."
      )
    ).toBeDefined();
  });

  it("say it in English in the English interface", async () => {
    await act(() => i18n.changeLanguage("en"));
    notes([MERGED]);
    expect(
      screen.getByText(
        "Many values are the same, so some class limits fell on the same value: 5 classes instead of 6. " +
          "Choose fewer classes or another method."
      )
    ).toBeDefined();
  });

  it("show the server's message for a code the locale does not word", async () => {
    await act(() => i18n.changeLanguage("de"));
    const message = "An opening brace at position 3 has no matching closing brace.";
    notes([{ level: "error", code: "template_syntax", path: "/classify/population", message }]);
    expect(screen.getByText(message)).toBeDefined();
  });

  it("word a field a data change removed in the damaged notice", async () => {
    await act(() => i18n.changeLanguage("de"));
    notes([
      {
        level: "damaged",
        code: "unknown_field",
        path: "/classify/population/field",
        message: 'The dataset has no field "population".',
        params: { field: "population" },
      },
    ]);
    expect(screen.getByRole("listitem").textContent).toBe("Der Datensatz hat kein Feld „population“.");
  });
});
