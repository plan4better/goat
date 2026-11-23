"use client";

import { Box, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography, useTheme } from "@mui/material";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { CreateFlow, GeometryChoice } from "@/hooks/addLayer/useCreateFlow";

import FieldEditor from "@/components/common/FieldEditor";

const GEOMETRY_OPTIONS: { value: GeometryChoice; icon: ICON_NAME; labelKey: string }[] = [
  { value: "point", icon: ICON_NAME.POINT_FEATURE, labelKey: "point" },
  { value: "line", icon: ICON_NAME.LINE_FEATURE, labelKey: "line" },
  { value: "polygon", icon: ICON_NAME.POLYGON_FEATURE, labelKey: "polygon" },
  { value: "table", icon: ICON_NAME.TABLE, labelKey: "table" },
];

/**
 * The Create flow's content: what the layer is called, what shape its features
 * have, and what it records about them.
 *
 * The field editor is the app's own, so a field means the same thing here as in a
 * layer's own Edit fields — including which kinds are on offer, which it decides
 * from the geometry and from whether a layer exists yet.
 */
const CreateBody = ({ controller }: { controller: CreateFlow }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { create } = controller;

  return (
    <Stack spacing={6}>
      <Box>
        <Typography variant="body2" fontWeight="bold" sx={{ mb: 1.5 }}>
          {t("layer_name")}
        </Typography>
        <TextField
          fullWidth
          required
          size="small"
          autoFocus
          {...create.register("name")}
          error={!!create.errors.name}
          helperText={create.errors.name?.message}
        />
      </Box>

      <Box>
        <Typography variant="body2" fontWeight="bold" sx={{ mb: 1.5 }}>
          {t("geometry_type")}
        </Typography>
        <ToggleButtonGroup
          value={create.geometry}
          exclusive
          fullWidth
          size="small"
          // Clicking the active button sends null; the choice is not clearable.
          onChange={(_, value) => value && create.setGeometry(value as GeometryChoice)}>
          {GEOMETRY_OPTIONS.map((option) => (
            <ToggleButton key={option.value} value={option.value} sx={{ gap: 1.5 }}>
              <Icon iconName={option.icon} style={{ fontSize: 14 }} htmlColor="inherit" />
              {t(option.labelKey)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      <Box>
        <Typography variant="body2" fontWeight="bold" sx={{ mb: 1.5 }}>
          {t("fields")}
        </Typography>
        <Box sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: 2, overflow: "hidden" }}>
          <FieldEditor
            fields={create.fields}
            onChange={create.setFields}
            selectedFieldId={create.selectedFieldId}
            onSelectField={create.setSelectedFieldId}
            geometryType={create.geometry === "table" ? null : create.geometry}
          />
        </Box>
      </Box>
    </Stack>
  );
};

export default CreateBody;
