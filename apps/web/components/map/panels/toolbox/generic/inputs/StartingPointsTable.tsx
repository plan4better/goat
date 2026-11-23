/**
 * Starting Points Table Component
 *
 * Displays a table of starting points selected via map clicks.
 * Allows zooming to and deleting individual points.
 */
import { IconButton, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMap } from "react-map-gl/maplibre";
import { v4 } from "uuid";

import { ICON_NAME, Icon } from "@p4b/ui/components/Icon";

import { setToolboxStartingPoints } from "@/lib/store/map/slice";

import { useAppDispatch, useAppSelector } from "@/hooks/store/ContextHooks";

interface StartingPointsTableProps {
  maxStartingPoints?: number;
}

export default function StartingPointsTable({ maxStartingPoints }: StartingPointsTableProps) {
  const { map } = useMap();
  const theme = useTheme();
  const { t } = useTranslation("common");
  const dispatch = useAppDispatch();
  const startingPoints = useAppSelector((state) => state.map.toolboxStartingPoints);

  const handleZoomToStartingPoint = (coordinate: [number, number]) => {
    if (!map) return;
    map.flyTo({ center: coordinate, zoom: 16 });
  };

  const handleDeleteStartingPoint = (index: number) => {
    if (!startingPoints?.length) return;
    const newStartingPoints = startingPoints.filter((_, i) => i !== index);
    dispatch(setToolboxStartingPoints(undefined));
    if (newStartingPoints.length > 0) {
      dispatch(setToolboxStartingPoints(newStartingPoints));
    }
  };

  // Handle map clicks to add starting points
  useEffect(() => {
    const handleMapClick = (event: MapMouseEvent) => {
      const coordinate = [event.lngLat.lng, event.lngLat.lat] as [number, number];
      if (maxStartingPoints === 1) {
        dispatch(setToolboxStartingPoints(undefined));
      }
      dispatch(setToolboxStartingPoints([coordinate]));
    };

    if (!map) return;
    map.on("click", handleMapClick);
    return () => {
      map.off("click", handleMapClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, maxStartingPoints]);

  return (
    <>
      <Table size="small" aria-label={t("starting_points_table")} stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell align="left" sx={{ backgroundColor: "transparent" }}>
              <Typography variant="caption" fontWeight="bold">
                Lon
              </Typography>
            </TableCell>
            <TableCell align="left" sx={{ backgroundColor: "transparent" }}>
              <Typography variant="caption" fontWeight="bold">
                Lat
              </Typography>
            </TableCell>
            <TableCell align="right" sx={{ backgroundColor: "transparent" }}>
              {" "}
            </TableCell>
          </TableRow>
        </TableHead>
      </Table>
      {/* Second table as workaround to make the table body scrollable */}
      <TableContainer style={{ marginTop: 0, maxHeight: 250 }}>
        <Table size="small" aria-label={t("starting_points_table")}>
          <TableBody>
            {!startingPoints?.length && (
              <TableRow>
                <TableCell align="center" colSpan={3}>
                  <Typography variant="caption" fontWeight="bold">
                    {t("no_starting_points_added")}
                  </Typography>
                </TableCell>
              </TableRow>
            )}

            {!startingPoints
              ? null
              : startingPoints.map((point, index) => (
                  <TableRow key={v4()}>
                    <TableCell align="center" sx={{ px: 2 }}>
                      <Typography variant="caption" fontWeight="bold">
                        {point[0].toFixed(4)}
                      </Typography>
                    </TableCell>
                    <TableCell align="center" sx={{ px: 2 }}>
                      <Typography variant="caption" fontWeight="bold">
                        {point[1].toFixed(4)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right" sx={{ px: 2 }}>
                      <Stack direction="row" alignItems="center" justifyContent="end" spacing={1}>
                        <Tooltip title={t("zoom_to_starting_point")} placement="top">
                          <IconButton
                            size="small"
                            onClick={() => handleZoomToStartingPoint(point)}
                            sx={{
                              "&:hover": {
                                color: theme.palette.primary.main,
                              },
                            }}>
                            <Icon
                              iconName={ICON_NAME.ZOOM_IN}
                              style={{ fontSize: "12px" }}
                              htmlColor="inherit"
                            />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={t("delete_starting_point")} placement="top">
                          <IconButton
                            size="small"
                            sx={{
                              "&:hover": {
                                color: theme.palette.error.main,
                              },
                            }}
                            onClick={() => handleDeleteStartingPoint(index)}>
                            <Icon
                              iconName={ICON_NAME.TRASH}
                              style={{ fontSize: "12px" }}
                              htmlColor="inherit"
                            />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}
