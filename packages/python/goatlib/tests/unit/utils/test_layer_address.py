"""What a layer's stored address shows to someone who cannot edit the layer:
a raster file added from an address loses its query string and fragment
(which can carry an access key); map services, catalog layers and anything
that is no http(s) address are returned as stored."""

import pytest
from goatlib.utils.layer_address import address_shown

FILE = "https://example.org/a/b.tif?sig=secret#x"


def test_a_viewer_gets_a_remote_files_address_without_query_and_fragment() -> None:
    assert (
        address_shown(FILE, data_type="cog", catalog=False, can_edit=False)
        == "https://example.org/a/b.tif"
    )


def test_an_editor_gets_the_address_whole() -> None:
    assert address_shown(FILE, data_type="cog", catalog=False, can_edit=True) == FILE


@pytest.mark.parametrize(
    "url",
    [
        "https://example.org/a/b.tif?sig=secret",
        "https://example.org/a/b.tif#secret",
        "http://example.org/a/b.tif?sig=secret",
        "HTTPS://example.org/a/b.tif?sig=secret",
    ],
)
def test_query_or_fragment_alone_is_removed(url: str) -> None:
    shown = address_shown(url, data_type="cog", catalog=False, can_edit=False)
    assert shown is not None and "secret" not in shown
    assert shown.lower().endswith("://example.org/a/b.tif")


def test_credentials_in_the_address_are_removed_too() -> None:
    """Scheme, host and path are kept; a user and password before the host are
    an access key like the query's."""
    assert (
        address_shown(
            "https://user:secret@example.org:8443/a/b.tif?sig=secret",
            data_type="cog",
            catalog=False,
            can_edit=False,
        )
        == "https://example.org:8443/a/b.tif"
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://example.org/a/b.tif",
        "https://example.org/a%20b/c.tif",
        "https://example.org",
    ],
)
def test_an_address_without_query_is_unchanged(url: str) -> None:
    assert address_shown(url, data_type="cog", catalog=False, can_edit=False) == url


@pytest.mark.parametrize(
    "url",
    [
        "s3://bucket/a/b.tif?sig=secret",
        "/data/a/b.tif?sig=secret",
        "ftp://example.org/a/b.tif?sig=secret",
    ],
)
def test_an_address_that_is_not_http_is_untouched(url: str) -> None:
    assert address_shown(url, data_type="cog", catalog=False, can_edit=False) == url


@pytest.mark.parametrize("data_type", ["wms", "wmts", "xyz", "mvt", "wfs", None])
def test_map_services_and_other_kinds_are_untouched(data_type: str | None) -> None:
    """The browser loads a map service's tiles straight from its address."""
    url = "https://tiles.example.org/{z}/{x}/{y}.png?api_key=secret"
    assert address_shown(url, data_type=data_type, catalog=False, can_edit=False) == url


def test_a_catalog_layer_is_untouched() -> None:
    assert address_shown(FILE, data_type="cog", catalog=True, can_edit=False) == FILE


def test_no_address_stays_none() -> None:
    assert address_shown(None, data_type="cog", catalog=False, can_edit=False) is None
