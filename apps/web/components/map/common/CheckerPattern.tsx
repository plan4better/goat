import { checkerTiles } from "@/lib/style/checker";

/** The swatch checkerboard (lib/style/checker.ts) as an SVG pattern: a color that is not opaque is drawn over it. */
export function CheckerPattern({ id }: { id: string }) {
  const tile = checkerTiles();
  return (
    <pattern id={id} data-checker patternUnits="userSpaceOnUse" width={tile.size} height={tile.size}>
      {tile.rects.map((r, i) => (
        <rect key={i} {...r} />
      ))}
    </pattern>
  );
}
