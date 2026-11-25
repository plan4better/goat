"""The default public transport network, as the tools that cut and route it see it.

The network itself lies on the shared data volume, which the tools read from
``PT_NETWORK_BASE_PATH`` (goatlib's routing settings). A dialog that offers a
cut of it shows where the network is, so the file describing that is served
here, read from the same path the tools read.
"""

from fastapi import APIRouter, Depends, Response
from fastapi.responses import FileResponse, JSONResponse
from goatlib.bundles.importers.pt_network.store import coverage_mask_path
from goatlib.config.settings import settings as goatlib_settings

from processes.deps.auth import get_user_id

router = APIRouter(prefix="/pt-network", tags=["PT network"])


@router.get(
    "/coverage-mask",
    summary="Coverage mask of the default public transport network",
    dependencies=[Depends(get_user_id)],
    responses={
        200: {"description": "The mask as GeoJSON, or null where the network has none."}
    },
)
async def coverage_mask() -> Response:
    """The areas the default network serves, as a GeoJSON mask: one polygon over
    the world with those areas cut out of it.

    Not every network version has one, and a server without the data volume
    has none to read: then null. Answered rather than refused, as a network
    without a mask is a normal state, not an error, and a refusal is logged
    as a failed request by every browser that asks."""
    path = coverage_mask_path(goatlib_settings.routing.pt_network_base_path)
    if not path.is_file():
        return JSONResponse(None)
    return FileResponse(path, media_type="application/geo+json")
