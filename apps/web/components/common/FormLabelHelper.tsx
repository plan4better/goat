import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { FormHelperText, Stack, Tooltip } from "@mui/material";

import RequiredMark from "@/components/common/RequiredMark";

interface FormLabelHelperProps {
  label: string;
  color: string;
  tooltip?: string;
  /** Clip the label to one line instead of wrapping. For a field sharing a row
   * with another, where a wrapped label pushes its neighbour out of shape. */
  truncate?: boolean;
  /** The field must be filled in: the label is followed by `RequiredMark`. */
  required?: boolean;
}

/**
 * A field's label.
 *
 * Wraps by default, which is what a label owning its own row should do. Opt in
 * to `truncate` where the field shares a row: there a wrapped label pushes its
 * neighbour out of shape, so it is clipped to one line instead and the full
 * text stays available on hover.
 */
const FormLabelHelper: React.FC<FormLabelHelperProps> = ({ label, color, tooltip, truncate, required }) => (
  <Stack
    direction="row"
    alignItems="center"
    sx={{
      color: color,
      mb: 1,
      ...(truncate && { minWidth: 0 }),
    }}>
    <FormHelperText
      title={truncate ? label : undefined}
      sx={{
        color: "inherit",
        ml: 0,
        mt: 0,
        mr: required ? 0 : 1,
        ...(truncate && {
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }),
      }}>
      {label}
    </FormHelperText>
    {required && <RequiredMark />}
    {tooltip && (
      <Tooltip title={tooltip} placement="top" arrow>
        <HelpOutlineIcon
          style={{
            fontSize: "12px",
          }}
          // The question mark keeps its size; the text gives way first.
          sx={{ flexShrink: 0 }}
        />
      </Tooltip>
    )}
  </Stack>
);

export default FormLabelHelper;
