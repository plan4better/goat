from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import pytest
from core.schemas.custom_basemap import CustomBasemap
from pydantic import TypeAdapter, ValidationError

CUSTOM_BASEMAP_ADAPTER = TypeAdapter(CustomBasemap)


def _base_fields() -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "name": "My basemap",
        "description": None,
        "thumbnail_url": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def test_vector_custom_basemap_valid():
    data = {**_base_fields(), "type": "vector", "url": "https://example.com/style.json"}
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.type == "vector"
    assert str(parsed.url) == "https://example.com/style.json"


def test_vector_custom_basemap_rejects_invalid_url():
    data = {**_base_fields(), "type": "vector", "url": "not-a-url"}
    with pytest.raises(ValidationError):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_raster_custom_basemap_requires_xyz_placeholders():
    data = {
        **_base_fields(),
        "type": "raster",
        "url": "https://example.com/{z}/{x}/{y}.png",
        "attribution": "© Example",
    }
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.type == "raster"
    assert parsed.attribution == "© Example"


@pytest.mark.parametrize(
    "url",
    [
        "https://tiles.example.org/{z}/{x}/{-y}.png",
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://{switch:a,b}.tiles.example.org/{z}/{x}/{-y}.png",
    ],
)
def test_raster_custom_basemap_accepts_tms_rows_and_subdomains(url: str) -> None:
    data = {**_base_fields(), "type": "raster", "url": url}
    assert CUSTOM_BASEMAP_ADAPTER.validate_python(data).url == url


@pytest.mark.parametrize(
    "url",
    [
        "https://{switch:a,evil.example/x?}.tiles.example.org/{z}/{x}/{y}.png",
        "https://{switch:}.tiles.example.org/{z}/{x}/{y}.png",
        "https://tiles.example.org:port/{z}/{x}/{y}.png",
    ],
)
def test_raster_custom_basemap_checks_every_address(url: str) -> None:
    data = {**_base_fields(), "type": "raster", "url": url}
    with pytest.raises(ValidationError):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_raster_custom_basemap_rejects_missing_placeholder():
    data = {
        **_base_fields(),
        "type": "raster",
        "url": "https://example.com/{z}/{x}.png",
    }
    with pytest.raises(ValidationError, match="placeholders"):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_raster_custom_basemap_rejects_missing_scheme() -> None:
    data = {
        **_base_fields(),
        "type": "raster",
        "url": "{z}/{x}/{y}.png",
    }
    with pytest.raises(ValidationError, match="http"):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_solid_custom_basemap_valid():
    data = {**_base_fields(), "type": "solid", "color": "#ff8800"}
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.type == "solid"
    assert parsed.color == "#ff8800"


def test_solid_custom_basemap_rejects_invalid_color():
    data = {**_base_fields(), "type": "solid", "color": "orange"}
    with pytest.raises(ValidationError):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_solid_custom_basemap_accepts_alpha_color():
    data = {**_base_fields(), "type": "solid", "color": "#ff8800cc"}
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.color == "#ff8800cc"


def test_solid_custom_basemap_accepts_uppercase_hex() -> None:
    data = {**_base_fields(), "type": "solid", "color": "#FF8800"}
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.color == "#FF8800"


def test_solid_custom_basemap_rejects_short_hex() -> None:
    data = {**_base_fields(), "type": "solid", "color": "#FFF"}
    with pytest.raises(ValidationError):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_unknown_type_rejected():
    data = {**_base_fields(), "type": "wmts", "url": "https://example.com"}
    with pytest.raises(ValidationError, match="discriminator|tag"):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_id_is_stored_as_string_for_jsonb_compat() -> None:
    """Regression: id must remain a str (not UUID instance) for JSONB serialization."""
    data = {**_base_fields(), "type": "vector", "url": "https://example.com/style.json"}
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert isinstance(parsed.id, str)


def test_invalid_uuid_string_rejected() -> None:
    """A non-UUID id should be rejected by the UUIDStr validator."""
    data = {
        **_base_fields(),
        "id": "not-a-uuid",
        "type": "vector",
        "url": "https://example.com/style.json",
    }
    with pytest.raises(ValidationError):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_timestamps_are_stored_as_strings_for_jsonb_compat() -> None:
    """Regression: created_at/updated_at must remain strs for JSONB serialization."""
    data = {**_base_fields(), "type": "vector", "url": "https://example.com/style.json"}
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert isinstance(parsed.created_at, str)
    assert isinstance(parsed.updated_at, str)


def test_invalid_iso_datetime_rejected() -> None:
    data = {
        **_base_fields(),
        "created_at": "yesterday",
        "type": "vector",
        "url": "https://example.com/style.json",
    }
    with pytest.raises(ValidationError, match="ISO 8601"):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_iso_datetime_with_z_suffix_accepted() -> None:
    """Pydantic v2 commonly serializes datetimes with Z suffix; that must validate."""
    data = {
        **_base_fields(),
        "created_at": "2026-04-30T12:34:56.789Z",
        "type": "vector",
        "url": "https://example.com/style.json",
    }
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.created_at == "2026-04-30T12:34:56.789Z"


def test_vector_url_is_stored_as_string_for_jsonb_compat() -> None:
    """Regression: vector url must remain a str (not HttpUrl) for JSONB serialization."""
    data = {**_base_fields(), "type": "vector", "url": "https://example.com/style.json"}
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert isinstance(parsed.url, str)
    # And not any kind of pydantic url:
    assert type(parsed.url) is str


def test_vector_url_rejects_non_http_scheme() -> None:
    data = {**_base_fields(), "type": "vector", "url": "ftp://example.com/style.json"}
    with pytest.raises(ValidationError, match="http"):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_vector_custom_basemap_accepts_attribution() -> None:
    data = {
        **_base_fields(),
        "type": "vector",
        "url": "https://example.com/style.json",
        "attribution": "© Example Provider",
    }
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.type == "vector"
    assert parsed.attribution == "© Example Provider"


def test_solid_custom_basemap_accepts_attribution() -> None:
    data = {
        **_base_fields(),
        "type": "solid",
        "color": "#ff8800",
        "attribution": "© Example",
    }
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.attribution == "© Example"


def test_attribution_too_long_rejected() -> None:
    data = {
        **_base_fields(),
        "type": "vector",
        "url": "https://example.com/style.json",
        "attribution": "x" * 501,
    }
    with pytest.raises(ValidationError):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)


def test_vector_custom_basemap_accepts_layer_config():
    data = {
        **_base_fields(),
        "type": "vector",
        "url": "https://example.com/style.json",
        "layer_config": {
            "road_label": {"visible": True, "relation": "above", "target": "12"},
            "water": {"visible": False, "relation": "below", "target": "all"},
        },
    }
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    assert parsed.type == "vector"
    assert parsed.layer_config["road_label"].relation == "above"
    assert parsed.layer_config["road_label"].target == "12"
    assert parsed.layer_config["water"].visible is False


def test_vector_layer_config_applies_defaults():
    data = {
        **_base_fields(),
        "type": "vector",
        "url": "https://example.com/style.json",
        "layer_config": {"road_label": {}},
    }
    parsed = CUSTOM_BASEMAP_ADAPTER.validate_python(data)
    setting = parsed.layer_config["road_label"]
    assert setting.visible is True
    assert setting.relation == "below"
    assert setting.target == "all"


def test_vector_layer_config_rejects_invalid_relation():
    data = {
        **_base_fields(),
        "type": "vector",
        "url": "https://example.com/style.json",
        "layer_config": {"road_label": {"relation": "sideways"}},
    }
    with pytest.raises(ValidationError):
        CUSTOM_BASEMAP_ADAPTER.validate_python(data)
