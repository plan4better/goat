import SearchIcon from "@mui/icons-material/Search";
import { InputAdornment, ListSubheader, TextField } from "@mui/material";
import { useTranslation } from "react-i18next";

/** The search box at the top of a long menu. Keys other than Escape stay in the box, so typing does not jump
 * between menu items. */
export default function MenuSearchField({ onChange }: { onChange: (text: string) => void }) {
  const { t } = useTranslation("common");
  return (
    <ListSubheader sx={{ px: 2, pt: 1 }}>
      <TextField
        size="small"
        autoFocus
        placeholder={t("search_placeholder_short")}
        inputProps={{ "aria-label": t("search_placeholder_short") }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon />
            </InputAdornment>
          ),
        }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") {
            e.stopPropagation();
          }
        }}
      />
    </ListSubheader>
  );
}
