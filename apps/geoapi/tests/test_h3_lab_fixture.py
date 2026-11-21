"""The style lab's stored H3 tiles against geoapi's H3 tiles today.

The web app's style lab draws H3 layers from tiles stored in
apps/web/lib/style/__tests__/lab/fixtures/h3, made with geoapi's own H3 code by
the lab's make_tiles.py; its tests hold the compiler's reading of geoapi's tile
schema (the layer name and the properties) against them. This test makes one
of those tiles again with geoapi's code as it is now and compares what the
tiles hold: a change to geoapi's H3 output fails here until the fixtures are
made again and the lab has run over them.
"""

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from typing import Any, Iterator

import pytest

ROOT = Path(__file__).resolve().parents[3]
LAB_H3 = ROOT / "apps/web/lib/style/__tests__/lab/fixtures/h3"
MAKE_TILES = LAB_H3 / "make_tiles.py"
RERUN = f"geoapi's H3 tiles changed: rerun {MAKE_TILES.relative_to(ROOT)}"


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        if byte < 0x80:
            return result, i
        shift += 7


def _fields(buf: bytes) -> Iterator[tuple[int, int, Any]]:
    """The fields of a protobuf message: number, wire type and raw value."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 1:
            value, i = buf[i : i + 8], i + 8
        elif wire == 2:
            size, i = _varint(buf, i)
            value, i = buf[i : i + size], i + size
        elif wire == 5:
            value, i = buf[i : i + 4], i + 4
        else:
            raise ValueError(f"protobuf wire type {wire} is not used by vector tiles")
        yield number, wire, value


def _packed(buf: bytes) -> list[int]:
    out, i = [], 0
    while i < len(buf):
        value, i = _varint(buf, i)
        out.append(value)
    return out


def _value(buf: bytes) -> Any:
    """A vector tile value: string, float, double, int, uint, sint or bool."""
    import struct

    for number, _, raw in _fields(buf):
        if number == 1:
            return raw.decode()
        if number == 2:
            return struct.unpack("<f", raw)[0]
        if number == 3:
            return struct.unpack("<d", raw)[0]
        if number in (4, 5):
            return raw - (1 << 64) if number == 4 and raw >= 1 << 63 else raw
        if number == 6:
            return (raw >> 1) ^ -(raw & 1)
        if number == 7:
            return bool(raw)
    return None


def decode(tile: bytes) -> dict[str, list[tuple[int, dict[str, Any]]]]:
    """Each layer of a Mapbox vector tile: its features' geometry type and
    properties."""
    layers: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for number, _, layer in _fields(tile):
        if number != 3:
            continue
        name, keys, values, features = "", [], [], []
        for field, _, raw in _fields(layer):
            if field == 1:
                name = raw.decode()
            elif field == 2:
                features.append(raw)
            elif field == 3:
                keys.append(raw.decode())
            elif field == 4:
                values.append(_value(raw))
        decoded = []
        for feature in features:
            kind, tags = 0, []
            for field, _, raw in _fields(feature):
                if field == 2:
                    tags = _packed(raw)
                elif field == 3:
                    kind = raw
            properties = {keys[k]: values[v] for k, v in zip(tags[::2], tags[1::2])}
            decoded.append((kind, properties))
        layers[name] = decoded
    return layers


def comparable(layers: dict[str, list[tuple[int, dict[str, Any]]]]) -> dict[str, list]:
    """The layers' features in one order, by their properties."""
    return {
        name: sorted(
            ([kind, sorted(properties.items())] for kind, properties in features),
            key=repr,
        )
        for name, features in layers.items()
    }


@pytest.fixture(scope="module")
def make_tiles() -> ModuleType:
    """The lab's make_tiles.py. geoapi's settings are built first as the tests
    build them; the sign-in switch the script sets for itself is put back."""
    import geoapi.services.tile_service  # noqa: F401

    before = os.environ.get("AUTH")
    spec = importlib.util.spec_from_file_location("lab_make_tiles", MAKE_TILES)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        if before is None:
            os.environ.pop("AUTH", None)
        else:
            os.environ["AUTH"] = before
    return module


@pytest.mark.parametrize(
    ("request_key", "op", "field"),
    [("h3-auto-count", "count", None), ("h3-auto-mean-pop", "mean", "pop")],
)
def test_stored_lab_tile_holds_what_geoapi_makes_today(
    make_tiles: ModuleType, request_key: str, op: str, field: str | None
) -> None:
    z, x, y = make_tiles.ZOOM, 2047, 2047
    stored = (LAB_H3 / request_key / str(z) / str(x) / f"{y}.pbf").read_bytes()
    con = make_tiles.connect()
    make_tiles.make_points(con)
    made = make_tiles.hexagon_tile(con, z, x, y, op, field)
    assert made, RERUN
    stored_layers, made_layers = decode(stored), decode(made)
    # The schema the web compiler reads: the layer and its property names.
    assert list(made_layers) == ["h3"], RERUN
    assert {key for _, p in made_layers["h3"] for key in p} >= {
        "value",
        "resolution",
    }, RERUN
    assert comparable(made_layers) == comparable(stored_layers), RERUN
