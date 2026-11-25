// What the popup's block editors share: a block's color as the style editor's color row, opening the editor's color
// picker beside the block's popover (the picker reads the block where it is stored, so it follows every pick).
import type { PopupBlock } from "@/lib/validations/layer";

import { ColorField, Row } from "@/components/map/panels/styleEditor/rows";

/** Opens the color picker for one color of a block: `read` takes it from the block as stored now, `write` returns the
 * block with the picked color. */
export type OpenBlockColor = <B extends PopupBlock>(
  anchor: HTMLElement,
  title: string,
  read: (block: B) => string | undefined,
  write: (block: B, hex: string) => B
) => void;

export function BlockColorRow<B extends PopupBlock>({
  label,
  value,
  openColor,
  read,
  write,
}: {
  label: string;
  /** The color shown (the block's, or the color drawn while it has none). */
  value: string;
  openColor: OpenBlockColor;
  read: (block: B) => string | undefined;
  write: (block: B, hex: string) => B;
}) {
  return (
    <Row label={label}>
      <ColorField value={value} onOpenPicker={(anchor) => openColor<B>(anchor, label, read, write)} />
    </Row>
  );
}
