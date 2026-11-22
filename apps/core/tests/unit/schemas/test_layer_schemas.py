from uuid import uuid4

import pytest
from core.db.models.layer import Layer
from core.schemas.metadata import DatasetProvenance
from pydantic import ValidationError

#: The old catalog's schema, hardcoded onto every layer row and now gone.
RETIRED_COLUMNS = (
    "lineage",
    "positional_accuracy",
    "attribute_accuracy",
    "completeness",
    "geographical_code",
    "language_code",
    "distributor_name",
    "distributor_email",
    "distribution_url",
    "license",
    "attribution",
    "data_reference_year",
    "data_category",
)


def test_a_layer_carries_no_metadata_of_its_own():
    """A user's dataset is its name, description and tags.

    Publishing one to the catalog is a separate job, not a set of columns, and
    a promoted catalog layer keeps the catalog's own record in
    `other_properties.catalog_item` instead.
    """
    columns = {c.name for c in Layer.__table__.columns}
    assert not columns & set(RETIRED_COLUMNS)
    assert "dataset_metadata" not in columns
    for kept in ("name", "description", "tags", "other_properties"):
        assert kept in columns


def test_a_layer_still_builds_without_them():
    layer = Layer(
        folder_id=uuid4(),
        name="Test Layer",
        description="Test Description",
        tags=["Test", "Layer"],
        thumbnail_url="https://example.com/test.png",
    )
    assert layer.name == "Test Layer"
    assert layer.tags == ["Test", "Layer"]


def test_the_generic_column_scheme_is_gone():
    """`attribute_mapping` translated `text_attr1` back to the user's own column
    name, from when layer data lived in shared wide tables. Each layer is now its
    own table carrying the real names, and the field list comes from that schema
    plus `field_config`."""
    columns = {c.name for c in Layer.__table__.columns}
    assert "attribute_mapping" not in columns
    assert "field_config" in columns
    for upload_column in ("upload_reference_system", "upload_file_type"):
        assert upload_column not in columns
    assert "data_store_id" not in columns


def test_tool_provenance_is_kept():
    """Nothing reads either today, but they record which tool and which Windmill
    job produced a layer, on most of the table."""
    columns = {c.name for c in Layer.__table__.columns}
    assert "tool_type" in columns
    assert "job_id" in columns


def test_a_catalog_layer_keeps_the_catalog_record_verbatim():
    """In the catalog's vocabulary, not one of ours: `DL-DE-BY-2.0` is more
    precise than any enum it would be mapped into."""
    layer = Layer(
        folder_id=uuid4(),
        name="Ökologische Mindestwasserführung",
        other_properties={
            "catalog_item": {
                "license": "DL-DE-BY-2.0",
                "publisher": "Landesamt für Umwelt (LfU)",
                "category": "environment",
                "version": "1",
            }
        },
    )
    item = layer.other_properties["catalog_item"]
    assert item["license"] == "DL-DE-BY-2.0"
    assert item["publisher"] == "Landesamt für Umwelt (LfU)"


def test_listings_cannot_filter_on_the_retired_columns():
    """The filter builder resolves params by name (`getattr(Layer, key)`), so a
    param left behind would raise rather than be ignored."""
    from core.schemas.layer import ILayerGet

    assert not set(ILayerGet.model_fields) & set(RETIRED_COLUMNS)


def test_the_old_catalog_api_is_gone():
    import core.schemas.layer as layer_schemas

    for name in ("ICatalogLayerGet", "IMetadataAggregate", "IMetadataAggregateRead"):
        assert not hasattr(layer_schemas, name), name


def test_bundle_provenance_survives_because_an_importer_fills_it():
    """A GTFS feed states its publisher in `feed_info.txt`; a layer states
    nothing about itself."""
    provenance = DatasetProvenance(
        distributor_name="MVG", distributor_email="info@mvg.de"
    )
    assert provenance.distributor_name == "MVG"
    assert "positional_accuracy" not in DatasetProvenance.model_fields

    with pytest.raises(ValidationError):
        DatasetProvenance(distributor_email="not-an-email")


@pytest.mark.parametrize(
    "url",
    [
        "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
        # TMS row order: the browser draws `{-y}` as `2^z - 1 - y`.
        "https://tiles.example.org/{z}/{x}/{-y}.png",
        # A subdomain from a, b and c, or from the list `{switch:...}` names.
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://{switch:a,b,c}.tile.example.org/{z}/{x}/{-y}.png",
    ],
)
def test_an_xyz_layer_keeps_its_tile_address_as_typed(url: str):
    from core.schemas.layer import IRasterCreate, IRasterUpdate

    created = IRasterCreate(
        name="Tiles", folder_id=uuid4(), type="raster", data_type="xyz", url=url
    )
    assert created.url == url
    assert IRasterUpdate(url=url).url == url
    # The row core stores, validated as `crud_layer.create` validates it.
    stored = Layer(**created.model_dump(), user_id=uuid4(), space_id=uuid4())
    assert Layer.model_validate(stored.model_dump()).url == url


@pytest.mark.parametrize(
    "url",
    [
        "not-a-url",
        "ftp://tiles.example.org/{z}/{x}/{y}.png",
        "https://{switch:a,b,c}.tile.example.org:port/{z}/{x}/{y}.png",
        # A subdomain list holds host labels only, each one checked.
        "https://{switch:a,evil.example/x?}.tile.example.org/{z}/{x}/{y}.png",
        "https://{switch:a,b#c}.tile.example.org/{z}/{x}/{y}.png",
        "https://{switch:}.tile.example.org/{z}/{x}/{y}.png",
        "{switch:https,ftp}://tiles.example.org/{z}/{x}/{y}.png",
    ],
)
def test_a_raster_layer_address_is_still_checked(url: str):
    from core.schemas.layer import IRasterCreate

    with pytest.raises(ValidationError):
        IRasterCreate(
            name="Tiles", folder_id=uuid4(), type="raster", data_type="xyz", url=url
        )


def test_an_address_longer_than_a_url_is_refused_before_it_is_copied():
    """A long address with a long subdomain list is refused for its length,
    without an address built per subdomain."""
    import tracemalloc

    from core.schemas.layer import IRasterUpdate

    listed = ",".join(f"a{i}" for i in range(2000))
    url = (
        f"https://{{switch:{listed}}}.example.org/{'p' * 60_000}/{{z}}/{{x}}/{{y}}.png"
    )
    tracemalloc.start()
    try:
        with pytest.raises(ValidationError, match="at most 2083 characters"):
            IRasterUpdate(url=url)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    # A few copies of the address at most, not one per subdomain.
    assert peak < 2 * 1024 * 1024, peak


def test_a_subdomain_list_names_a_few_subdomains_at_most():
    from core.db.models.layer import MAX_TILE_SUBDOMAINS
    from core.schemas.layer import IRasterUpdate

    def address(subdomains: int) -> str:
        listed = ",".join(f"s{i}" for i in range(subdomains))
        return f"https://{{switch:{listed}}}.tile.example.org/{{z}}/{{x}}/{{y}}.png"

    most = address(MAX_TILE_SUBDOMAINS)
    assert IRasterUpdate(url=most).url == most
    with pytest.raises(ValidationError, match="at most 16 subdomains"):
        IRasterUpdate(url=address(MAX_TILE_SUBDOMAINS + 1))


@pytest.mark.parametrize(
    "url",
    [
        123,
        1.5,
        True,
        ["https://a.example/{z}/{x}/{y}.png"],
        {"a": 1},
        b"https://a.example/x",
    ],
)
def test_an_address_that_is_no_text_is_a_validation_error(url: object):
    from core.schemas.layer import IRasterCreate, IRasterUpdate

    with pytest.raises(ValidationError):
        IRasterUpdate(url=url)
    with pytest.raises(ValidationError):
        IRasterCreate(
            name="Tiles", folder_id=uuid4(), type="raster", data_type="xyz", url=url
        )


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.5:8080\\@tiles.example.org/x.tif",
        "https://tiles.example.org/{z}/{x}/{y}.png\\@other.example",
        "https://tiles.example.org/a b/{z}/{x}/{y}.png",
        "https://tiles.example.org/a\tb/{z}/{x}/{y}.png",
        "https://tiles.example.org/a\x00b/{z}/{x}/{y}.png",
        "https://{s}.tiles.example.org\\@other.example/{z}/{x}/{y}.png",
    ],
)
def test_an_address_every_parser_does_not_read_alike_is_refused(url: str):
    """An address with a backslash, whitespace or a control character inside
    it is never stored: the server's HTTP client and its URL parser could read
    another host from it."""
    from core.schemas.layer import IRasterCreate, IRasterUpdate

    with pytest.raises(ValidationError):
        IRasterUpdate(url=url)
    for data_type in ("cog", "xyz"):
        with pytest.raises(ValidationError):
            IRasterCreate(
                name="Tiles",
                folder_id=uuid4(),
                type="raster",
                data_type=data_type,
                url=url,
            )


@pytest.mark.parametrize(
    "url",
    [
        "https://user:password@data.example.org:8443/dem.tif?sig=a%20b",
        "http://[2001:db8::1]:8080/dem.tif",
        "https://data.example.org/wms?SERVICE=WMS&BBOX={bbox-epsg-3857}",
    ],
)
def test_ordinary_raster_addresses_are_kept_as_typed(url: str):
    from core.schemas.layer import IRasterUpdate

    assert IRasterUpdate(url=url).url == url
