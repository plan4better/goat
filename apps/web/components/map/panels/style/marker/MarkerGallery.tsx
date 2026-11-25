import ClearIcon from "@mui/icons-material/Clear";
import {
  Box,
  Button,
  Divider,
  IconButton,
  InputAdornment,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { useAssets } from "@/lib/api/assets";
import { MAKI_ICONS_BASE_URL, MAKI_ICON_SIZE, MAKI_ICON_TYPES } from "@/lib/constants/icons";
import { assetTypeEnum } from "@/lib/validations/assets";
import type { Marker } from "@/lib/validations/layer";

import NoValuesFound from "@/components/map/common/NoValuesFound";
import { ManageIconsDialog } from "@/components/map/panels/style/marker/ManageIconDialog";
import { UploadIconDialog } from "@/components/map/panels/style/marker/UploadIconDialog";
import { MaskedImageIcon } from "@/components/map/panels/style/other/MaskedImageIcon";

type MarkerGalleryProps = {
  selectedMarker?: Marker | undefined;
  onSelectMarker?: (marker: Marker) => void;
  /** The library groups to show (GOAT Style's catalogue); today's Maki groups when absent. */
  groups?: readonly { name: string; labelKey: string; icons: readonly string[] }[];
};

const MarkerGallery = (props: MarkerGalleryProps) => {
  const theme = useTheme();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"library" | "custom">("library");
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [manageDialogOpen, setManageDialogOpen] = useState(false);
  const { t } = useTranslation("common");

  // Fetch custom assets
  const { assets: rawAssets = [], mutate: mutateAssets } = useAssets({
    asset_type: assetTypeEnum.Enum.icon,
  });

  // Map assets into our Marker type
  const customMarkers: Marker[] = useMemo(
    () =>
      rawAssets.map((asset) => ({
        id: asset.id,
        name: asset.display_name || asset.file_name,
        url: asset.url,
        category: asset.category || undefined,
        source: "custom",
      })),
    [rawAssets]
  );

  // Filter library icons
  const libraryGroups = props.groups ?? MAKI_ICON_TYPES;
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return libraryGroups;
    const lower = search.toLowerCase();
    return libraryGroups
      .map((group) => ({
        ...group,
        icons: group.icons.filter((icon) => icon.toLowerCase().includes(lower)),
      }))
      .filter((group) => group.icons.length > 0);
  }, [search, libraryGroups]);

  // Filter custom markers
  const filteredCustomMarkers = useMemo(() => {
    if (!search.trim()) return customMarkers;
    const lower = search.toLowerCase();
    return customMarkers.filter(
      (marker) =>
        marker.name.toLowerCase().includes(lower) ||
        marker.url.toLowerCase().includes(lower) ||
        marker.category?.toLowerCase().includes(lower)
    );
  }, [search, customMarkers]);

  // Group custom markers by category
  const groupedCustomMarkers = useMemo(() => {
    if (filteredCustomMarkers.length === 0) return [];

    const groups: Record<string, Marker[]> = {};

    filteredCustomMarkers.forEach((marker) => {
      const category = marker.category?.trim() || ""; // keep empty string for no category
      if (!groups[category]) groups[category] = [];
      groups[category].push(marker);
    });

    // If the **only group is "" (no category)**, return markers directly (no group UI)
    const categories = Object.keys(groups);
    if (categories.length === 1 && categories[0] === "") {
      return [
        {
          name: null, // mark it as ungrouped
          icons: groups[""],
        },
      ];
    }

    // Otherwise, show groups normally — but hide empty-label group
    const sortedGroups = Object.entries(groups).sort(([a], [b]) => {
      if (a === "") return 1; // push uncategorized last
      if (b === "") return -1;
      return a.localeCompare(b);
    });

    return sortedGroups.map(([category, markers]) => ({
      name: category || t("uncategorized"),
      icons: markers,
    }));
  }, [filteredCustomMarkers, t]);
  // Render icons
  const renderIconGrid = (icons: Marker[]) => (
    <Box sx={{ display: "flex", flexWrap: "wrap" }}>
      {icons.map((marker, idx) => {
        const isSelected = props.selectedMarker?.url === marker.url;
        return (
          <Box
            key={`${marker.name}-${idx}`}
            title={marker.name}
            role="button"
            aria-label={marker.name}
            onClick={() => props.onSelectMarker?.(marker)}
            sx={{
              cursor: "pointer",
              m: 0.5,
              p: 0.8,
              borderRadius: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid",
              borderColor: isSelected ? "primary.main" : "transparent",
              bgcolor: isSelected ? "action.selected" : "transparent",
              "&:hover": {
                bgcolor: "action.hover",
              },
            }}>
            <MaskedImageIcon
              imageUrl={marker.url}
              dimension={`${MAKI_ICON_SIZE}px`}
              applyMask={marker?.source === "custom" ? false : true}
            />
          </Box>
        );
      })}
    </Box>
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      {/* Tabs */}
      <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="fullWidth">
        <Tab value="library" label={t("library")} />
        <Tab value="custom" label={t("custom")} />
      </Tabs>

      {/* Search bar */}
      {(tab === "library" || (tab === "custom" && customMarkers.length > 0)) && (
        <>
          <Box sx={{ px: 2, pt: 4 }}>
            <TextField
              size="small"
              placeholder={t("search_icons")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              fullWidth
              InputProps={{
                endAdornment: search && (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setSearch("")}>
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </Box>
          <Divider sx={{ py: 1 }} />
        </>
      )}

      {/* Scrollable content */}
      <Box sx={{ maxHeight: 280, overflowY: "auto", px: 2, py: 2 }}>
        {/* Library Icons */}
        {tab === "library" && (
          <>
            {filteredGroups.map((group, groupIndex) => (
              <Stack key={`${group.name}-${groupIndex}`} direction="column" sx={{ mb: 2 }} spacing={2}>
                <Stack>
                  <Typography variant="body2" fontWeight="bold">
                    {t(group.labelKey, { defaultValue: group.name })}
                  </Typography>
                  <Divider sx={{ mb: 1 }} />
                </Stack>
                {renderIconGrid(
                  group.icons.map((icon) => ({
                    name: icon,
                    url: `${MAKI_ICONS_BASE_URL}/${icon}.svg`,
                    category: group.name,
                    source: "library",
                  }))
                )}
              </Stack>
            ))}
            {filteredGroups.length === 0 && (
              <NoValuesFound text={t("no_icons_found")} icon={ICON_NAME.IMAGE} />
            )}
          </>
        )}

        {/* Custom Icons */}
        {tab === "custom" && (
          <>
            {filteredCustomMarkers.length ? (
              <>
                {groupedCustomMarkers.map((group, idx) => (
                  <Stack key={idx} direction="column" sx={{ mb: 2 }} spacing={2}>
                    {group.name && (
                      <>
                        <Typography variant="body2" fontWeight="bold">
                          {group.name}
                        </Typography>
                        <Divider sx={{ mb: 1 }} />
                      </>
                    )}
                    {renderIconGrid(group.icons)}
                  </Stack>
                ))}
              </>
            ) : (
              <Box
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  height: "100%",
                  m: 10,
                }}>
                <Typography
                  variant="body2"
                  fontWeight="bold"
                  color={theme.palette.text.secondary}
                  sx={{ my: 2 }}>
                  {t("no_custom_icons_yet")}
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<Icon iconName={ICON_NAME.IMAGE} />}
                  onClick={() => setUploadDialogOpen(true)}
                  sx={{ my: 2 }}>
                  {t("upload_icon")}
                </Button>
              </Box>
            )}

            {/* Buttons for managing custom icons */}
            {filteredCustomMarkers.length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Stack direction="row" justifyContent="space-between" sx={{ mb: 2, mt: 4 }}>
                  <Button size="small" variant="text" onClick={() => setUploadDialogOpen(true)}>
                    {t("upload_icon")}
                  </Button>
                  <Button size="small" variant="text" onClick={() => setManageDialogOpen(true)}>
                    {t("manage_icons")}
                  </Button>
                </Stack>
              </>
            )}
          </>
        )}
      </Box>

      {/* Dialogs */}
      <UploadIconDialog
        open={uploadDialogOpen}
        onClose={() => setUploadDialogOpen(false)}
        onUploaded={() => {
          mutateAssets();
          setTab("custom");
        }}
      />
      <ManageIconsDialog
        open={manageDialogOpen}
        onClose={() => setManageDialogOpen(false)}
        markers={customMarkers}
        onDelete={() => mutateAssets()}
        onUpdate={() => mutateAssets()}
      />
    </Box>
  );
};

export default MarkerGallery;
