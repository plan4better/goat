// A one-line (or multiline) text: the tool forms' TextFieldInput.
import { type ReactNode, memo } from "react";

import TextFieldInput from "@/components/map/panels/common/TextFieldInput";
import { Row } from "@/components/map/panels/styleEditor/rows/Row";

export interface TextRowProps {
  label: ReactNode;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  note?: ReactNode;
  multiline?: boolean;
}

export const TextRow = memo(function TextRow({
  label,
  value,
  placeholder,
  onChange,
  note,
  multiline,
}: TextRowProps) {
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
});
