// The foot of a filter tab (a layer's, a bundle's): "Clear filter" as a text button and the tab's one primary action
// at the end, as the style editor's popovers end on theirs (a new rule's Cancel and "Add rule"). It sits under the
// tab's scrolling body, so it stays in view however many expressions there are.
import { LoadingButton } from "@mui/lab";
import { Box, Button } from "@mui/material";
import { useTranslation } from "react-i18next";

export interface FilterFootProps {
  onClear: () => void;
  clearDisabled?: boolean;
  /** The tab's primary action (save the filtered data as a new layer or bundle). */
  action?: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean };
}

export function FilterFoot({ onClear, clearDisabled, action }: FilterFootProps) {
  const { t } = useTranslation("common");
  return (
    <Box
      sx={{
        flex: "none",
        display: "flex",
        justifyContent: "flex-end",
        gap: 2,
        px: 3,
        py: 3,
        borderTop: 1,
        borderColor: "divider",
      }}>
      <Button variant="text" size="small" disabled={clearDisabled} onClick={onClear}>
        {t("clear_filter")}
      </Button>
      {action && (
        <LoadingButton
          variant="contained"
          size="small"
          disableElevation
          loading={action.loading}
          disabled={action.disabled}
          onClick={action.onClick}>
          {action.label}
        </LoadingButton>
      )}
    </Box>
  );
}
