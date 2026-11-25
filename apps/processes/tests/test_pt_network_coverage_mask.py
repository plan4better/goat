"""The default PT network's coverage mask, served for the dialog that cuts the network.

The mask lies at the root of the base data version holding the timetable;
the timetable path, as sync_base_data installs it, is a link into that version.
"""

import json
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from goatlib.config.settings import settings as goatlib_settings

from processes.deps.auth import get_user_id
from processes.main import app

USER = UUID("00000000-0000-0000-0000-000000000001")
MASK = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"kind": "mask"},
            "geometry": {"type": "Polygon", "coordinates": []},
        }
    ],
}


def _installed_version(data_dir: Path, *, with_mask: bool) -> Path:
    """A public_transport version under .base/, linked as sync_base_data links it;
    returns the timetable path the tools read (through the link)."""
    version = data_dir / ".base" / "public_transport" / "2026-11-18-europe"
    (version / "pt_network").mkdir(parents=True)
    (version / "pt_network" / "gtfs.bin").write_bytes(b"nigiri")
    if with_mask:
        (version / "pt_geofence_mask.geojson").write_text(json.dumps(MASK))
    (data_dir / "pt_network").symlink_to(
        Path(".base/public_transport/2026-11-18-europe/pt_network")
    )
    return data_dir / "pt_network" / "gtfs.bin"


@pytest.fixture
def client():
    app.dependency_overrides[get_user_id] = lambda: USER
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_user_id, None)


def test_the_mask_of_the_installed_version_is_served(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, client: TestClient
) -> None:
    timetable = _installed_version(tmp_path, with_mask=True)
    monkeypatch.setattr(
        goatlib_settings.routing, "pt_network_base_path", str(timetable)
    )
    response = client.get("/pt-network/coverage-mask")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/geo+json")
    assert response.json() == MASK


def test_a_version_without_a_mask_answers_null(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, client: TestClient
) -> None:
    timetable = _installed_version(tmp_path, with_mask=False)
    monkeypatch.setattr(
        goatlib_settings.routing, "pt_network_base_path", str(timetable)
    )
    response = client.get("/pt-network/coverage-mask")
    assert response.status_code == 200
    assert response.json() is None


def test_a_server_without_a_network_answers_null(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, client: TestClient
) -> None:
    # Nothing installed where the timetable is expected: not a server error.
    monkeypatch.setattr(
        goatlib_settings.routing,
        "pt_network_base_path",
        str(tmp_path / "pt_network" / "gtfs.bin"),
    )
    response = client.get("/pt-network/coverage-mask")
    assert response.status_code == 200
    assert response.json() is None
