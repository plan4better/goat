/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Autocomplete,
  Checkbox,
  CircularProgress,
  FormControl,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDatasetValueSelectorMethods } from "@/hooks/map/DatasetHooks";

import FormLabelHelper from "@/components/common/FormLabelHelper";

export type AutocompleteLayerValueProps = {
  selectedValues: string[] | string | null;
  onSelectedValuesChange: (values: string[] | string | null) => void;
  layerId: string;
  fieldName: string;
  label?: string;
  tooltip?: string;
  disabled?: boolean;
  multiple?: boolean;
  placeholder?: string;
  onFocus?: () => void;
  onClose?: () => void;
  cqlFilter?: object | undefined;
  labelMap?: [string, string][];
};

type OptionItem = {
  value: string;
  count?: number;
};

const AutocompleteLayerValue = (props: AutocompleteLayerValueProps) => {
  const theme = useTheme();
  const { t } = useTranslation("common");

  const labelMapLookup = useMemo(() => new Map(props.labelMap || []), [props.labelMap]);

  const getLabel = (value: string) => labelMapLookup.get(value) || value;

  const [open, setOpen] = useState(false);
  // Enter pressed in single mode before the matching values had arrived from the server
  const [pendingEnter, setPendingEnter] = useState(false);

  const { data, isLoading, searchText, setSearchText, debouncedSetSearchText } =
    useDatasetValueSelectorMethods({
      selectedValues: props.multiple
        ? (Array.isArray(props.selectedValues) ? props.selectedValues : props.selectedValues ? [props.selectedValues as string] : [])
        : [props.selectedValues as string],
      onSelectedValuesChange: props.onSelectedValuesChange,
      fieldName: props.fieldName,
      datasetId: props.layerId,
      cqlFilter: props.cqlFilter,
    });

  // Build the options list: selected values first, then the rest
  const selectedValuesArray: string[] = props.multiple
    ? (Array.isArray(props.selectedValues) ? props.selectedValues : props.selectedValues ? [props.selectedValues as string] : []).filter((v) => v != null)
    : props.selectedValues
      ? [props.selectedValues as string]
      : [];

  const selectedValuesSet = new Set(selectedValuesArray);

  const search = searchText.trim().toLowerCase();
  const isSearching = !props.multiple && search !== "";

  const options: OptionItem[] = useMemo(() => {
    // While typing a new value in single mode, the current value only shows up if it matches,
    // otherwise it would stay on top of the list and Enter would pick it again
    if (isSearching) {
      const matches = (data?.items || []).filter(
        (item) =>
          item.value.toLowerCase().includes(search) ||
          getLabel(item.value).toLowerCase().includes(search)
      );
      // Exact match first, then values starting with the text, then the rest in server order
      const rank = (item: OptionItem) => {
        const label = getLabel(item.value).toLowerCase();
        if (label === search || item.value.toLowerCase() === search) return 0;
        if (label.startsWith(search) || item.value.toLowerCase().startsWith(search)) return 1;
        return 2;
      };
      return matches
        .map((item, index) => ({ item, index }))
        .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
        .map(({ item }) => item);
    }
    const selectedItems = selectedValuesArray.map((val) => {
      const existing = data?.items?.find((item) => item.value === val);
      return existing || { value: val };
    });
    const otherItems = data?.items?.filter((item) => !selectedValuesSet.has(item.value)) || [];
    return [...selectedItems, ...otherItems];
    // selectedValuesArray is re-derived each render; join produces a stable string dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.items, selectedValuesArray.join(","), isSearching, search, labelMapLookup]);

  const selectValue = (value: string | null) => {
    setOpen(false);
    setSearchText("");
    debouncedSetSearchText("");
    props.onSelectedValuesChange(value);
  };

  // Enter came before the results: take the best match as soon as it arrives
  useEffect(() => {
    if (!pendingEnter || isLoading) return;
    if (options.length > 0) {
      setPendingEnter(false);
      selectValue(options[0].value);
    }
    // selectValue is recreated each render and only closes over stable setters and props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEnter, isLoading, options]);

  // Compute the Autocomplete value from props
  const autocompleteValue = props.multiple
    ? options.filter((opt) => selectedValuesSet.has(opt.value))
    : options.find((opt) => opt.value === props.selectedValues) || null;

  return (
    <FormControl size="small" fullWidth>
      {props.label && (
        <FormLabelHelper
          label={props.label}
          color={props.disabled ? theme.palette.secondary.main : "inherit"}
          tooltip={props.tooltip}
        />
      )}
      <Autocomplete
        size="small"
        fullWidth
        multiple={props.multiple as any}
        disabled={props.disabled}
        options={options}
        value={autocompleteValue as any}
        loading={isLoading}
        disableCloseOnSelect={props.multiple}
        getOptionLabel={(option: OptionItem) => getLabel(option.value)}
        isOptionEqualToValue={(option: OptionItem, value: OptionItem) =>
          option.value === value.value
        }
        open={open}
        autoHighlight={isSearching}
        onOpen={() => setOpen(true)}
        onClose={() => {
          setOpen(false);
          setSearchText("");
          debouncedSetSearchText("");
          props.onClose?.();
        }}
        filterOptions={(x) => x}
        inputValue={open ? searchText : (autocompleteValue && !props.multiple ? getLabel((autocompleteValue as OptionItem).value) : searchText)}
        onInputChange={(_event, newInputValue, reason) => {
          if (reason === "input") {
            setPendingEnter(false);
            setSearchText(newInputValue);
            debouncedSetSearchText(newInputValue);
          } else if (reason === "clear") {
            setSearchText("");
            debouncedSetSearchText("");
          }
        }}
        onChange={(_event, newValue) => {
          if (props.multiple) {
            const values = (newValue as OptionItem[] | null)?.map((v) => v.value) || [];
            props.onSelectedValuesChange(values.length > 0 ? values : []);
          } else {
            const value = newValue as OptionItem | null;
            props.onSelectedValuesChange(value ? value.value : null);
          }
        }}
        onKeyDown={(event) => {
          // Single mode: Enter takes the best match. If the matches for the typed text are not
          // there yet, wait for them instead of picking a stale entry.
          if (event.key !== "Enter" || !isSearching) return;
          if (isLoading || options.length === 0) {
            event.preventDefault();
            (event as any).defaultMuiPrevented = true;
            setPendingEnter(true);
          }
        }}
        onFocus={props.onFocus}
        noOptionsText={t("no_values_found")}
        loadingText={t("loading")}
        ListboxProps={{
          sx: {
            maxHeight: "350px",
          },
        }}
        renderOption={(renderProps, option: OptionItem, { selected }) => (
          <li {...renderProps} key={option.value}>
            {props.multiple && <Checkbox sx={{ mr: 1, p: 0 }} size="small" checked={selected} />}
            <Typography variant="body2" fontWeight="bold">
              {getLabel(option.value)}
            </Typography>
          </li>
        )}
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder={
              props.multiple && selectedValuesArray.length > 0
                ? undefined
                : (props.placeholder ?? t(props.multiple ? "select_values" : "select_value"))
            }
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {isLoading ? <CircularProgress color="inherit" size={18} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
      />
    </FormControl>
  );
};

export default AutocompleteLayerValue;
