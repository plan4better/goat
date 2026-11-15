/** jsdom drops a selector it cannot parse (MUI's `::-moz-focus-inner`) by throwing. */
const matches = (element: Element, selector: string): boolean => {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
};

/** The style rules of the page: the plain ones, or with `media` those inside
 * that media query (`(min-width:0px)` holds a responsive value's phone part). */
const rulesOf = (media?: string): CSSStyleRule[] =>
  [...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules])
    .flatMap((rule) =>
      media === undefined
        ? [rule]
        : rule instanceof CSSMediaRule && rule.media.mediaText.replace(/\s/g, "") === media.replace(/\s/g, "")
          ? [...rule.cssRules]
          : []
    )
    .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);

/**
 * The value an element's own CSS rules declare for a property, the last one
 * winning. jsdom has no browser stylesheet, so a `<button>`'s computed font
 * always looks inherited there: what the component declares is what tells
 * the app's font from the browser's button font. jsdom applies no media
 * query either: `media` reads a responsive value's part for one breakpoint.
 */
export const declaredStyle = (element: Element, property: string, media?: string): string | undefined =>
  rulesOf(media)
    .filter((rule) => matches(element, rule.selectorText))
    .map((rule) => rule.style.getPropertyValue(property))
    .filter(Boolean)
    .pop();
