"use client";

import { getCogMetadata } from "@geomatico/maplibre-cog-protocol";
import LoadingButton from "@mui/lab/LoadingButton";
import {
  Box,
  CircularProgress,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import type { Theme } from "@mui/material";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import type { CogPreview, ConnectFailure, ConnectedService } from "@/lib/utils/externalService";
import {
  cogPreview,
  isDirect,
  pickedLayers,
  previewSource,
  selectionBounds,
  serviceLayers,
} from "@/lib/utils/externalService";

import type { ConnectFlow } from "@/hooks/addLayer/useConnectFlow";

import ConnectLayerList from "@/components/addLayer/ConnectLayerList";
import ConnectPreview from "@/components/addLayer/ConnectPreview";
import UploadDestinationPill from "@/components/addLayer/UploadDestinationPill";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** The kinds on offer, shown before anything is connected so the address box is not a guess. */
const KINDS: {
  short: string;
  name?: string;
  nameKey?: string;
  whatKey: string;
  icon: ICON_NAME;
  copy?: boolean;
}[] = [
  { short: "WMS", name: "Web Map Service", whatKey: "connect_service_kind_wms", icon: ICON_NAME.WMS },
  { short: "WMTS", name: "Web Map Tile Service", whatKey: "connect_service_kind_wmts", icon: ICON_NAME.WMTS },
  {
    short: "WFS",
    name: "Web Feature Service",
    whatKey: "connect_service_kind_wfs",
    icon: ICON_NAME.WFS,
    copy: true,
  },
  {
    short: "XYZ",
    nameKey: "connect_service_kind_xyz_name",
    whatKey: "connect_service_kind_xyz",
    icon: ICON_NAME.XYZ,
  },
  {
    short: "COG",
    name: "Cloud Optimized GeoTIFF",
    whatKey: "connect_service_kind_cog",
    icon: ICON_NAME.RASTER,
  },
];

const FAILURE_COPY: Record<ConnectFailure, { title: string; body: string; checks: string[] }> = {
  unreachable: {
    title: "connect_service_error_unreachable_title",
    body: "connect_service_error_unreachable_body",
    checks: ["connect_service_error_unreachable_check_tab", "connect_service_error_unreachable_check_login"],
  },
  unrecognised: {
    title: "connect_service_error_unrecognised_title",
    body: "connect_service_error_unrecognised_body",
    checks: [
      "connect_service_error_unrecognised_check_ogc",
      "connect_service_error_unrecognised_check_tiles",
    ],
  },
  empty: { title: "connect_service_error_empty_title", body: "connect_service_error_empty_body", checks: [] },
  invalid: {
    title: "connect_service_error_invalid_title",
    body: "connect_service_error_invalid_body",
    checks: [],
  },
};

/** Green text that stays readable on both themes: the dark shade vanishes on a dark paper. */
const accentInk = (theme: Theme) =>
  theme.palette.mode === "dark" ? theme.palette.primary.light : theme.palette.primary.dark;

/** A few projections, then a count: some services list twenty-five, which pushes the rest
 * of the pane out of view. Web Mercator first, since it is the one that decides. */
const projectionSummary = (crs: string[], more: (count: number) => string) => {
  const ordered = [...crs].sort((a, b) => Number(b === "EPSG:3857") - Number(a === "EPSG:3857"));
  const shown = ordered.slice(0, 4).join(", ");
  return ordered.length > 4 ? `${shown} ${more(ordered.length - 4)}` : shown;
};

const hostOf = (address: string) => {
  try {
    return new URL(address.trim()).hostname;
  } catch {
    return address;
  }
};

/** Live or copy: the one thing about a service that changes what the layer can do. */
const ModeTag = ({ mode }: { mode: ConnectedService["mode"] }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const live = mode === "live";
  return (
    <Box
      title={t(live ? "connect_service_live_tip" : "connect_service_copy_tip")}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 1.25,
        flexShrink: 0,
        px: 2.5,
        py: 0.75,
        borderRadius: 999,
        border: `1px solid ${live ? alpha(theme.palette.primary.main, 0.4) : theme.palette.divider}`,
        backgroundColor: live ? alpha(theme.palette.primary.main, 0.08) : theme.palette.action.hover,
        color: live ? accentInk(theme) : theme.palette.text.secondary,
      }}>
      <Icon
        iconName={live ? ICON_NAME.LINK : ICON_NAME.DATABASE}
        style={{ fontSize: 11 }}
        htmlColor="currentColor"
      />
      <Typography variant="caption" fontWeight={700} sx={{ color: "inherit", lineHeight: 1.4 }}>
        {t(live ? "connect_service_live" : "connect_service_copy")}
      </Typography>
    </Box>
  );
};

const Label = ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
  <Typography
    variant="body2"
    fontWeight="bold"
    component="label"
    htmlFor={htmlFor}
    sx={{ display: "block", mb: 1.5 }}>
    {children}
  </Typography>
);

const Note = ({ i18nKey }: { i18nKey: string }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{ p: 3, borderRadius: 2, backgroundColor: theme.palette.action.hover, lineHeight: 1.55 }}>
      <Trans
        i18nKey={i18nKey}
        t={t}
        components={{ b: <Box component="b" sx={{ color: "text.primary" }} /> }}
      />
    </Typography>
  );
};

const MetaGrid = ({ rows }: { rows: { label: string; value: string }[] }) => (
  <Box sx={{ display: "grid", gridTemplateColumns: "110px minmax(0, 1fr)", columnGap: 3, rowGap: 1.5 }}>
    {rows.map((row) => [
      <Typography key={`${row.label}-k`} variant="caption" fontWeight={600} color="text.secondary">
        {row.label}
      </Typography>,
      <Typography key={`${row.label}-v`} variant="caption" sx={{ overflowWrap: "anywhere" }}>
        {row.value}
      </Typography>,
    ])}
  </Box>
);

const KindCards = () => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  return (
    <Stack spacing={3.5} sx={{ p: 6, overflowY: "auto" }}>
      <Typography
        variant="caption"
        fontWeight={700}
        color="text.secondary"
        sx={{ letterSpacing: 0.6, textTransform: "uppercase" }}>
        {t("connect_service_what_you_can_connect")}
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(5, minmax(0, 1fr))" },
          gap: 3,
        }}>
        {KINDS.map((kind) => (
          <Stack
            key={kind.short}
            spacing={2}
            sx={{ border: `1px solid ${theme.palette.divider}`, borderRadius: 2.5, p: 3.5, minHeight: 150 }}>
            <Stack direction="row" spacing={2} alignItems="center">
              <Box
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: "7px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.palette.action.hover,
                }}>
                <Icon
                  iconName={kind.icon}
                  style={{ fontSize: 15 }}
                  htmlColor={theme.palette.text.secondary}
                />
              </Box>
              <Typography variant="body2" fontWeight={800}>
                {kind.short}
              </Typography>
            </Stack>
            <Typography variant="caption" fontWeight={600}>
              {kind.nameKey ? t(kind.nameKey) : kind.name}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, lineHeight: 1.45 }}>
              {t(kind.whatKey)}
            </Typography>
            <Box sx={{ alignSelf: "flex-start" }}>
              <ModeTag mode={kind.copy ? "copy" : "live"} />
            </Box>
          </Stack>
        ))}
      </Box>
    </Stack>
  );
};

const Failure = ({ failure, address }: { failure: ConnectFailure; address: string }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const copy = FAILURE_COPY[failure];
  return (
    <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", p: 8 }} role="alert">
      <Stack direction="row" spacing={4} sx={{ maxWidth: 560 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: "10px",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: alpha(theme.palette.error.main, 0.12),
          }}>
          <Icon
            iconName={ICON_NAME.CIRCLEINFO}
            style={{ fontSize: 18 }}
            htmlColor={theme.palette.error.main}
          />
        </Box>
        <Stack spacing={2}>
          <Typography variant="body1" fontWeight={700}>
            {t(copy.title)}
          </Typography>
          <Typography variant="body2" sx={{ lineHeight: 1.55 }}>
            {t(copy.body, { host: hostOf(address) })}
          </Typography>
          {copy.checks.length > 0 && (
            <>
              <Typography
                variant="caption"
                fontWeight={700}
                color="text.secondary"
                sx={{ letterSpacing: 0.6, textTransform: "uppercase", pt: 1.5 }}>
                {t("connect_service_worth_checking")}
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 4.5 }}>
                {copy.checks.map((check) => (
                  <Typography key={check} component="li" variant="body2" sx={{ lineHeight: 1.5 }}>
                    {t(check)}
                  </Typography>
                ))}
              </Box>
            </>
          )}
        </Stack>
      </Stack>
    </Box>
  );
};

/** The service's layers beside what the picked one looks like and what it is. */
const ServiceBrowser = ({ controller }: { controller: ConnectFlow }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { connect } = controller;
  const service = connect.service as ConnectedService;
  const imagery = service.mode === "live";
  const focus =
    serviceLayers(service).find((layer) => layer.id === connect.focusedId) ??
    pickedLayers(service, connect.selected)[0];

  return (
    <Box sx={{ display: "flex", flexDirection: { xs: "column", md: "row" }, flex: 1, minHeight: 0 }}>
      <Box
        sx={{
          width: { xs: "100%", md: 420 },
          height: { xs: 320, md: "auto" },
          flexShrink: 0,
          borderRight: { md: `1px solid ${theme.palette.divider}` },
          borderBottom: { xs: `1px solid ${theme.palette.divider}`, md: "none" },
          minHeight: 0,
        }}>
        <ConnectLayerList
          service={service}
          selected={connect.selected}
          focusedId={connect.focusedId}
          onToggle={connect.toggleLayer}
        />
      </Box>
      <Stack spacing={3.5} sx={{ flex: 1, minWidth: 0, p: 5, overflowY: "auto" }}>
        {imagery && (
          <ConnectPreview
            source={previewSource(service, connect.selected)}
            bounds={selectionBounds(service, connect.selected)}
            height={220}
          />
        )}
        {focus && (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={2} alignItems="baseline" sx={{ minWidth: 0 }}>
              <Typography variant="body1" fontWeight={700} noWrap>
                {focus.title}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ fontFamily: MONO }}>
                {focus.id}
              </Typography>
            </Stack>
            {focus.abstract && (
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
                {focus.abstract}
              </Typography>
            )}
            {focus.crs.length > 0 && (
              <MetaGrid
                rows={[
                  imagery
                    ? {
                        label: t("connect_service_projections"),
                        value: projectionSummary(focus.crs, (count) =>
                          t("connect_service_more_projections", { count })
                        ),
                      }
                    : {
                        label: t("connect_service_projection"),
                        value: t("connect_service_reprojected", { crs: focus.crs[0] }),
                      },
                ]}
              />
            )}
          </Stack>
        )}
        <Box sx={{ flex: 1 }} />
        <Note i18nKey={imagery ? "connect_service_live_note" : "connect_service_copy_note"} />
      </Stack>
    </Box>
  );
};

/** How many times a COG's details were read, for the key each read gets. */
let cogReads = 0;

/**
 * What the browser can preview of a COG, from the file's details as the map's COG reader reads them; `undefined`
 * while they are read and for any other address. Each Connect makes a new service, so the file is read again. The
 * reader keeps every file it opened by its address, a failed one too, so each read passes the address with a key of
 * its own as a fragment, which no request carries: a read that failed is not kept for the next one, nor for the
 * address the map draws from once the file can be drawn.
 */
const useCogPreview = (service: ConnectedService): CogPreview | undefined => {
  const url = service.kind === "cog" ? service.url : undefined;
  const [preview, setPreview] = useState<{ service: ConnectedService; preview: CogPreview }>();
  useEffect(() => {
    if (!url) return;
    let current = true;
    getCogMetadata(`${url}#preview-${++cogReads}`).then(
      (details) => current && setPreview({ service, preview: cogPreview(details) }),
      () => current && setPreview({ service, preview: cogPreview(null) })
    );
    return () => {
      current = false;
    };
  }, [service, url]);
  return url && preview?.service === service ? preview.preview : undefined;
};

/** A tile template or COG: the address is the layer, so there is only the preview. */
const DirectService = ({ service }: { service: ConnectedService }) => {
  const { t } = useTranslation("common");
  const cog = useCogPreview(service);
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: { xs: "column", md: "row" },
        gap: 5,
        flex: 1,
        minHeight: 0,
        p: 5,
      }}>
      <Box sx={{ flex: 1, minHeight: 240 }}>
        {service.kind === "cog" ? (
          // A COG is drawn only once the browser knows it can draw it, fitted to the file.
          <ConnectPreview
            source={cog?.kind === "draw" ? previewSource(service, []) : null}
            bounds={cog?.kind === "draw" ? cog.bounds : undefined}
            checking={!cog}
            note={cog?.kind === "unavailable" ? t("connect_service_cog_no_preview") : undefined}
          />
        ) : (
          <ConnectPreview source={previewSource(service, [])} />
        )}
      </Box>
      <Stack spacing={3} sx={{ width: { xs: "100%", md: 300 }, flexShrink: 0 }}>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
          {t(service.kind === "cog" ? "connect_service_direct_cog" : "connect_service_direct_tiles")}
        </Typography>
        <Typography variant="caption" sx={{ overflowWrap: "anywhere" }} color="text.secondary">
          {service.url}
        </Typography>
      </Stack>
    </Box>
  );
};

/**
 * The Connect service flow's content: the address, what the service offers once read, and
 * the name and folder the layer gets.
 *
 * One view, where the dialog it replaces had four steps: the address never goes away, so a
 * wrong one is fixed where it was typed, and there is no confirmation page repeating what is
 * already on screen.
 */
const ConnectBody = ({ controller }: { controller: ConnectFlow }) => {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const { connect } = controller;
  const { service, status } = connect;
  const connected = status === "connected" && !!service;

  return (
    <Stack sx={{ minHeight: 0 }}>
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (connect.address.trim()) void connect.connect();
        }}
        sx={{ px: 6, pt: 4.5, pb: 3.5 }}>
        <Label htmlFor="connect-service-address">{t("connect_service_address")}</Label>
        <Stack direction="row" spacing={2.5}>
          <TextField
            id="connect-service-address"
            fullWidth
            size="small"
            autoFocus
            value={connect.address}
            onChange={(event) => connect.setAddress(event.target.value)}
            placeholder={t("connect_service_address_placeholder")}
            error={status === "failed"}
            inputProps={{ spellCheck: false }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Icon
                    iconName={ICON_NAME.GLOBE}
                    style={{ fontSize: 14 }}
                    htmlColor={theme.palette.text.secondary}
                  />
                </InputAdornment>
              ),
              endAdornment: connect.address ? (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    aria-label={t("connect_service_clear")}
                    onClick={() => connect.setAddress("")}>
                    <Icon iconName={ICON_NAME.CLOSE} style={{ fontSize: 12 }} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            }}
          />
          <LoadingButton
            type="submit"
            variant="contained"
            loading={status === "connecting"}
            disabled={!connect.address.trim()}
            sx={{ flexShrink: 0, px: 5 }}>
            {t("connect_service_connect")}
          </LoadingButton>
        </Stack>

        {connected ? (
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2.5, minWidth: 0 }}>
            <Typography
              variant="caption"
              fontWeight={800}
              sx={{
                flexShrink: 0,
                px: 1.75,
                py: 0.5,
                borderRadius: 1,
                color: accentInk(theme),
                backgroundColor: alpha(theme.palette.primary.main, 0.12),
              }}>
              {[service.kind.toUpperCase(), service.version].filter(Boolean).join(" ")}
            </Typography>
            <Typography variant="body2" fontWeight={700} noWrap>
              {service.title}
            </Typography>
            {service.provider && (
              <Typography variant="body2" color="text.secondary" noWrap sx={{ flexShrink: 0 }}>
                · {service.provider}
              </Typography>
            )}
            <Box sx={{ flex: 1 }} />
            <ModeTag mode={service.mode} />
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 2 }}>
            {t("connect_service_hint")}
          </Typography>
        )}
      </Box>

      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          borderTop: `1px solid ${theme.palette.divider}`,
          // Fixed, so the dialog keeps its size from one state to the next.
          height: { xs: "auto", md: 420 },
          minHeight: 0,
        }}>
        {status === "idle" && <KindCards />}
        {status === "connecting" && (
          <Stack spacing={3} alignItems="center" justifyContent="center" sx={{ flex: 1, py: 8 }}>
            <CircularProgress size={26} />
            <Typography variant="body2" color="text.secondary">
              {t("connect_service_reading")}
            </Typography>
          </Stack>
        )}
        {status === "failed" && connect.failure && (
          <Failure failure={connect.failure} address={connect.address} />
        )}
        {connected &&
          (isDirect(service) ? (
            <DirectService service={service} />
          ) : (
            <ServiceBrowser controller={controller} />
          ))}
      </Box>

      {connected && (
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={4}
          alignItems={{ xs: "stretch", sm: "flex-end" }}
          sx={{ px: 6, pt: 3.5, pb: 4, borderTop: `1px solid ${theme.palette.divider}` }}>
          <Box sx={{ width: { xs: "100%", sm: 400 } }}>
            <Label htmlFor="connect-service-name">{t("layer_name")}</Label>
            <TextField
              id="connect-service-name"
              fullWidth
              size="small"
              value={connect.name}
              onChange={(event) => connect.setName(event.target.value)}
              error={!connect.name.trim() && connect.selected.length > 0}
            />
          </Box>
          <Box>
            <Label>{t("connect_service_save_to")}</Label>
            <Box sx={{ height: 40, display: "flex", alignItems: "center" }}>
              <UploadDestinationPill
                folders={connect.folders}
                selected={connect.selectedFolder}
                onSelect={connect.setSelectedFolder}
              />
            </Box>
          </Box>
          <Box sx={{ flex: 1 }} />
          {service.multiple && connect.selected.length > 1 && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ maxWidth: 260, lineHeight: 1.45, textAlign: { sm: "right" }, pb: 1 }}>
              {t("connect_service_combine", { count: connect.selected.length })}
            </Typography>
          )}
        </Stack>
      )}
    </Stack>
  );
};

export default ConnectBody;
