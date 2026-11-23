// The map's number locale (`project.locale`, spec 10): how labels, legends, popups and print format numbers on public
// maps, dashboards and print. Unset, every viewer gets their own language's format.
import { FormControl, MenuItem, Select, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

const LOCALES = ["en-US", "en-GB", "de-DE", "de-AT", "de-CH", "fr-FR", "it-IT", "es-ES", "nl-NL", "pt-BR"];
const VIEWER = "viewer";

/** A locale in its own language, with a sample number. */
function labelOf(tag: string): string {
  const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  const sample = new Intl.NumberFormat(tag).format(1234.5);
  return `${name} · ${sample}`;
}

export interface NumberLocaleSelectProps {
  value: string | null | undefined;
  onChange: (locale: string | null) => void;
}

export default function NumberLocaleSelect({ value, onChange }: NumberLocaleSelectProps) {
  const { t } = useTranslation("common");
  const options = value && !LOCALES.includes(value) ? [value, ...LOCALES] : LOCALES;
  return (
    <FormControl size="small" fullWidth>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
        {t("number_locale")}
      </Typography>
      <Select
        value={value ?? VIEWER}
        onChange={(event) => onChange(event.target.value === VIEWER ? null : event.target.value)}>
        <MenuItem value={VIEWER}>{t("number_locale_viewer")}</MenuItem>
        {options.map((tag) => (
          <MenuItem key={tag} value={tag}>
            {labelOf(tag)}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
