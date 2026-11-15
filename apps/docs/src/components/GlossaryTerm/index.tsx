import React, { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, MouseEvent, ReactNode } from "react";
import Translate from "@docusaurus/Translate";
import styles from "./styles.module.css";

export type GlossaryEntry = {
  name: string;
  description: string;
  url: string;
};

type GlossaryTermProps = {
  term: GlossaryEntry;
  href: string;
  children: ReactNode;
};

/** Where the box opens: which line of the link, and how far along it. */
type Anchor = { line: number; along: number };

/** Half the box width plus the gap kept to the window edge. */
const HALF_WIDTH = 170;
const EDGE_GAP = 16;

// A docs link to a term on the Plan4Better website glossary. Hovering or
// focusing it shows the term's short description, with a button to the full
// entry; clicking the link opens the entry as before. Only inline elements,
// because the link sits inside running text.
//
// The box opens above the line the pointer is on, centred on the pointer, so a
// term that wraps onto two lines does not get a box floating between them.
export default function GlossaryTerm({ term, href, children }: GlossaryTermProps) {
  const descriptionId = useId();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const anchor = useRef<Anchor>({ line: 0, along: 0.5 });
  const [position, setPosition] = useState<{ left: number; top: number; arrow: number } | null>(null);
  const [active, setActive] = useState(false);

  const place = () => {
    const lines = linkRef.current?.getClientRects();
    if (!lines || lines.length === 0) {
      return;
    }
    const line = lines[Math.min(anchor.current.line, lines.length - 1)];
    const x = line.left + anchor.current.along * line.width;
    const half = Math.min(HALF_WIDTH, window.innerWidth / 2 - EDGE_GAP);
    const left = Math.min(Math.max(x, half + EDGE_GAP), window.innerWidth - half - EDGE_GAP);
    setPosition({ left, top: line.top, arrow: x - left });
  };

  const openAtPointer = (event: MouseEvent<HTMLAnchorElement>) => {
    const lines = Array.from(event.currentTarget.getClientRects());
    const index = lines.findIndex((line) => event.clientY >= line.top && event.clientY <= line.bottom);
    const line = lines[Math.max(index, 0)];
    anchor.current = {
      line: Math.max(index, 0),
      along: line && line.width > 0 ? (event.clientX - line.left) / line.width : 0.5,
    };
    place();
  };

  const openAtStart = (_event: FocusEvent<HTMLAnchorElement>) => {
    anchor.current = { line: 0, along: 0.5 };
    place();
  };

  // The box is fixed to the window, so it follows its line while the page
  // scrolls underneath an open box.
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [active]);

  const previewStyle = position
    ? ({ left: position.left, top: position.top, "--glossary-arrow-x": `${position.arrow}px` } as CSSProperties)
    : undefined;

  return (
    <span className={styles.term} onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}>
      <a
        ref={linkRef}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={descriptionId}
        className={styles.link}
        onMouseEnter={openAtPointer}
        onFocus={openAtStart}
      >
        {children}
      </a>
      {/* glossary-preview: left out of the search index (docusaurus.config.js). */}
      <span className={`${styles.preview} glossary-preview`} style={previewStyle}>
        <span className={styles.label}>
          <Translate id="glossary.preview.label" description="Small label above a glossary term preview">
            Glossary
          </Translate>
        </span>
        <span className={styles.name}>{term.name}</span>
        <span id={descriptionId} className={styles.description}>{term.description}</span>
        <a href={term.url} target="_blank" rel="noopener noreferrer" className={styles.more} tabIndex={-1}>
          <Translate id="glossary.preview.readMore" description="Button in a glossary term preview that opens the full entry">
            Read more
          </Translate>{" "}
          ↗
        </a>
      </span>
    </span>
  );
}
