/**
 * Numbers in an answer's tables: a column whose body holds numbers only is
 * right-aligned in tabular figures, so its digits line up.
 */

/**
 * A number as an answer writes it, in English or German: an optional sign
 * (a minus may come as a hyphen, a minus sign or an en dash),
 * digits with one kind of thousands separator (comma, dot, apostrophe or a
 * space) in groups of three, a decimal part, and an optional "%".
 */
const NUMBER = /^[+\-−–]?(?:\d{1,3}([.,'   ])\d{3}(?:\1\d{3})*|\d+)(?:[.,]\d+)?[   ]?%?$/;

/** A dash alone stands for a missing value: an empty cell. */
const EMPTY = /^[-–—]?$/;

export const isNumericCell = (text: string): boolean => NUMBER.test(text.trim());

/**
 * Which columns of a table's body rows are numeric: those whose non-empty
 * cells all read as numbers, with one number at least.
 */
export function numericColumns(rows: string[][]): boolean[] {
  const width = rows.reduce((most, row) => Math.max(most, row.length), 0);
  return Array.from({ length: width }, (_, column) => {
    let numbers = 0;
    for (const row of rows) {
      const cell = (row[column] ?? "").trim();
      if (EMPTY.test(cell)) continue;
      if (!isNumericCell(cell)) return false;
      numbers += 1;
    }
    return numbers > 0;
  });
}

/** The class of a numeric column's cells, header included. */
export const NUMERIC_CELL = "numeric";

/** A node of the HTML tree react-markdown renders (hast), as far as a table needs it. */
interface HtmlNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}

const childElements = (node: HtmlNode, tags: string[]): HtmlNode[] =>
  (node.children ?? []).filter((child) => child.type === "element" && tags.includes(child.tagName ?? ""));

const textOf = (node: HtmlNode): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");

function markTable(table: HtmlNode) {
  const sections = childElements(table, ["thead", "tbody"]);
  const rowsOf = (section: HtmlNode) => childElements(section, ["tr"]);
  const cellsOf = (row: HtmlNode) => childElements(row, ["th", "td"]);
  const body = sections.filter((section) => section.tagName === "tbody").flatMap(rowsOf);
  const numeric = numericColumns(body.map((row) => cellsOf(row).map(textOf)));
  for (const row of sections.flatMap(rowsOf)) {
    cellsOf(row).forEach((cell, index) => {
      if (!numeric[index]) return;
      const properties = (cell.properties ??= {});
      const classes = Array.isArray(properties.className) ? properties.className : [];
      properties.className = [...classes, NUMERIC_CELL];
    });
  }
}

/** A rehype plugin: marks the cells of every table's numeric columns with `NUMERIC_CELL`. */
export const rehypeNumericColumns = () => (tree: HtmlNode) => {
  const visit = (node: HtmlNode) => {
    if (node.type === "element" && node.tagName === "table") markTable(node);
    else node.children?.forEach(visit);
  };
  visit(tree);
};
