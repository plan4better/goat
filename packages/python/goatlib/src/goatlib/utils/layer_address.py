"""What a layer's stored address shows to whom.

Two kinds of layer keep an address no browser loads, which may carry an access
key (a signed link or a shared access signature in its query string, or a user
and password before the host):

- a raster layer added from a file's address (`data_type` cog), in `url`:
  geoapi reads the file by the layer id;
- a layer copied from a WFS (`data_type` wfs), in `other_properties.url`: it
  names the service the features came from, which GOAT now holds.

Someone who cannot edit the layer gets those addresses without the key;
whoever can edit it gets them whole. Map services (wms, wmts, xyz) are drawn by
the browser straight from their address and keep it for everyone; catalog
layers and uploaded data are left as stored.

Who can edit is core's `layer_write_allowed`: core's reads and the project
export ask it and pass the answer here. Log lines and job errors never hold a
key, whoever reads them: they name an address with `without_key` and clean
quoted text (an error of GDAL's or of requests) with `text_without_keys`.
"""

import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

#: The kinds whose stored address no browser loads.
KEYED_KINDS = frozenset({"cog", "wfs"})

#: A query, a fragment or a `user:password@` in free text: the parts of an
#: address that can be an access key. A query runs to the next whitespace,
#: quotes included, so a quote inside it cannot end it early (the quote that
#: closes a quoted address goes with it).
KEY_IN_TEXT = re.compile(r"[?#]\S*|(?<=//)[^/\s@]+@")


def text_without_keys(text: str) -> str:
    """Free text (an error, a log line) without the queries, fragments and
    credentials of the addresses it quotes."""
    return KEY_IN_TEXT.sub("", text)


def without_key(address: str) -> str:
    """An http(s) address without its query string, fragment and
    user/password (scheme, host, port and path kept); anything else as it is.
    An address urllib cannot split is cleaned as text."""
    try:
        parts = urlsplit(address)
    except ValueError:
        return text_without_keys(address)
    if parts.scheme.lower() not in ("http", "https"):
        return address
    host = parts.netloc.rpartition("@")[2]
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


def address_shown(
    url: str | None, *, data_type: Any, catalog: bool, can_edit: bool
) -> str | None:
    """The address of a layer as this caller gets it: a remote raster file's or
    a WFS copy's without its query string, fragment and user/password for a
    caller who cannot edit the layer (scheme, host, port and path kept);
    anything else as stored."""
    kind = getattr(data_type, "value", data_type)
    if can_edit or catalog or not url or kind not in KEYED_KINDS:
        return url
    return without_key(url)


def layer_shown(
    layer: Mapping[str, Any], *, catalog: bool, can_edit: bool
) -> Mapping[str, Any]:
    """A layer row (`data_type`, and `url` and `other_properties` where it has
    them) as this caller gets it: both addresses through `address_shown`. The
    row itself when nothing changes, else a copy; the row is never changed."""

    def shown(address: str | None) -> str | None:
        return address_shown(
            address,
            data_type=layer.get("data_type"),
            catalog=catalog,
            can_edit=can_edit,
        )

    changed: dict[str, Any] = {}
    url = layer.get("url")
    if shown(url) != url:
        changed["url"] = shown(url)
    other = layer.get("other_properties")
    if isinstance(other, Mapping) and shown(other.get("url")) != other.get("url"):
        changed["other_properties"] = {**other, "url": shown(other.get("url"))}
    return {**layer, **changed} if changed else layer
