/**
 * An empty paragraph from the rich-text editor (`<p></p>`) has no line box,
 * so outside the editor it collapses to zero height and the blank line the
 * author typed disappears. The editor itself shows it because ProseMirror puts
 * a trailing `<br>` in every empty paragraph; this does the same for display.
 */
export function keepEmptyParagraphs(html: string): string {
  return html.replace(
    /<p(\s[^>]*)?>\s*<\/p>/g,
    (_match, attrs: string | undefined) => `<p${attrs ?? ""}><br></p>`
  );
}
