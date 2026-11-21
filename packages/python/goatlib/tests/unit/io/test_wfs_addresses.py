"""The WFS reader names the service in its errors and log lines by scheme,
host and path: a WFS address can carry an access key in its query or a user
and password before the host. GDAL is stood in for, so these run without the
GDAL Python bindings."""

import sys
import types
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

SERVICE = "https://user:pw@example.org/wfs?key=secret&SERVICE=WFS"


def _no_key(text: str) -> None:
    assert "key=" not in text and "secret" not in text and "pw@" not in text


@pytest.fixture
def wfs() -> Iterator[tuple[Any, Any]]:
    """goatlib's WFS module, imported against a stand-in `osgeo`, and that
    stand-in's `ogr`; GDAL answers with an error that quotes the address, as
    it does. The real modules and the package's attributes are put back
    after, so other tests patch the modules everyone imports."""
    import goatlib.io.remote_source as package

    osgeo = types.ModuleType("osgeo")
    gdal, ogr = MagicMock(), MagicMock()
    osgeo.gdal, osgeo.ogr = gdal, ogr  # type: ignore[attr-defined]
    gdal.GetLastErrorMsg.return_value = (
        f"HTTP error code : 403, url {SERVICE.split('@')[1]} refused"
    )
    names = ("wfs", "wfs_reader")
    saved = {name: getattr(package, name) for name in names if hasattr(package, name)}
    modules = {"osgeo": osgeo, "osgeo.gdal": gdal, "osgeo.ogr": ogr}
    try:
        with patch.dict(sys.modules, modules):
            for name in names:
                sys.modules.pop(f"goatlib.io.remote_source.{name}", None)
            import goatlib.io.remote_source.wfs as module

            with patch.object(module, "assert_public_http_url"):
                yield module, ogr
    finally:
        for name in names:
            if name in saved:
                setattr(package, name, saved[name])
            elif hasattr(package, name):
                delattr(package, name)


def _messages(error: BaseException | None) -> list[str]:
    """The error and every error it was raised from."""
    found = []
    while error is not None:
        found.append(str(error))
        error = error.__cause__ or error.__context__
    return found


def test_a_service_that_cannot_be_opened_is_named_without_its_key(
    wfs: tuple[Any, Any], tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    module, ogr = wfs
    ogr.GetDriverByName.return_value.Open.return_value = None
    with caplog.at_level("DEBUG"), pytest.raises(RuntimeError) as failed:
        module.from_wfs(SERVICE, tmp_path, layer="trees")
    messages = _messages(failed.value)
    assert any("example.org/wfs" in m for m in messages)
    for text in [*messages, caplog.text]:
        _no_key(text)


def test_a_layer_that_cannot_be_read_is_logged_without_the_key(
    wfs: tuple[Any, Any], tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    module, ogr = wfs
    source = MagicMock()
    source.GetLayerCount.return_value = 1
    source.GetLayerByIndex.return_value.GetName.return_value = "trees"
    ogr.GetDriverByName.return_value.Open.return_value = source
    ogr.Open.return_value = None  # the layer's own read fails
    with caplog.at_level("DEBUG"):
        module.from_wfs(SERVICE, tmp_path, layer="trees")
    assert "Opening WFS datasource: WFS:https://example.org/wfs" in caplog.text
    _no_key(caplog.text)


def test_the_datasource_file_is_logged_without_the_key(
    wfs: tuple[Any, Any], caplog: pytest.LogCaptureFixture
) -> None:
    from goatlib.io.remote_source.wfs_reader import WFSReader

    with caplog.at_level("DEBUG"):
        path = WFSReader().build_datasource(SERVICE, "trees")
    # GDAL reads the file with the whole address; the log does not hold it.
    assert "key=secret" in path.read_text()
    assert "example.org/wfs" in caplog.text
    _no_key(caplog.text)
