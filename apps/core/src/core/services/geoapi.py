"""core's client of geoapi (`GOAT_GEOAPI_URL`): the bounds of a raster layer's
COG, which core cannot read itself (its image has no raster reader)."""

import math
from uuid import UUID

import aiohttp
from core.core.config import settings

#: geoapi reads only the file's header, and a file that does not answer fails
#: there within seconds.
RASTER_BOUNDS_TIMEOUT_S = 15

Bounds = tuple[float, float, float, float]


class RasterBoundsUnavailable(Exception):  # noqa: N818
    """geoapi could not say a COG's bounds: unconfigured, down, refused, or an
    answer that is no bounds."""


async def raster_bounds(layer_id: UUID, *, access_token: str) -> Bounds | None:
    """West, south, east and north in EPSG:4326 of the stored raster layer's
    file, read by geoapi as the caller; None when the file's bounds are no box
    on earth."""
    if not settings.GOAT_GEOAPI_URL:
        raise RasterBoundsUnavailable("GOAT_GEOAPI_URL is not configured")
    url = f"{settings.GOAT_GEOAPI_URL.rstrip('/')}/collections/{layer_id}/raster/bounds"
    headers = {"Authorization": f"Bearer {access_token}"} if access_token else {}
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=RASTER_BOUNDS_TIMEOUT_S)
        ) as session:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    raise RasterBoundsUnavailable(
                        f"raster bounds answered {response.status}"
                    )
                body = await response.json()
    except (aiohttp.ClientError, TimeoutError, ValueError) as error:
        raise RasterBoundsUnavailable(str(error)) from error
    bounds = body.get("bounds") if isinstance(body, dict) else "missing"
    if bounds is None:
        return None
    if (
        not isinstance(bounds, list)
        or len(bounds) != 4
        or not all(isinstance(v, int | float) and math.isfinite(v) for v in bounds)
    ):
        raise RasterBoundsUnavailable(f"no bounds in the answer: {body!r}")
    west, south, east, north = (float(v) for v in bounds)
    return west, south, east, north
