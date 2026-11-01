"use client";

import { Box, Link } from "@mui/material";
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { NUMERIC_CELL, rehypeNumericColumns } from "@/lib/assistant/tables";

const SAFE_PROTOCOLS = /^(https?:|mailto:)/i;

/** A link target the dock may render: http(s), mailto, or a path inside GOAT. */
export function safeHref(href: string | undefined): string | undefined {
  const value = href?.trim();
  if (!value) return undefined;
  // "//host" and "/\host" leave GOAT (browsers read a backslash as a slash).
  if (value.startsWith("/")) return /^\/[\\/]/.test(value) ? undefined : value;
  return SAFE_PROTOCOLS.test(value) ? value : undefined;
}

/** How far a table fades out at a side it can still be scrolled to. */
const FADE = "24px";

/**
 * A table wider than the dock scrolls on its own instead of widening the
 * answer. Overlay scrollbars give no cue that there is more, so a side that
 * can still be scrolled to fades out, only while it can. The fade is a mask:
 * it works on any background, light or dark.
 */
function ScrollingTable({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const start = element.scrollLeft > 1;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, []);
  useLayoutEffect(() => {
    measure();
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // The dock changes width, and a streamed table grows as its rows come in.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);
  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? "transparent" : "#000"} 0, #000 ${edges.start ? FADE : "0px"}, #000 calc(100% - ${edges.end ? FADE : "0px"}), ${edges.end ? "transparent" : "#000"} 100%)`
      : undefined;
  return (
    <Box
      ref={ref}
      onScroll={measure}
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      sx={{ overflowX: "auto", my: "8px", maskImage: mask, WebkitMaskImage: mask }}>
      <table>{children}</table>
    </Box>
  );
}

const COMPONENTS: Components = {
  a: ({ node: _, href, children }) => {
    const safe = safeHref(href);
    if (!safe) return <>{children}</>;
    return (
      <Link href={safe} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </Link>
    );
  },
  table: ({ node: _, children }) => <ScrollingTable>{children}</ScrollingTable>,
};

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeNumericColumns];

const PROSE_SX = {
  fontSize: 13.5,
  lineHeight: 1.6,
  letterSpacing: "0.1px",
  color: "text.primary",
  overflowWrap: "anywhere",
  "& p": { my: "8px" },
  "& :first-of-type": { mt: 0 },
  "& :last-child": { mb: 0 },
  "& strong": { fontWeight: 700 },
  "& code": { fontFamily: "monospace", fontSize: 12.5 },
  "& pre": { whiteSpace: "pre-wrap", fontSize: 12 },
  "& ul, & ol": { pl: "20px", my: "8px" },
  "& li + li": { mt: "4px" },
  "& table": { borderCollapse: "collapse", fontSize: 12.5, lineHeight: 1.45 },
  "& th, & td": {
    px: "8px",
    py: "4px",
    borderBottom: 1,
    borderColor: "divider",
    textAlign: "left",
    verticalAlign: "top",
    overflowWrap: "normal",
  },
  // Headers wrap between their words like any cell: a long one does not widen its column.
  "& th": { fontWeight: 700 },
  "& th:first-of-type, & td:first-of-type": { pl: 0 },
  // The class outranks the cells' element selectors, so it overrides their left alignment; an
  // alignment the answer set itself comes as an inline style and still wins.
  [`& .${NUMERIC_CELL}`]: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
} as const;

/**
 * An answer as safe Markdown (spec §10) with GitHub's extensions (tables,
 * strikethrough, bare links): no images (nothing loads by itself), no raw
 * HTML, and links only to safe targets, opened in a new tab. A table's numeric
 * columns are right-aligned (`rehypeNumericColumns`). The URL transform
 * and the link component both apply `safeHref`, so a link that fails it
 * renders as its plain text.
 */
export default function SafeMarkdown({ children }: { children: string }) {
  return (
    <Box sx={PROSE_SX}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={(url) => safeHref(url) ?? ""}
        components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </Box>
  );
}
