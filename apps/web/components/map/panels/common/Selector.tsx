import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  Checkbox,
  FormControl,
  InputAdornment,
  ListSubheader,
  MenuItem,
  Select,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { type ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { SelectorItem } from "@/types/map/common";

import FormLabelHelper from "@/components/common/FormLabelHelper";
import NoValuesFound from "@/components/map/common/NoValuesFound";

// Stable empty array reference to prevent re-renders
const EMPTY_ARRAY: never[] = [];

type SelectorProps = {
  selectedItems: SelectorItem[] | SelectorItem | undefined;
  setSelectedItems: (items: SelectorItem[] | SelectorItem | undefined) => void;
  items: SelectorItem[];
  multiple?: boolean;
  tooltip?: string;
  placeholder?: string;
  enableSearch?: boolean;
  label?: string;
  /** Clip the label to one line — for a selector sharing a row. */
  truncateLabel?: boolean;
  /** The field must be filled in: its label carries the required marker. */
  required?: boolean;
  allSelectedLabel?: string;
  errorMessage?: string;
  emptyMessage?: string;
  emptyMessageIcon?: ICON_NAME;
  disabled?: boolean;
};

const containsText = (text: string, searchText: string) =>
  text.toLowerCase().indexOf(searchText.toLowerCase()) > -1;

const Selector = (props: SelectorProps) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const [searchText, setSearchText] = useState("");
  const {
    selectedItems,
    items,
    setSelectedItems,
    enableSearch,
    placeholder,
    label,
    truncateLabel,
    required,
    tooltip,
    multiple,
    allSelectedLabel,
    emptyMessage,
    emptyMessageIcon,
    errorMessage,
    disabled,
  } = props;
  const [focused, setFocused] = useState(false);
  const displayedItems = useMemo(() => {
    if (!enableSearch) return items;
    const filtered = items.filter((item) => {
      return containsText(item.label, searchText);
    });
    return filtered;
  }, [enableSearch, items, searchText]);

  const selectedValue = useMemo(() => {
    if (!multiple && !Array.isArray(selectedItems)) {
      return selectedItems ? selectedItems.value : "";
    } else {
      return selectedItems && Array.isArray(selectedItems) && selectedItems.length > 0
        ? selectedItems.map((item) => item.value)
        : EMPTY_ARRAY;
    }
  }, [multiple, selectedItems]);

  // Return early if no items to prevent MUI empty state loop. The Select is not
  // rendered here, so surface emptyMessage in place of it instead of leaving a
  // bare label behind.
  if (!items || items.length === 0) {
    if (!label && !emptyMessage) return null;
    return (
      <FormControl size="small" fullWidth>
        {label && (
          <FormLabelHelper
            label={label}
            color={theme.palette.text.secondary}
            tooltip={tooltip}
            truncate={truncateLabel}
            required={required}
          />
        )}
        {emptyMessage && <NoValuesFound text={emptyMessage} icon={emptyMessageIcon} />}
      </FormControl>
    );
  }

  return (
    <FormControl size="small" fullWidth>
      {label && (
        <FormLabelHelper
          label={label}
          color={
            disabled
              ? theme.palette.secondary.main
              : focused
                ? theme.palette.primary.main
                : theme.palette.text.secondary
          }
          tooltip={tooltip}
          truncate={truncateLabel}
          required={required}
        />
      )}
      <Select
        fullWidth
        MenuProps={{
          autoFocus: false,
          sx: { width: "120px" },
          slotProps: {
            paper: {
              sx: {
                maxHeight: "350px",
                overflowY: "auto",
              },
            },
          },
        }}
        IconComponent={() => null}
        // The visible label is not a <label> tied to the field, so the
        // combobox carries it as its accessible name.
        SelectDisplayProps={{ "aria-label": label || placeholder }}
        sx={{ pr: 1 }}
        displayEmpty
        disabled={disabled}
        error={!!errorMessage}
        multiple={multiple}
        defaultValue={multiple ? EMPTY_ARRAY : ("" as unknown)} //todo: fix this
        value={selectedValue || (multiple ? EMPTY_ARRAY : "")}
        onChange={(e) => {
          if (multiple) {
            const value = e.target.value as string[] | number[];
            setSelectedItems(items.filter((item) => value.includes(item.value as never)));
          }
          if (!multiple) {
            const value = e.target.value as string | number;
            const selected = items.find((item) => item.value === value);
            setSelectedItems(selected);
          }
        }}
        onClose={() => {
          setFocused(false);
          setSearchText("");
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        renderValue={() => {
          // {PLACEHOLDER RENDER}
          if (!selectedItems || (Array.isArray(selectedItems) && selectedItems?.length === 0))
            return <Typography variant="body2">{placeholder}</Typography>;

          // {SINGLE ITEM RENDER}
          if (!multiple && !Array.isArray(selectedItems) && selectedItems)
            return (
              // `minWidth: 0` so the label may shrink: without it the flex row
              // takes its content's width, and a selector sitting beside
              // another field widens to whatever the chosen option is called —
              // "Distance" against "Time", or "Entfernung" against "Zeit" —
              // pushing its neighbour onto the next line. The multi-item render
              // below already truncates; this is the same rule for one.
              <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                {selectedItems.iconNode ? (
                  <Box component="span" sx={{ mr: 2, display: "inline-flex", flexShrink: 0 }}>
                    {selectedItems.iconNode}
                  </Box>
                ) : (
                  selectedItems.icon && (
                    <Icon
                      iconName={selectedItems.icon}
                      style={{
                        fontSize: "14px",
                        color: theme.palette.text.secondary,
                      }}
                      sx={{ mr: 2, flexShrink: 0 }}
                      color="inherit"
                    />
                  )
                )}
                <Typography variant="body2" fontWeight="bold" noWrap title={selectedItems.label}>
                  {selectedItems.label}
                </Typography>
              </div>
            );
          return (
            <Typography
              variant="body2"
              fontWeight="bold"
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
              {Array.isArray(selectedItems) &&
              selectedItems.length === displayedItems.length &&
              allSelectedLabel
                ? allSelectedLabel
                : Array.isArray(selectedItems)
                  ? selectedItems.map((item) => item.label).join(", ")
                  : selectedItems.label}
            </Typography>
          );
        }}>
        {enableSearch && (
          <ListSubheader sx={{ px: 2, pt: 1 }}>
            <TextField
              size="small"
              autoFocus
              placeholder={t("search_placeholder_short")}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon />
                  </InputAdornment>
                ),
              }}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") {
                  e.stopPropagation();
                }
              }}
            />
          </ListSubheader>
        )}
        {emptyMessage && emptyMessageIcon && displayedItems.length === 0 && (
          <NoValuesFound text={emptyMessage} icon={emptyMessageIcon} />
        )}

        {displayedItems.map((item) => (
          <MenuItem sx={{ px: 2, py: 2 }} key={item.value} value={item.value} disabled={item.disabled}>
            {multiple && Array.isArray(selectedValue) && (
              <Checkbox
                sx={{ mr: 2, p: 0 }}
                size="small"
                checked={selectedValue?.findIndex((selected) => selected === item.value) > -1}
              />
            )}
            {item.iconNode ? (
              <Box component="span" sx={{ mr: 2, display: "inline-flex" }}>
                {item.iconNode}
              </Box>
            ) : (
              item.icon && (
                <Icon
                  iconName={item.icon}
                  style={{
                    fontSize: "14px",
                    color: theme.palette.text.secondary,
                  }}
                  sx={{ mr: 2 }}
                  color="inherit"
                />
              )
            )}
            <Typography
              variant="body2"
              fontWeight="bold"
              title={item.label}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
              {item.label}
            </Typography>
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};

export default Selector;
