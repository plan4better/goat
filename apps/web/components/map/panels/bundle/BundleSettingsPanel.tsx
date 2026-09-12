/**
 * Right-hand panel for a bundle selected in the layer tree.
 *
 * Mirrors `LayerSettingsPanel` — same container, same tabbed shell, the same
 * `useLazyTabs` bookkeeping — and is separate only because a bundle is a layer
 * *group* in the tree and so cannot be addressed by `selectedLayerIds`.
 *
 * Two tabs, not three: a bundle has no style of its own, since its member
 * layers are styled individually.
 */
import { Box, Stack, Tab, Tabs, Typography } from "@mui/material";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useBundle, useBundleLayers } from "@/lib/api/bundles";
import { setSelectedBundle } from "@/lib/store/layer/slice";
import { setActiveRightPanel } from "@/lib/store/map/slice";

import { MapSidebarItemID } from "@/types/map/common";

import { useLazyTabs } from "@/hooks/map/useLazyTabs";
import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

import BundleSummaryImpl from "@/components/dashboard/bundle/BundleSummary";
import Container from "@/components/map/panels/Container";
import BundleFilterImpl from "@/components/map/panels/bundle/BundleFilter";

// Same reason as the layer panel: a tab switch re-renders this panel, and
// without memo it re-renders the whole tab tree with it.
const BundleFilter = React.memo(BundleFilterImpl);
const BundleSummary = React.memo(BundleSummaryImpl);

const FILTER_TAB = 0;
const METADATA_TAB = 1;

const BundleSettingsPanel = ({ projectId }: { projectId: string }) => {
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const activeRightPanel = useAppSelector((state) => state.map.activeRightPanel);
  const selectedBundleId = useAppSelector((state) => state.layers.selectedBundleId);

  const { bundle } = useBundle(selectedBundleId);
  const { members } = useBundleLayers(selectedBundleId);

  // A spatial predicate needs a geometry column to resolve against, and an
  // attribute-table member has none.
  const memberLayerId = useMemo(
    () => members?.find((member) => !!member.feature_layer_geometry_type)?.layer_id,
    [members]
  );

  // Not every type can be filtered: the filter produces a *copy* whose
  // artifacts are rebuilt from the clipped layers, which a GTFS bundle cannot
  // do — its feed is not kept. The flag comes from the type's spec, so this
  // gate opens on its own once PT filtering is supported.
  const canFilter = !!bundle?.artifacts_from_layers;

  // The strip stays even when Metadata is the only tab: every other panel in
  // this slot is tabbed, and a bundle that dropped the header would read as a
  // different kind of panel rather than as the same one with less in it.
  // `activeTab` stays the tab's identity, so the strip's index is derived and
  // the panels below keep addressing themselves by name.
  const tabs = canFilter ? [FILTER_TAB, METADATA_TAB] : [METADATA_TAB];
  const tabLabel: Record<number, string> = {
    [FILTER_TAB]: t("filter"),
    [METADATA_TAB]: t("metadata.title"),
  };

  // Which tab is open is already in Redux — the panel slot the tree opened,
  // and what a tab click dispatches — so it is derived, not mirrored. Clamped
  // to a tab that exists: the slot can ask for Filter on a bundle that has no
  // Filter tab.
  const activeTab =
    canFilter && activeRightPanel === MapSidebarItemID.FILTER ? FILTER_TAB : METADATA_TAB;
  const isTabLive = useLazyTabs(activeTab, selectedBundleId);

  const handleTabChange = (value: number) => {
    dispatch(
      setActiveRightPanel(value === FILTER_TAB ? MapSidebarItemID.FILTER : MapSidebarItemID.PROPERTIES)
    );
  };

  const handleClose = () => {
    dispatch(setSelectedBundle(null));
    dispatch(setActiveRightPanel(undefined));
  };

  const renderContent = () => {
    if (!bundle) return null;
    return (
      <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
          <Tabs
            value={Math.max(tabs.indexOf(activeTab), 0)}
            onChange={(_, index) => handleTabChange(tabs[index])}
            variant="fullWidth"
            aria-label="Bundle Settings Tabs">
            {tabs.map((tab) => (
              <Tab key={tab} label={tabLabel[tab]} />
            ))}
          </Tabs>
        </Box>
        <Box sx={{ flexGrow: 1, overflowY: "auto", p: 0 }}>
          {canFilter && (
            <Box role="tabpanel" hidden={activeTab !== FILTER_TAB} sx={{ height: "100%" }}>
              {isTabLive(FILTER_TAB) &&
                (memberLayerId ? (
                  <BundleFilter
                    key={bundle.id}
                    bundle={bundle}
                    projectId={projectId}
                    memberLayerId={memberLayerId}
                  />
                ) : (
                  <Typography variant="body2" sx={{ p: 3, fontStyle: "italic" }}>
                    {t("filter_bundle_no_geometry")}
                  </Typography>
                ))}
            </Box>
          )}
          <Box role="tabpanel" hidden={activeTab !== METADATA_TAB} sx={{ height: "100%" }}>
            {/* The aggregated fields, status and artifact state — the same
                at-a-glance set the bundle's own page leads with. The long
                provenance list stays on that page; a panel this narrow cannot
                carry nine fields. Padding matches the layer metadata tab. */}
            {isTabLive(METADATA_TAB) && (
              <Stack spacing={4} sx={{ p: 2 }}>
                <BundleSummary bundle={bundle} hideMetadataSection />
              </Stack>
            )}
          </Box>
        </Box>
      </Box>
    );
  };

  const title = bundle ? bundle.name : t("bundle");
  return (
    <Box sx={{ height: "100%" }}>
      <Container title={title} disablePadding={true} close={handleClose} body={renderContent()} />
    </Box>
  );
};

export default BundleSettingsPanel;
