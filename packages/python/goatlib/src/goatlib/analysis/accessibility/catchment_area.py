"""
Catchment Area Analysis - Isochrone/Isoline Generation.

This module provides:
1. CatchmentAreaTool - A tool for computing catchment areas via routing services
2. Functions to decode binary grid data from R5 routing engine
3. Functions to generate isolines (isochrones) from travel time grid data using marching squares
4. R5 region mapping utilities for looking up region config from parquet files

Original isoline implementation from:
https://github.com/plan4better/goat/blob/0089611acacbebf4e2978c404171ebbae75591e2/app/client/src/utils/Jsolines.js
"""

import asyncio
import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self, Sequence

import duckdb
import httpx
import numpy as np
from geopandas import GeoDataFrame
from numba import njit
from numpy.typing import NDArray
from shapely.geometry import shape

from goatlib.analysis.core.base import AnalysisTool
from goatlib.analysis.schemas.catchment_area import (
    AccessEgressMode,
    CatchmentAreaRoutingMode,
    CatchmentAreaMeasureType,
    CatchmentAreaToolParams,
    CatchmentAreaType,
    PTMode,
)
from goatlib.config.settings import settings
from goatlib.io.parquet import write_optimized_parquet
from goatlib.models.io import DatasetMetadata

logger = logging.getLogger(__name__)

MAX_COORDS = 20000


# =============================================================================
# R5 Region Mapping
# =============================================================================


@dataclass
class R5RegionConfig:
    """Configuration for an R5 region."""

    region_id: str
    bundle_id: str
    host: str

    @classmethod
    def from_row(cls: type[Self], row: tuple) -> Self:
        """Create from database row tuple."""
        return cls(
            region_id=row[0],
            bundle_id=row[1],
            host=row[2],
        )


def get_r5_region_for_point(
    lat: float,
    lon: float,
    parquet_path: str | Path,
    geometry_column: str = "geometry",
) -> R5RegionConfig | None:
    """
    Look up R5 region configuration for a geographic point.

    Uses DuckDB spatial extension to find which region polygon
    contains the given point coordinates.

    Args:
        lat: Latitude of the point
        lon: Longitude of the point
        parquet_path: Path to the region mapping parquet file
        geometry_column: Name of the geometry column in the parquet file

    Returns:
        R5RegionConfig if a matching region is found, None otherwise

    Raises:
        FileNotFoundError: If the parquet file doesn't exist
    """
    parquet_path = Path(parquet_path)
    if not parquet_path.exists():
        raise FileNotFoundError(f"Region mapping parquet not found: {parquet_path}")

    con = duckdb.connect(":memory:")
    con.install_extension("spatial")
    con.load_extension("spatial")

    # Query for region containing the point
    # The geometry column should be GEOMETRY type from the parquet file
    query = f"""
        SELECT r5_region_id, r5_bundle_id, r5_host
        FROM read_parquet('{parquet_path}')
        WHERE ST_Intersects(
            ST_Point({lon}, {lat}),
            {geometry_column}
        )
        LIMIT 1
    """

    try:
        result = con.execute(query).fetchone()
        if result:
            return R5RegionConfig.from_row(result)
        return None
    except duckdb.Error as e:
        logger.error("Failed to query region mapping: %s", e)
        raise
    finally:
        con.close()


def compute_bounds_for_point(
    lat: float,
    lon: float,
    buffer_meters: float = 100000,
) -> dict[str, float]:
    """
    Compute bounding box around a point with a buffer distance.

    Args:
        lat: Latitude of the center point
        lon: Longitude of the center point
        buffer_meters: Buffer distance in meters (default 100km)

    Returns:
        Dictionary with north, south, east, west bounds
    """
    con = duckdb.connect(":memory:")
    con.install_extension("spatial")
    con.load_extension("spatial")

    try:
        # Approximate meters to degrees (1 degree ≈ 111,320 meters at equator)
        buffer_degrees = buffer_meters / 111320.0

        query = f"""
            WITH buffered AS (
                SELECT ST_Envelope(
                    ST_Buffer(ST_Point({lon}, {lat}), {buffer_degrees})
                ) AS geom
            )
            SELECT
                ST_XMin(geom) AS west,
                ST_YMin(geom) AS south,
                ST_XMax(geom) AS east,
                ST_YMax(geom) AS north
            FROM buffered
        """

        result = con.execute(query).fetchone()
        return {
            "north": result[3],
            "south": result[1],
            "east": result[2],
            "west": result[0],
        }
    finally:
        con.close()


# =============================================================================
# R5 Grid Decoding
# =============================================================================


def decode_r5_grid(grid_data_buffer: bytes) -> dict[str, Any]:
    """
    Decode R5 grid data from binary format.

    The R5 grid format consists of:
    - 8-byte header type (should be "ACCESSGR")
    - 7 int32 header entries: version, zoom, west, north, width, height, depth
    - Grid data: width * height * depth int32 values (delta-encoded)
    - JSON metadata at the end

    Args:
        grid_data_buffer: Raw binary data from R5 response

    Returns:
        Dictionary containing:
        - header fields (zoom, west, north, width, height, depth, version)
        - data: numpy array of travel times
        - metadata fields from JSON

    Raises:
        ValueError: If grid type or version is invalid
    """
    current_version = 0
    header_entries = 7
    header_length = 9  # type + entries
    times_grid_type = "ACCESSGR"

    # -- PARSE HEADER
    ## - get header type
    header = {}
    header_data = np.frombuffer(grid_data_buffer, count=8, dtype=np.byte)
    header_type = "".join(map(chr, header_data))
    if header_type != times_grid_type:
        raise ValueError(
            f"Invalid grid type: {header_type}, expected {times_grid_type}"
        )
    ## - get header data
    header_raw = np.frombuffer(
        grid_data_buffer, count=header_entries, offset=8, dtype=np.int32
    )
    version = header_raw[0]
    if version != current_version:
        raise ValueError(f"Invalid grid version: {version}, expected {current_version}")
    header["zoom"] = header_raw[1]
    header["west"] = header_raw[2]
    header["north"] = header_raw[3]
    header["width"] = header_raw[4]
    header["height"] = header_raw[5]
    header["depth"] = header_raw[6]
    header["version"] = version

    # -- PARSE DATA --
    grid_size = header["width"] * header["height"]
    # - skip the header
    data = np.frombuffer(
        grid_data_buffer,
        offset=header_length * 4,
        count=grid_size * header["depth"],
        dtype=np.int32,
    )
    # - reshape the data
    data = data.reshape(header["depth"], grid_size)
    reshaped_data = np.array([], dtype=np.int32)
    for i in range(header["depth"]):
        reshaped_data = np.append(reshaped_data, data[i].cumsum())
    data = reshaped_data
    # - decode metadata
    raw_metadata = np.frombuffer(
        grid_data_buffer,
        offset=(header_length + header["width"] * header["height"] * header["depth"])
        * 4,
        dtype=np.int8,
    )
    metadata = json.loads(raw_metadata.tobytes())

    return dict(header | metadata | {"data": data, "errors": [], "warnings": []})


# =============================================================================
# Coordinate Conversion
# =============================================================================


@njit(cache=True)
def z_scale(z: int) -> int:
    """
    Convert zoom level to pixel scale.

    2^z represents the tile number. Scale that by the number of pixels in each tile.
    """
    pixels_per_tile = 256
    return int(2**z * pixels_per_tile)


@njit(cache=True)
def pixel_to_longitude(pixel_x: float, zoom: int) -> float:
    """Convert pixel x coordinate to longitude."""
    return float((pixel_x / z_scale(zoom)) * 360 - 180)


@njit(cache=True)
def pixel_to_latitude(pixel_y: float, zoom: int) -> float:
    """Convert pixel y coordinate to latitude."""
    lat_rad = math.atan(math.sinh(math.pi * (1 - (2 * pixel_y) / z_scale(zoom))))
    return lat_rad * 180 / math.pi


@njit(cache=True)
def pixel_x_to_web_mercator_x(x: float, zoom: int) -> float:
    """Convert pixel x to Web Mercator x."""
    return float(x * (40075016.68557849 / (z_scale(zoom))) - (40075016.68557849 / 2.0))


@njit(cache=True)
def pixel_y_to_web_mercator_y(y: float, zoom: int) -> float:
    """Convert pixel y to Web Mercator y."""
    return float(
        y * (40075016.68557849 / (-1 * z_scale(zoom))) + (40075016.68557849 / 2.0)
    )


@njit(cache=True)
def coordinate_from_pixel(
    input: list[float], zoom: int, round_int: bool = False, web_mercator: bool = False
) -> list[float]:
    """
    Convert pixel coordinate to longitude and latitude.

    Args:
        input: [x, y] pixel coordinates
        zoom: Zoom level
        round_int: Whether to round to integers
        web_mercator: Whether to output in Web Mercator (EPSG:3857)

    Returns:
        [x, y] in geographic or Web Mercator coordinates
    """
    if web_mercator:
        x = pixel_x_to_web_mercator_x(input[0], zoom)
        y = pixel_y_to_web_mercator_y(input[1], zoom)
    else:
        x = pixel_to_longitude(input[0], zoom)
        y = pixel_to_latitude(input[1], zoom)
    if round_int:
        x = round(x)
        y = round(y)

    return [x, y]


# =============================================================================
# Surface Computation
# =============================================================================


def compute_r5_surface(
    grid: dict[str, Any], percentile: int
) -> NDArray[np.uint16] | None:
    """
    Compute single value surface from the grid.

    Args:
        grid: Decoded R5 grid data
        percentile: Percentile to extract (5, 25, 50, 75, 95)

    Returns:
        1D numpy array of travel times for the requested percentile
    """
    if (
        grid["data"] is None
        or grid["width"] is None
        or grid["height"] is None
        or grid["depth"] is None
    ):
        return None
    travel_time_percentiles = [5, 25, 50, 75, 95]
    percentile_index = travel_time_percentiles.index(percentile)

    if grid["depth"] == 1:
        # if only one percentile is requested, return the grid as is
        surface: NDArray[Any] = grid["data"]
    else:
        grid_percentiles = np.reshape(grid["data"], (grid["depth"], -1))
        surface = grid_percentiles[percentile_index]

    return surface.astype(np.uint16)


# =============================================================================
# Marching Squares Contouring
# =============================================================================


@njit
def get_contour(
    surface: NDArray[np.float64], width: int, height: int, cutoff: float
) -> NDArray[np.int8]:
    """
    Get a contouring grid using marching squares lookup.

    Creates a grid where each cell is assigned an index (0-15) based on which
    corners are inside the isochrone (below the cutoff value).
    """
    contour = np.zeros((width - 1) * (height - 1), dtype=np.int8)

    # compute contour values for each cell
    for x in range(width - 1):
        for y in range(height - 1):
            index = y * width + x
            top_left = surface[index] < cutoff
            top_right = surface[index + 1] < cutoff
            bot_left = surface[index + width] < cutoff
            bot_right = surface[index + width + 1] < cutoff

            # if we're at the edge of the area, set the outer sides to false, so that
            # isochrones always close even when they actually extend beyond the edges
            # of the surface

            if x == 0:
                top_left = bot_left = False
            if x == width - 2:
                top_right = bot_right = False
            if y == 0:
                top_left = top_right = False
            if y == height - 2:
                bot_right = bot_left = False

            idx = 0

            if top_left:
                idx |= 1 << 3
            if top_right:
                idx |= 1 << 2
            if bot_right:
                idx |= 1 << 1
            if bot_left:
                idx |= 1

            contour[y * (width - 1) + x] = idx

    return contour


@njit
def follow_loop(idx: int, xy: Sequence[int], prev_xy: Sequence[int]) -> list[int]:
    """
    Follow the loop using marching squares lookup.

    We keep track of which contour cell we're in, and we always keep the filled
    area to our left. Thus we always indicate only which direction we exit the cell.
    """
    x = xy[0]
    y = xy[1]
    prevx = prev_xy[0]
    prevy = prev_xy[1]

    if idx in (1, 3, 7):
        return [x - 1, y]
    elif idx in (2, 6, 14):
        return [x, y + 1]
    elif idx in (4, 12, 13):
        return [x + 1, y]
    elif idx == 5:
        # Assume that saddle has // orientation (as opposed to \\). It doesn't
        # really matter if we're wrong, we'll just have two disjoint pieces
        # where we should have one, or vice versa.
        # From Bottom:
        if prevy > y:
            return [x + 1, y]

        # From Top:
        if prevy < y:
            return [x - 1, y]

        return [x, y]
    elif idx in (8, 9, 11):
        return [x, y - 1]
    elif idx == 10:
        # From left
        if prevx < x:
            return [x, y + 1]

        # From right
        if prevx > x:
            return [x, y - 1]

        return [x, y]

    else:
        return [x, y]


@njit
def interpolate(
    pos: Sequence[int],
    cutoff: float,
    start: Sequence[int],
    surface: NDArray[np.float64],
    width: int,
    height: int,
) -> list[float] | None:
    """
    Do linear interpolation to find exact position on cell edge.
    """
    x = pos[0]
    y = pos[1]
    startx = start[0]
    starty = start[1]
    index = y * width + x
    top_left = surface[index]
    top_right = surface[index + 1]
    bot_left = surface[index + width]
    bot_right = surface[index + width + 1]
    if x == 0:
        top_left = bot_left = cutoff
    if y == 0:
        top_left = top_right = cutoff
    if y == height - 2:
        bot_right = bot_left = cutoff
    if x == width - 2:
        top_right = bot_right = cutoff
    # From left
    if startx < x:
        frac = (cutoff - top_left) / (bot_left - top_left)
        return [x, y + ensure_fraction_is_number(frac, "left")]
    # From right
    if startx > x:
        frac = (cutoff - top_right) / (bot_right - top_right)
        return [x + 1, y + ensure_fraction_is_number(frac, "right")]
    # From bottom
    if starty > y:
        frac = (cutoff - bot_left) / (bot_right - bot_left)
        return [x + ensure_fraction_is_number(frac, "bottom"), y + 1]
    # From top
    if starty < y:
        frac = (cutoff - top_left) / (top_right - top_left)
        return [x + ensure_fraction_is_number(frac, "top"), y]
    return None


@njit
def no_interpolate(pos: Sequence[int], start: Sequence[int]) -> list[float] | None:
    """Get midpoint coordinates without interpolation."""
    x = pos[0]
    y = pos[1]
    startx = start[0]
    starty = start[1]
    # From left
    if startx < x:
        return [x, y + 0.5]
    # From right
    if startx > x:
        return [x + 1, y + 0.5]
    # From bottom
    if starty > y:
        return [x + 0.5, y + 1]
    # From top
    if starty < y:
        return [x + 0.5, y]
    return None


@njit
def ensure_fraction_is_number(frac: float, direction: str) -> float:
    """Ensure calculated fractions are valid numbers."""
    if math.isnan(frac) or math.isinf(frac):
        return 0.5
    return frac


@njit
def calculate_jsolines(
    surface: NDArray[np.float64],
    width: int,
    height: int,
    west: float,
    north: float,
    zoom: int,
    cutoffs: NDArray[np.float64],
    interpolation: bool = True,
    web_mercator: bool = True,
) -> list[list[Any]]:
    """
    Calculate isoline geometries from a surface.

    Uses marching squares algorithm to trace contour lines around areas
    that are below each cutoff value.
    """
    geometries = []
    for _, cutoff in np.ndenumerate(cutoffs):
        contour = get_contour(surface, width, height, cutoff)
        c_width = width - 1
        # Store warnings
        warnings = []

        # JavaScript does not have boolean arrays.
        found = np.zeros((width - 1) * (height - 1), dtype=np.int8)

        # DEBUG, comment out to save memory
        indices = []

        # We'll sort out what shell goes with what hole in a bit.
        shells = []
        holes = []

        # Find a cell that has a line in it, then follow that line, keeping filled
        # area to your left. This lets us use winding direction to determine holes.

        for origy in range(height - 1):
            for origx in range(width - 1):
                index = origy * c_width + origx
                if found[index] == 1:
                    continue
                idx = contour[index]

                # Continue if there is no line here or if it's a saddle, as we don't know which way the saddle goes.
                if idx == 0 or idx == 5 or idx == 10 or idx == 15:
                    continue

                # Huzzah! We have found a line, now follow it, keeping the filled area to our left,
                # which allows us to use the winding direction to determine what should be a shell and
                # what should be a hole
                pos = [origx, origy]
                prev = [-1, -1]
                start = [-1, -1]

                # Track winding direction
                direction = 0
                coords = []

                # Make sure we're not traveling in circles.
                # NB using index from _previous_ cell, we have not yet set an index for this cell

                while found[index] != 1:
                    prev = start
                    start = pos
                    idx = contour[index]

                    indices.append(idx)

                    # Mark as found if it's not a saddle because we expect to reach saddles twice.
                    if idx != 5 and idx != 10:
                        found[index] = 1

                    if idx == 0 or idx >= 15:
                        warnings.append("Ran off outside of ring")
                        break

                    # Follow the loop
                    pos = follow_loop(idx, pos, prev)
                    index = pos[1] * c_width + pos[0]

                    # Keep track of winding direction
                    direction += (pos[0] - start[0]) * (pos[1] + start[1])

                    # Shift exact coordinates
                    if interpolation:
                        coord = interpolate(pos, cutoff, start, surface, width, height)
                    else:
                        coord = no_interpolate(pos, start)

                    if not coord:
                        warnings.append(
                            f"Unexpected coordinate shift from ${start[0]}, ${start[1]} to ${pos[0]}, ${pos[1]}, discarding ring"
                        )
                        break
                    xy = coordinate_from_pixel(
                        [coord[0] + west, coord[1] + north],
                        zoom=zoom,
                        web_mercator=web_mercator,
                    )
                    coords.append(xy)

                    # We're back at the start of the ring
                    if pos[0] == origx and pos[1] == origy:
                        coords.append(coords[0])  # close the ring

                        # make it a fully-fledged GeoJSON object
                        geom = [coords]

                        # Check winding direction. Positive here means counter clockwise,
                        # see http:#stackoverflow.com/questions/1165647
                        # +y is down so the signs are reversed from what would be expected
                        if direction > 0:
                            shells.append(geom)
                        else:
                            holes.append(geom)
                        break

        # Shell game time. Sort out shells and holes.
        for hole in holes:
            # Only accept holes that are at least 2-dimensional.
            # Workaround (x+y) to avoid float to str type conversion in numba
            vertices = []
            for x, y in hole[0]:
                vertices.append((x + y))

            if len(vertices) >= 3:
                # NB this is checking whether the first coordinate of the hole is inside
                # the shell. This is sufficient as shells don't overlap, and holes are
                # guaranteed to be completely contained by a single shell.
                hole_point = hole[0][0]
                containing_shell = []
                for shell in shells:
                    if pointinpolygon(hole_point[0], hole_point[1], shell[0]):
                        containing_shell.append(shell)
                if len(containing_shell) == 1:
                    containing_shell[0].append(hole[0])

        geometries.append(list(shells))
    return geometries


@njit
def pointinpolygon(x: float, y: float, poly: NDArray[np.float64]) -> bool:
    """Check if point is inside polygon using ray casting."""
    n = len(poly)
    inside = False
    p2x = 0.0
    p2y = 0.0
    xints = 0.0
    p1x, p1y = poly[0]
    for i in range(n + 1):
        p2x, p2y = poly[i % n]
        if y > min(p1y, p2y):
            if y <= max(p1y, p2y):
                if x <= max(p1x, p2x):
                    if p1y != p2y:
                        xints = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                    if p1x == p2x or x <= xints:
                        inside = not inside
        p1x, p1y = p2x, p2y

    return inside


# =============================================================================
# High-Level Isoline API
# =============================================================================


def jsolines(
    surface: NDArray[np.uint16],
    width: int,
    height: int,
    west: float,
    north: float,
    zoom: int,
    cutoffs: NDArray[np.float16 | np.int16],
    interpolation: bool = True,
    return_incremental: bool = False,
    web_mercator: bool = False,
) -> dict[str, GeoDataFrame]:
    """
    Calculate isolines from a surface.

    Args:
        surface: 1D array of travel time values
        width: Width of the grid
        height: Height of the grid
        west: Western edge pixel coordinate
        north: Northern edge pixel coordinate
        zoom: Zoom level
        cutoffs: Array of cutoff values (travel times in minutes)
        interpolation: Whether to interpolate between pixels
        return_incremental: Whether to also return incremental isolines
        web_mercator: Whether to use Web Mercator coordinates (EPSG:3857)

    Returns:
        Dictionary with:
        - 'full': GeoDataFrame with cumulative isolines
        - 'incremental': GeoDataFrame with difference isolines (if return_incremental=True)
    """
    isochrone_multipolygon_coordinates = calculate_jsolines(
        surface, width, height, west, north, zoom, cutoffs, interpolation, web_mercator
    )

    result = {}
    isochrone_shapes = []
    for isochrone in isochrone_multipolygon_coordinates:
        isochrone_shapes.append(
            shape({"type": "MultiPolygon", "coordinates": isochrone})
        )

    result["full"] = GeoDataFrame({"geometry": isochrone_shapes, "minute": cutoffs})

    if return_incremental:
        isochrone_diff = []
        for i in range(len(isochrone_shapes)):
            if i == 0:
                isochrone_diff.append(isochrone_shapes[i])
            else:
                isochrone_diff.append(
                    isochrone_shapes[i].difference(isochrone_shapes[i - 1])
                )

        result["incremental"] = GeoDataFrame(
            {"geometry": isochrone_diff, "minute": cutoffs}
        )

    crs = "EPSG:4326"
    if web_mercator:
        crs = "EPSG:3857"
    for key in result:
        result[key].crs = crs

    return result


def generate_jsolines(
    grid: dict[str, Any],
    travel_time: int,
    percentile: int,
    steps: int,
) -> dict[str, GeoDataFrame]:
    """
    Generate isolines from decoded R5 grid data.

    This is the main high-level function that converts R5 response data
    to polygon geometries.

    Args:
        grid: Decoded R5 grid data (from decode_r5_grid)
        travel_time: Maximum travel time in minutes
        percentile: Percentile to use (5, 25, 50, 75, 95)
        steps: Number of isochrone steps

    Returns:
        Dictionary with 'full' and 'incremental' GeoDataFrames
    """
    single_value_surface = compute_r5_surface(
        grid,
        percentile,
    )
    grid["surface"] = single_value_surface
    isochrones = jsolines(
        grid["surface"],
        grid["width"],
        grid["height"],
        grid["west"],
        grid["north"],
        grid["zoom"],
        cutoffs=np.arange(
            start=(travel_time / steps),
            stop=travel_time + 1,
            step=(travel_time / steps),
        ),
        return_incremental=True,
    )
    return isochrones


# =============================================================================
# Catchment Area Tool
# =============================================================================


class CatchmentAreaTool(AnalysisTool):
    """
    Tool for computing catchment areas (isochrones) via routing services.

    This tool calls routing APIs to compute isochrones for various transport modes:
    - Active mobility: walking, bicycle, pedelec, wheelchair (via GOAT Routing)
    - Motorized: car (via GOAT Routing)
    - Public transport: bus, tram, rail, etc. (via R5)

    Routing URL and authorization can be provided either:
    1. In CatchmentAreaToolParams (per-request)
    2. In the tool constructor (default for all requests)
    3. Via environment config (goatlib.config.settings)

    For PT routing, R5 region configuration can be:
    - Provided explicitly via r5_region_id and r5_bundle_id
    - Looked up automatically from a region mapping parquet file

    Example usage:
        # Active mobility
        tool = CatchmentAreaTool()
        result = tool.run(CatchmentAreaToolParams(
            latitude=51.7167,
            longitude=14.3837,
            routing_mode=CatchmentAreaRoutingMode.walking,
            travel_time=15,
            steps=3,
            output_path="output/catchment.parquet",
            routing_url="https://routing.example.com",
        ))

        # Public transport with automatic region lookup
        tool = CatchmentAreaTool(
            r5_region_mapping_path="/path/to/region_mapping.parquet"
        )
        result = tool.run(CatchmentAreaToolParams(
            latitude=51.7167,
            longitude=14.3837,
            routing_mode=CatchmentAreaRoutingMode.pt,
            transit_modes=[PTMode.bus, PTMode.tram],
            time_window=PTTimeWindow(weekday="weekday", from_time=25200, to_time=32400),
            output_path="output/catchment.parquet"
        ))
    """

    # HTTP request configuration
    DEFAULT_TIMEOUT = 300.0
    DEFAULT_RETRIES = 60
    DEFAULT_RETRY_INTERVAL = 2

    def __init__(
        self: Self,
        routing_url: str | None = None,
        authorization: str | None = None,
        r5_region_id: str | None = None,
        r5_bundle_id: str | None = None,
        r5_region_mapping_path: str | None = None,
    ) -> None:
        """
        Initialize the tool.

        Args:
            routing_url: Default routing service URL (GOAT Routing or R5)
            authorization: Default authorization header
            r5_region_id: R5 region/project ID (for PT routing without mapping)
            r5_bundle_id: R5 bundle ID (for PT routing without mapping)
            r5_region_mapping_path: Path to parquet file with R5 region boundaries.
                If provided, region/bundle/host will be looked up based on coordinates.
        """
        super().__init__()
        self._default_routing_url = routing_url or settings.routing.goat_routing_url
        self._default_authorization = (
            authorization or settings.routing.routing_authorization
        )
        self._r5_region_id = r5_region_id
        self._r5_bundle_id = r5_bundle_id
        self._r5_region_mapping_path = r5_region_mapping_path

        # HTTP settings from config
        self._timeout = getattr(
            settings.routing, "request_timeout", self.DEFAULT_TIMEOUT
        )
        self._retries = getattr(
            settings.routing, "request_retries", self.DEFAULT_RETRIES
        )
        self._retry_interval = getattr(
            settings.routing, "request_retry_interval", self.DEFAULT_RETRY_INTERVAL
        )

    def _get_routing_url(self: Self, params: CatchmentAreaToolParams) -> str:
        """Get routing URL from params or defaults."""
        return params.routing_url or self._default_routing_url

    def _get_authorization(self: Self, params: CatchmentAreaToolParams) -> str | None:
        """Get authorization from params or defaults."""
        return params.authorization or self._default_authorization

    def _run_implementation(
        self: Self, params: CatchmentAreaToolParams
    ) -> list[tuple[Path, DatasetMetadata]]:
        """Execute catchment area analysis by calling routing APIs."""
        routing_mode = (
            params.routing_mode.value
            if isinstance(params.routing_mode, CatchmentAreaRoutingMode)
            else params.routing_mode
        )

        logger.info(
            "Computing catchment area: routing_mode=%s, lat=%s, lon=%s",
            routing_mode,
            params.latitude,
            params.longitude,
        )

        # Get or create event loop
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        # Default metadata for catchment area output
        metadata = DatasetMetadata(
            path=str(params.output_path),
            source_type="vector",
            format="geoparquet",
            geometry_type="Polygon",
            geometry_column="geometry",
        )

        if routing_mode == "pt":
            result_gdf = loop.run_until_complete(self._compute_pt_catchment(params))
            path = self._save_geodataframe(result_gdf, params.output_path)
            return [(path, metadata)]
        elif routing_mode == "car":
            result_bytes = loop.run_until_complete(self._compute_car_catchment(params))
            path = self._save_bytes(result_bytes, params.output_path)
            return [(path, metadata)]
        else:
            # Active mobility modes (walking, bicycle, pedelec, wheelchair)
            result_bytes = loop.run_until_complete(
                self._compute_active_mobility_catchment(params)
            )
            path = self._save_bytes(result_bytes, params.output_path)
            return [(path, metadata)]

    # =========================================================================
    # GOAT Routing: Active Mobility
    # =========================================================================

    async def _compute_active_mobility_catchment(
        self: Self, params: CatchmentAreaToolParams
    ) -> bytes:
        """Compute catchment area for active mobility modes via GOAT Routing."""
        routing_url = self._get_routing_url(params)
        authorization = self._get_authorization(params)

        url = f"{routing_url}/active-mobility/catchment-area"

        # Normalize coordinates to lists
        lat_list = (
            [params.latitude]
            if isinstance(params.latitude, (int, float))
            else list(params.latitude)
        )
        lon_list = (
            [params.longitude]
            if isinstance(params.longitude, (int, float))
            else list(params.longitude)
        )

        # Get routing type string
        routing_type = (
            params.routing_mode.value
            if isinstance(params.routing_mode, CatchmentAreaRoutingMode)
            else params.routing_mode
        )
        # Get measure type string
        measure_type = (
            params.measure_type.value
            if isinstance(params.measure_type, CatchmentAreaMeasureType)
            else params.measure_type
        )
        # Get catchment area type string
        area_type = (
            params.catchment_area_type.value
            if isinstance(params.catchment_area_type, CatchmentAreaType)
            else params.catchment_area_type
        )
        # Build payload
        if measure_type == CatchmentAreaMeasureType.time:
            payload = {
                "starting_points": {
                    "latitude": lat_list,
                    "longitude": lon_list,
                },
                "routing_type": routing_type,
                "travel_cost": {
                    "max_traveltime": params.travel_time,
                    "steps": params.steps,
                    "speed": params.speed or 5.0,
                },
                "catchment_area_type": area_type,
                "output_format": "parquet",
            }
        elif measure_type == CatchmentAreaMeasureType.distance:
            payload = {
                "starting_points": {
                    "latitude": lat_list,
                    "longitude": lon_list,
                },
                "routing_type": routing_type,
                "travel_cost": {
                    "max_distance": params.distance,
                    "steps": params.steps
                },
                "catchment_area_type": area_type,
                "output_format": "parquet",
            }
        if area_type == "polygon":
            payload["polygon_difference"] = params.polygon_difference

        # Note: scenario_id is only sent to routing when a street_network
        # is also provided (routing requires both). Feature-only scenarios
        # don't affect the routing graph.
        if params.scenario_id and hasattr(params, "street_network") and params.street_network:
            payload["scenario_id"] = params.scenario_id
            payload["street_network"] = params.street_network

        logger.info(payload)
        return await self._post_with_retry(url, payload, authorization)

    # =========================================================================
    # GOAT Routing: Car
    # =========================================================================

    async def _compute_car_catchment(
        self: Self, params: CatchmentAreaToolParams
    ) -> bytes:
        """Compute catchment area for car mode via GOAT Routing."""
        routing_url = self._get_routing_url(params)
        authorization = self._get_authorization(params)

        url = f"{routing_url}/motorized-mobility/catchment-area"

        # Normalize coordinates to lists
        lat_list = (
            [params.latitude]
            if isinstance(params.latitude, (int, float))
            else list(params.latitude)
        )
        lon_list = (
            [params.longitude]
            if isinstance(params.longitude, (int, float))
            else list(params.longitude)
        )
        measure_type = (
            params.measure_type.value
            if isinstance(params.measure_type, CatchmentAreaMeasureType)
            else params.measure_type
        )
        # Get catchment area type string
        area_type = (
            params.catchment_area_type.value
            if isinstance(params.catchment_area_type, CatchmentAreaType)
            else params.catchment_area_type
        )

        # Build payload
        if measure_type == CatchmentAreaMeasureType.time:
            payload = {
                "starting_points": {
                    "latitude": lat_list,
                    "longitude": lon_list,
                },
                "routing_type": "car",
                "travel_cost": {
                    "max_traveltime": params.travel_time,
                    "steps": params.steps,
                },
                "catchment_area_type": area_type,
                "output_format": "parquet",
            }
        elif measure_type == CatchmentAreaMeasureType.distance:
            payload = {
                "starting_points": {
                    "latitude": lat_list,
                    "longitude": lon_list,
                },
                "routing_type": "car",
                "travel_cost": {
                    "max_distance": params.distance,
                    "steps": params.steps
                },
                "catchment_area_type": area_type,
                "output_format": "parquet",
            }
        if area_type == "polygon":
            payload["polygon_difference"] = params.polygon_difference

        # Note: scenario_id is only sent to routing when a street_network
        # is also provided (routing requires both). Feature-only scenarios
        # don't affect the routing graph.
        if params.scenario_id and hasattr(params, "street_network") and params.street_network:
            payload["scenario_id"] = params.scenario_id
            payload["street_network"] = params.street_network

        return await self._post_with_retry(url, payload, authorization)

    # =========================================================================
    # R5: Public Transport
    # =========================================================================

    async def _compute_pt_catchment(
        self: Self, params: CatchmentAreaToolParams
    ) -> GeoDataFrame:
        """Compute PT catchment via R5 and convert to GeoDataFrame."""
        # PT only supports single starting point
        lat = (
            params.latitude[0] if isinstance(params.latitude, list) else params.latitude
        )
        lon = (
            params.longitude[0]
            if isinstance(params.longitude, list)
            else params.longitude
        )

        # Get R5 region configuration
        r5_region_id: str | None = self._r5_region_id
        r5_bundle_id: str | None = self._r5_bundle_id
        # Use routing_url from params (should be R5 URL for PT routing)
        r5_host: str = self._get_routing_url(params)

        # Try to look up region/bundle from parquet mapping if available
        # Params takes precedence over constructor
        r5_mapping_path = params.r5_region_mapping_path or self._r5_region_mapping_path
        if r5_mapping_path:
            region_config = get_r5_region_for_point(
                lat=lat,
                lon=lon,
                parquet_path=r5_mapping_path,
            )
            if region_config:
                r5_region_id = region_config.region_id
                r5_bundle_id = region_config.bundle_id
                logger.info(
                    "Found R5 region from mapping: region=%s, bundle=%s",
                    r5_region_id,
                    r5_bundle_id,
                )
            else:
                logger.warning(
                    "No R5 region found for point (%s, %s) in mapping",
                    lat,
                    lon,
                )

        # Validate we have region config
        if not r5_region_id or not r5_bundle_id:
            raise ValueError(
                "R5 region configuration not found. Either provide r5_region_id and "
                "r5_bundle_id to the tool constructor, or provide r5_region_mapping_path "
                "with a parquet file containing region boundaries."
            )

        authorization = self._get_authorization(params)

        # Convert transit_modes from schema enum to strings
        transit_modes = ["BUS", "TRAM", "RAIL", "SUBWAY"]
        if params.transit_modes:
            transit_modes = [
                m.value.upper() if isinstance(m, PTMode) else m.upper()
                for m in params.transit_modes
            ]

        # Convert access/egress modes
        access_mode = (
            params.access_mode.value.upper()
            if isinstance(params.access_mode, AccessEgressMode)
            else params.access_mode.upper()
        )
        egress_mode = (
            params.egress_mode.value.upper()
            if isinstance(params.egress_mode, AccessEgressMode)
            else params.egress_mode.upper()
        )

        # Extract time window settings
        from_time = 25200  # 07:00 default
        to_time = 32400  # 09:00 default
        weekday_date = "2025-09-16"  # Weekday (Tuesday) default - matches core

        if params.time_window:
            # Convert time to seconds if needed
            if hasattr(params.time_window.from_time, "hour"):
                from_time = (
                    params.time_window.from_time.hour * 3600
                    + params.time_window.from_time.minute * 60
                )
            else:
                from_time = params.time_window.from_time

            if hasattr(params.time_window.to_time, "hour"):
                to_time = (
                    params.time_window.to_time.hour * 3600
                    + params.time_window.to_time.minute * 60
                )
            else:
                to_time = params.time_window.to_time

            # Map day type to sample dates (R5 needs actual dates)
            # These must match the GTFS validity period in the R5 bundle
            # Using September 2025 dates (same as core app)
            weekday_dates = {
                "weekday": "2025-09-16",  # Tuesday
                "saturday": "2025-09-20",  # Saturday
                "sunday": "2025-09-21",  # Sunday
            }
            weekday_date = weekday_dates.get(params.time_window.weekday, weekday_date)

        # Hardcoded percentile=5 (same as core)
        percentile = 5

        # Compute bounds dynamically using 100km buffer
        bounds = compute_bounds_for_point(lat, lon, buffer_meters=100000)

        payload = {
            "accessModes": access_mode,
            "transitModes": ",".join(transit_modes),
            "bikeSpeed": 4.17,  # m/s (15 km/h)
            "walkSpeed": 1.39,  # m/s (5 km/h)
            "bikeTrafficStress": 4,
            "date": weekday_date,
            "fromTime": from_time,
            "toTime": to_time,
            "maxTripDurationMinutes": params.travel_time,
            "decayFunction": {
                "type": "logistic",
                "standard_deviation_minutes": 12,
                "width_minutes": 10,
            },
            "destinationPointSetIds": [],
            "bounds": bounds,
            "directModes": access_mode,
            "egressModes": egress_mode,
            "fromLat": lat,
            "fromLon": lon,
            "zoom": 9,
            "maxBikeTime": 20,
            "maxRides": 4,
            "maxWalkTime": 20,
            "monteCarloDraws": 200,
            "percentiles": [5],  # Use 5th percentile for conservative travel times
            "variantIndex": getattr(settings.routing, "r5_variant_index", -1),
            "workerVersion": getattr(settings.routing, "r5_worker_version", "v7.2"),
            "regionId": r5_region_id,
            "projectId": r5_region_id,
            "bundleId": r5_bundle_id,
        }

        logger.debug("R5 payload: %s", payload)

        url = f"{r5_host}/api/analysis"
        r5_binary = await self._post_with_retry(url, payload, authorization)

        # Decode R5 binary and generate isolines
        grid = decode_r5_grid(r5_binary)
        logger.info(
            "Decoded R5 grid: %dx%d, depth=%d",
            grid["width"],
            grid["height"],
            grid["depth"],
        )

        isochrones = generate_jsolines(
            grid=grid,
            travel_time=params.travel_time,
            percentile=percentile,
            steps=params.steps,
        )

        result_key = "incremental" if params.polygon_difference else "full"
        result_gdf = isochrones[result_key]
        result_gdf["cost_step"] = result_gdf["minute"].astype(int)
        return result_gdf

    # =========================================================================
    # HTTP Helper
    # =========================================================================

    async def _post_with_retry(
        self: Self,
        url: str,
        payload: dict,
        authorization: str | None,
    ) -> bytes:
        """Make POST request with retry logic for 202 responses."""
        headers = {}
        if authorization:
            headers["Authorization"] = authorization

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            for i in range(self._retries):
                response = await client.post(url, json=payload, headers=headers)

                if response.status_code == 202:
                    # Still processing, retry
                    if i == self._retries - 1:
                        raise RuntimeError(
                            f"Routing endpoint took too long to process request: {url}"
                        )
                    await asyncio.sleep(self._retry_interval)
                    continue
                elif response.status_code in (200, 201):
                    return response.content
                else:
                    raise RuntimeError(
                        f"Routing error ({response.status_code}): {response.text}"
                    )

        raise RuntimeError(f"Failed to get response from {url}")

    # =========================================================================
    # Output Helpers
    # =========================================================================

    def _save_geodataframe(self: Self, gdf: GeoDataFrame, output_path: str) -> Path:
        """Save GeoDataFrame to output path as GeoParquet with proper geometry."""
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        if path.suffix == ".parquet":
            # Convert geometry to WKT for DuckDB import
            gdf = gdf.copy()
            gdf["geometry"] = gdf["geometry"].apply(lambda g: g.wkt)

            # Use DuckDB to convert WKT to proper GEOMETRY and save as parquet
            con = duckdb.connect()
            con.execute("INSTALL spatial; LOAD spatial;")

            # Register the dataframe
            con.register("gdf_table", gdf)

            # Build column list, converting geometry WKT to GEOMETRY type
            non_geom_cols = [c for c in gdf.columns if c != "geometry"]
            select_cols = ", ".join(non_geom_cols)
            if select_cols:
                select_cols += ", "

            # Export with geometry converted to proper GEOMETRY type
            query = f"""
                SELECT {select_cols}ST_CollectionExtract(ST_MakeValid(ST_GeomFromText(geometry)), 3) AS geometry
                FROM gdf_table
            """
            write_optimized_parquet(
                con,
                query,
                path,
                geometry_column="geometry",
            )
            con.close()
        else:
            gdf.to_file(path, driver="GeoJSON")

        logger.info("Saved catchment area to: %s", path)
        return path

    def _save_bytes(self: Self, data: bytes, output_path: str) -> Path:
        """Save raw bytes to output path, converting WKT geometry to proper GEOMETRY."""
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        # First write bytes to temp file
        temp_path = path.with_suffix(".tmp.parquet")
        with open(temp_path, "wb") as f:
            f.write(data)

        # Use DuckDB to convert WKT string geometry to proper GEOMETRY type
        con = duckdb.connect()
        con.execute("INSTALL spatial; LOAD spatial;")

        try:
            # Check if geometry column exists and is string type (WKT)
            schema = con.execute(f"DESCRIBE SELECT * FROM '{temp_path}'").fetchall()
            col_info = {row[0]: row[1] for row in schema}

            if "geometry" in col_info and "VARCHAR" in col_info["geometry"].upper():
                # Geometry is WKT string - convert to proper GEOMETRY
                non_geom_cols = [c for c in col_info.keys() if c != "geometry"]
                if "minute" in non_geom_cols:
                    # remove minutes as not adapted to distance
                    non_geom_cols.remove("minute")
                select_cols = ", ".join(non_geom_cols)
                if select_cols:
                    select_cols += ", "

                query = f"""
                    SELECT {select_cols}ST_CollectionExtract(ST_MakeValid(ST_GeomFromText(geometry)), 3) AS geometry
                    FROM '{temp_path}'
                """
                write_optimized_parquet(
                    con,
                    query,
                    path,
                    geometry_column="geometry",
                )
                logger.info("Converted WKT geometry to GEOMETRY and saved to: %s", path)
            else:
                # Geometry is already proper format, just copy
                import shutil

                shutil.move(str(temp_path), str(path))
                logger.info("Saved catchment area to: %s (%d bytes)", path, len(data))
        finally:
            con.close()
            # Clean up temp file if it still exists
            if temp_path.exists():
                temp_path.unlink()

        return path
