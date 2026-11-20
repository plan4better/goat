"""What a layer's stored address shows to whom.

A raster layer added from a file's address (`data_type` cog) may carry an
access key in that address: a signed link or a shared access signature in its
query string, or a user and password before the host. No browser loads that
file (geoapi reads it by the layer id), so someone who cannot edit the layer
gets the address without them; whoever can edit it gets it whole. Map services
(wms, wmts, xyz) are drawn by the browser straight from their address and keep
it for everyone; catalog layers and uploaded data are left as stored.

Who can edit is core's `layer_write_allowed`: core's reads and the project
export ask it and pass the answer here.
"""

from typing import Any
from urllib.parse import urlsplit, urlunsplit


def address_shown(
    url: str | None, *, data_type: Any, catalog: bool, can_edit: bool
) -> str | None:
    """The address of a layer as this caller gets it: a remote raster file's
    without its query string, fragment and user/password for a caller who
    cannot edit the layer (scheme, host, port and path kept); anything else
    as stored."""
    if can_edit or catalog or not url or data_type != "cog":
        return url
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        return url
    host = parts.netloc.rpartition("@")[2]
    return urlunsplit((parts.scheme, host, parts.path, "", ""))
