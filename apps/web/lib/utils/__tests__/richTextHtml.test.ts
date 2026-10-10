import { describe, expect, it } from "vitest";

import { keepEmptyParagraphs } from "@/lib/utils/richTextHtml";

describe("keepEmptyParagraphs", () => {
  it("gives an empty paragraph a line break so the blank line stays visible", () => {
    expect(keepEmptyParagraphs("<p>Erste Zeile</p><p></p><p>Nach der Leerzeile</p>")).toBe(
      "<p>Erste Zeile</p><p><br></p><p>Nach der Leerzeile</p>"
    );
  });

  it("keeps the attributes of an empty paragraph, such as its alignment", () => {
    expect(keepEmptyParagraphs('<p style="text-align: center"></p>')).toBe(
      '<p style="text-align: center"><br></p>'
    );
  });

  it("leaves paragraphs with content and other tags as they are", () => {
    const html = '<p><span data-variable="x"></span></p><pre></pre><p>Text</p>';
    expect(keepEmptyParagraphs(html)).toBe(html);
  });
});
