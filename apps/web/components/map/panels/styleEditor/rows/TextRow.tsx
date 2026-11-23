// A one-line (or multiline) text: the tool forms' TextFieldInput. A text that takes effect only as a whole
// (`commitOnLeave`) is kept in the box while it has the focus and reported when the box is left, on Enter (Ctrl or Cmd
// with Enter in a multiline box, where Enter starts a new line) or when the box closes with the focus in it.
import { type KeyboardEvent, type ReactNode, memo, useEffect, useRef, useState } from "react";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import { Row } from "@/components/map/panels/styleEditor/rows/Row";

export interface TextRowProps {
  label: ReactNode;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  note?: ReactNode;
  multiline?: boolean;
  /** Report the text only when the box is left: a text typed on the way is never sent. */
  commitOnLeave?: boolean;
  /** The text as it is typed while `commitOnLeave` holds it back (for a preview); null once the box is left. */
  onDraft?: (value: string | null) => void;
}

export const TextRow = memo(function TextRow({
  label,
  value,
  placeholder,
  onChange,
  note,
  multiline,
  commitOnLeave,
  onDraft,
}: TextRowProps) {
  // What is typed while the box has the focus (commitOnLeave); null shows the value.
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useRef({ draft, value, onChange });
  latest.current = { draft, value, onChange };
  // A box that closes with the focus in it (its popover closed) reports what was typed.
  useEffect(
    () => () => {
      const { draft: typed, value: current, onChange: report } = latest.current;
      if (typed !== null && typed !== current) report(typed);
    },
    []
  );

  if (!commitOnLeave)
    return (
      <Row label={label} note={note}>
        <TextFieldInput
          value={value}
          placeholder={placeholder}
          multiline={multiline}
          clearable={false}
          inputProps={{ "aria-label": typeof label === "string" ? label : undefined }}
          onChange={onChange}
        />
      </Row>
    );

  const leave = () => {
    if (draft !== null && draft !== value) onChange(draft);
    setDraft(null);
    onDraft?.(null);
  };
  const enter = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      (event.currentTarget as HTMLElement).blur();
    }
  };
  return (
    <Row label={label} note={note}>
      <TextFieldInput
        value={draft ?? value}
        placeholder={placeholder}
        multiline={multiline}
        clearable={false}
        inputProps={{ "aria-label": typeof label === "string" ? label : undefined, onKeyDown: enter }}
        onFocus={() => setDraft(value)}
        onChange={(text) => {
          setDraft(text);
          onDraft?.(text);
        }}
        onBlur={leave}
      />
    </Row>
  );
});
