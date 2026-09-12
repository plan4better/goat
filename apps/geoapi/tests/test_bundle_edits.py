"""The bundle batch-edit endpoint.

Two concerns: what the endpoint refuses before touching anything, and the
id/attribute handling that decides whether a save actually lands.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

import duckdb
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

LAYER = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
CALLER = "744e4fd1-685c-495c-8b02-efebce875359"
BUNDLE = "22222222-2222-2222-2222-222222222222"
EDITS_URL = f"/collections/{LAYER}/edits"


@pytest.fixture
def client(mock_ducklake_manager):
    from geoapi.dependencies import LayerInfo, get_layer_info
    from geoapi.deps.auth import get_user_id
    from geoapi.main import app

    # Resolving a LayerInfo would hit the DuckLake catalog for the layer's
    # schema. The endpoint's own logic is what these tests are about.
    app.dependency_overrides[get_layer_info] = lambda: LayerInfo(
        layer_id=LAYER, schema_name="user_data", table_name="layer_test"
    )
    # The route requires a caller. Overriding the dependency pins one whatever
    # `AUTH` is set to, rather than leaning on the AUTH=False mock identity.
    app.dependency_overrides[get_user_id] = lambda: UUID(CALLER)
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _allow_edit():
    # authorize_edit returns the edges layer's metadata; the owner check
    # compares its user_id against the nodes layer's and the bundle's.
    with patch(
        "geoapi.routers.bundle_edits.authorize_edit",
        AsyncMock(return_value=SimpleNamespace(user_id="owner-a")),
    ):
        yield


def _edges_field_config():
    """The edges layer's field_config as the import writes it.

    Built from the spec so the two cannot drift: the endpoint reads the layer's
    copy, which is what a real bundle carries.
    """
    from goatlib.models.bundle import BundleTypeName, get_spec

    role = get_spec(BundleTypeName.street_network).role("edges")
    config: dict = {}
    for column, values in role.allowed_values.items():
        config.setdefault(column, {})["allowed_values"] = list(values)
        config[column]["allow_other"] = False
    for column, value in role.default_values.items():
        config.setdefault(column, {})["default_value"] = value
    return config


def _member(role="edges", user_id="owner-a"):
    return {
        "bundle_id": BUNDLE,
        "bundle_type": "street_network",
        "role": role,
        "user_id": user_id,
    }


def _payload(base_revision=0, properties=None, **overrides):
    payload = {
        "base_revision": base_revision,
        "create": [
            {
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[11.0, 48.0], [11.001, 48.0]],
                },
                "properties": (
                    {"class": "residential"} if properties is None else properties
                ),
            }
        ],
        "update": [],
        "delete": [],
    }
    payload.update(overrides)
    return payload


def _post(
    client,
    payload,
    member=None,
    revision=0,
    nodes_owner="owner-a",
    apply_raises=None,
    mocks: dict | None = None,
    field_config=None,
):
    """Post a batch with the surrounding lookups stubbed.

    The claim stub keeps the real compare-and-swap semantics: it 409s when the
    client's base is not the current revision, and returns the bumped value.
    """

    async def _claim(bundle_id, base_revision):
        if base_revision != revision:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"This network changed while you were editing (revision "
                    f"{revision}, you started from {base_revision}). "
                    "Reload before saving."
                ),
            )
        return revision + 1

    release_mock = AsyncMock(return_value=None)
    dispatch_mock = AsyncMock(return_value="job-1")
    if mocks is not None:
        mocks["release"] = release_mock
        mocks["dispatch"] = dispatch_mock

    with (
        patch(
            "geoapi.routers.bundle_edits.resolve_bundle_member",
            AsyncMock(return_value=_member() if member is None else member),
        ),
        patch(
            "geoapi.routers.bundle_edits.claim_bundle_revision",
            AsyncMock(side_effect=_claim),
        ),
        patch("geoapi.routers.bundle_edits.release_bundle_revision", release_mock),
        patch("geoapi.routers.bundle_edits.dispatch_rebuild", dispatch_mock),
        patch(
            "geoapi.routers.bundle_edits.member_layer_of_role",
            AsyncMock(return_value={"layer_id": LAYER, "user_id": nodes_owner}),
        ),
        patch("geoapi.routers.bundle_edits.get_layer_info_sync"),
        patch(
            "geoapi.routers.bundle_edits._load_field_config",
            AsyncMock(
                return_value=(
                    _edges_field_config() if field_config is None else field_config
                )
            ),
        ),
        patch(
            "geoapi.routers.bundle_edits._invalidate_caches_and_pmtiles",
            AsyncMock(return_value=None),
        ),
        patch("geoapi.routers.bundle_edits._apply") as apply_mock,
    ):
        from geoapi.routers.bundle_edits import EdgeChanges, NodeChanges

        if apply_raises is not None:
            apply_mock.side_effect = apply_raises
        else:
            apply_mock.return_value = (EdgeChanges(), NodeChanges())
        return client.post(EDITS_URL, json=payload)


# --- what the endpoint refuses ---------------------------------------------


@pytest.mark.parametrize(
    ("case", "member", "revision", "status", "fragment"),
    [
        ("role is not editable", _member("nodes"), 0, 400, "editable"),
        # The client started from 0 while the network has moved on to 9.
        ("stale base revision", _member(), 9, 409, "9"),
    ],
)
def test_refusals(client, case, member, revision, status, fragment):
    response = _post(client, _payload(), member=member, revision=revision)
    assert response.status_code == status
    assert fragment in str(response.json()["detail"])


def test_a_layer_outside_any_bundle_is_refused(client):
    with patch(
        "geoapi.routers.bundle_edits.resolve_bundle_member",
        AsyncMock(return_value=None),
    ):
        response = client.post(EDITS_URL, json=_payload())
    assert response.status_code == 400
    assert "bundle" in response.json()["detail"].lower()


def test_an_empty_batch_and_an_unknown_class_are_both_refused(client):
    empty = _post(
        client, {"base_revision": 0, "create": [], "update": [], "delete": []}
    )
    assert empty.status_code == 400
    assert "no edits" in empty.json()["detail"].lower()

    # A typo would otherwise be mapped to a drivable road by the build.
    bogus = _post(client, _payload(properties={"class": "banna"}))
    assert bogus.status_code == 400
    assert "banna" in bogus.json()["detail"]


def test_mismatched_member_owners_are_refused(client):
    """A bundle whose members have different owners is not safe to write."""
    response = _post(client, _payload(), nodes_owner="owner-b")
    assert response.status_code == 403
    assert "owner" in response.json()["detail"].lower()


def test_authorization_runs_before_anything_else(client):
    """A refused edit never reaches the bundle lookup."""
    member_lookup = AsyncMock(return_value=_member())
    with (
        patch(
            "geoapi.routers.bundle_edits.authorize_edit",
            AsyncMock(side_effect=HTTPException(status_code=403, detail="nope")),
        ),
        patch("geoapi.routers.bundle_edits.resolve_bundle_member", member_lookup),
    ):
        response = client.post(EDITS_URL, json=_payload())
    assert response.status_code == 403
    member_lookup.assert_not_called()


def test_a_degenerate_edge_is_a_bad_request_not_a_server_error(client):
    from goatlib.bundles.topology import DegenerateEdgeError

    mocks: dict = {}
    response = _post(
        client,
        _payload(),
        apply_raises=DegenerateEdgeError("same node"),
        mocks=mocks,
    )
    assert response.status_code == 400
    assert "same node" in response.json()["detail"]
    # Handing the claimed revision back is the whole repair: the artifacts are
    # current again at the revision they were built from, so no rebuild runs.
    mocks["release"].assert_awaited_once()
    mocks["dispatch"].assert_not_awaited()


def test_a_vertex_with_no_usable_position_is_refused():
    """A NaN ordinate is a valid double all the way down — DuckDB stores it,
    every length derived from it is NaN, and the network it lands in only fails
    much later, on every route, naming nothing. So it is refused at the door."""
    import math

    from geoapi.routers.bundle_edits import _plan

    geometry = {
        "type": "LineString",
        "coordinates": [[math.nan, math.nan], [-122.7052, 45.5136]],
    }
    with pytest.raises(ValueError, match="no usable position"):
        _plan(None, geometry)


def test_a_coordinate_that_is_not_finite_is_never_written():
    """The node writer interpolates coordinates as SQL literals, where `nan`
    parses as a double rather than failing."""
    from geoapi.services.bundle_edit_service import insert_node

    with pytest.raises(ValueError, match="not a finite number"):
        insert_node(None, "t", ["id", "geometry"], "n1", float("nan"), 0.0)


def test_a_successful_save_reports_the_queued_rebuild(client):
    """The rebuild is the server's job now; the client only tracks it."""
    mocks: dict = {}
    response = _post(client, _payload(), mocks=mocks)
    assert response.status_code == 200
    assert response.json()["rebuild_job_id"] == "job-1"
    mocks["release"].assert_not_awaited()


def test_an_edge_with_no_class_is_accepted(client):
    """Classifying a street is a judgement the user can make later."""
    assert _post(client, _payload(properties={})).status_code == 200


# --- attribute defaults ----------------------------------------------------


def test_class_and_speed_defaults():
    """An unclassified edge must still be routable, and a footway must not be
    drivable: the build coalesces a null speed to 0, which the engine reads as
    impassable."""
    from goatlib.models.bundle import CLASS_DEFAULT_MAXSPEED

    from geoapi.routers.bundle_edits import _fill_class_defaults

    # The default travels on the layer's field_config, the same place the
    # editor read it from to preselect it.
    config = _edges_field_config()
    edge_class = config["class"]["default_value"]
    assert edge_class in config["class"]["allowed_values"]

    filled = _fill_class_defaults({}, config)
    assert filled["class"] == edge_class
    assert filled["speed_limit_kph_forward"] == CLASS_DEFAULT_MAXSPEED[edge_class]

    # A cleared class falls back to the default rather than saving as blank —
    # the editor sends "" and the web nulls it, so both spellings count as
    # blank on a write that replaces the row whole.
    assert _fill_class_defaults({"class": ""}, config)["class"] == edge_class
    assert _fill_class_defaults({"class": None}, config)["class"] == edge_class

    # A stated class wins, and its speeds follow from it rather than the default.
    stated = _fill_class_defaults({"class": "footway"}, config)
    assert stated["class"] == "footway"
    assert "speed_limit_kph_forward" not in stated


def test_a_cleared_class_is_defaulted_not_refused(client):
    """The editor sends "" for a field the user emptied, and the type's default
    is what an unclassified edge is meant to get — so the value has to be
    validated as it will be written, after the default is filled in."""
    response = _post(client, _payload(properties={"class": ""}))
    assert response.status_code == 200, response.json()


def test_a_layer_with_no_field_config_keeps_the_bundle_type_contract(client):
    """field_config only exists on layers the current importer wrote (and only
    where a PG pool is configured). The type's own vocabulary is the floor, or a
    pre-existing network would accept a typo that the artifact build maps to a
    drivable road."""
    bogus = _post(client, _payload(properties={"class": "motorwayy"}), field_config={})
    assert bogus.status_code == 400
    assert "motorwayy" in bogus.json()["detail"]
    # And a real class still saves.
    assert (
        _post(
            client, _payload(properties={"class": "residential"}), field_config={}
        ).status_code
        == 200
    )


def test_the_type_supplies_the_class_default_when_the_layer_does_not():
    """An edge drawn without a class on such a layer must not be written with
    class NULL and NULL speeds: the build coalesces those to speed 0, which the
    engine reads as impassable for cars."""
    from goatlib.models.bundle import (
        CLASS_DEFAULT_MAXSPEED,
        BundleTypeName,
        get_spec,
    )

    from geoapi.routers.bundle_edits import _fill_class_defaults, _with_role_contract

    role = get_spec(BundleTypeName.street_network).role("edges")
    floor = _with_role_contract({}, role)
    filled = _fill_class_defaults({}, floor)
    assert filled["class"] == role.default_values["class"]
    assert filled["speed_limit_kph_forward"] == CLASS_DEFAULT_MAXSPEED[filled["class"]]

    # The layer's own config wins where it has one, key by key: a narrowed
    # vocabulary is a user's decision, and the floor only fills the silence.
    narrowed = _with_role_contract({"class": {"allowed_values": ["residential"]}}, role)
    assert narrowed["class"]["allowed_values"] == ["residential"]
    assert narrowed["class"]["default_value"] == role.default_values["class"]


def test_a_three_dimensional_edge_is_refused(client):
    """A Z ordinate passes _validate_line and then dies mid-transaction with
    "Inconsistent coordinate dimensionality", because the resolved vertices come
    back as 2-tuples: refuse it up front instead."""
    payload = _payload()
    payload["create"][0]["geometry"]["coordinates"] = [
        [11.0, 48.0, 515.0],
        [11.001, 48.0, 517.0],
    ]
    response = _post(client, payload)
    assert response.status_code == 400
    assert "2D" in response.json()["detail"]


# --- topology within one batch ---------------------------------------------


def test_a_second_split_lands_on_a_half_not_on_a_free_floating_node():
    """Two endpoints crossing the same street in one batch.

    The first crossing splits the street; the second must split the surviving
    half. Unless the halves are fed back as candidates, the second endpoint
    falls through to MintNode and writes a free-floating node on a half's
    interior — a non-intersection the routing graph publishes silently.
    """
    from goatlib.bundles.topology import EdgeCandidate, NodeCandidate
    from shapely.geometry import LineString

    from geoapi.routers.bundle_edits import EdgeChanges, NodeChanges, _Batch, _plan

    # ~111 m of street along the equator, where degrees ≈ metres / 111320 and
    # the 3857 projection is the identity scale.
    street = EdgeCandidate(
        edge_id="street",
        source_node="n-west",
        target_node="n-east",
        geometry=LineString([(0.0, 0.0), (111.32, 0.0)]),
    )
    batch = _Batch(
        con=None,
        edges_table="edges",
        nodes_table="nodes",
        edge_columns=[],
        node_columns=[],
        candidate_nodes=[
            NodeCandidate(node_id="n-west", x=0.0, y=0.0),
            NodeCandidate(node_id="n-east", x=111.32, y=0.0),
        ],
        candidate_edges=[street],
        references={"n-west": {"street"}, "n-east": {"street"}},
        tolerance=1.0,
        field_config=None,
        edges=EdgeChanges(),
        nodes=NodeChanges(),
    )

    splits: list[str] = []

    def record_split(con, table, columns, edge_id, fraction, left, right, node, fc):
        splits.append(edge_id)

    with (
        patch("geoapi.services.bundle_edit_service.insert_node_on_edge"),
        patch(
            "geoapi.services.bundle_edit_service.split_edge", side_effect=record_split
        ),
        patch("geoapi.services.bundle_edit_service.insert_node"),
        # The node row is not written here, so its position is stubbed; the
        # candidate coordinate the next crossing measures against is derived
        # from the split edge itself, not from this.
        patch(
            "geoapi.services.bundle_edit_service.node_position",
            return_value=(0.0, 0.0),
        ),
    ):
        for crossing_lon in (0.0003, 0.0007):
            _plan(
                batch,
                {
                    "type": "LineString",
                    "coordinates": [[crossing_lon, 0.0], [crossing_lon, 0.0005]],
                },
            )

    assert splits[0] == "street"
    assert len(splits) == 2
    assert batch.edges.split[1].original_id in batch.edges.split[0].halves


# --- feature ids and no-op writes ------------------------------------------


@pytest.fixture
def edges_table():
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute(
        "CREATE TABLE edges (id VARCHAR, geometry GEOMETRY, "
        "source_node VARCHAR, target_node VARCHAR)"
    )
    con.execute(
        "INSERT INTO edges VALUES ('edge-a', NULL, NULL, NULL), "
        "('edge-b', NULL, NULL, NULL), ('edge-c', NULL, NULL, NULL)"
    )
    yield con
    con.close()


def test_feature_ids_resolve_through_the_rowid_plus_one_convention(edges_table):
    """A tile feature id is rowid + 1; treating it as a rowid targets the wrong row.

    Getting this wrong made an edit to an existing edge a silent no-op: the
    UPDATE matched nothing and the client still reported success, so the edge
    appeared to revert on the next tile refresh.
    """
    from geoapi.services.bundle_edit_service import resolve_feature_ids

    assert resolve_feature_ids(edges_table, "edges", ["1", "3"]) == {
        "1": "edge-a",
        "3": "edge-c",
    }
    # Past the end of the table, and an id this session minted: neither resolves,
    # and the caller must treat that as an error rather than guess.
    assert resolve_feature_ids(edges_table, "edges", ["99", "edit:abc"]) == {}


def test_fetch_candidates_filters_on_the_stored_geometry():
    """The bbox filter runs against the stored 4326 geometry (with axis-column
    pruning), and only the matching rows come back — projected to metres."""
    from geoapi.services.bundle_edit_service import fetch_candidates

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial")
    con.execute(
        "CREATE TABLE nodes AS SELECT * FROM (VALUES "
        "('n-near', ST_Point(0.0005, 0.0), 0.0005, 0.0, 0.0005, 0.0), "
        "('n-far', ST_Point(0.5, 0.0), 0.5, 0.0, 0.5, 0.0)"
        ') t("id", geometry, xmin, ymin, xmax, ymax)'
    )
    con.execute(
        "CREATE TABLE edges AS SELECT * FROM (VALUES "
        "('e-near', 'n-a', 'n-b', "
        "ST_GeomFromText('LINESTRING (0 0, 0.001 0)'), 0.0, 0.0, 0.001, 0.0), "
        "('e-far', 'n-c', 'n-d', "
        "ST_GeomFromText('LINESTRING (0.5 0, 0.501 0)'), 0.5, 0.0, 0.501, 0.0)"
        ') t("id", source_node, target_node, geometry, xmin, ymin, xmax, ymax)'
    )

    columns = ["id", "geometry", "xmin", "ymin", "xmax", "ymax"]
    nodes, edges = fetch_candidates(
        con,
        "edges",
        "nodes",
        (-0.0001, -0.0001, 0.002, 0.0001),
        exclude_edge_ids=set(),
        edge_columns=columns,
        node_columns=columns,
    )
    assert [n.node_id for n in nodes] == ["n-near"]
    # Returned in metres: 0.0005° along the equator is ~55.66 m in 3857.
    assert nodes[0].x == pytest.approx(55.66, abs=0.1)
    assert [e.edge_id for e in edges] == ["e-near"]

    _, excluded = fetch_candidates(
        con,
        "edges",
        "nodes",
        (-0.0001, -0.0001, 0.002, 0.0001),
        exclude_edge_ids={"e-near"},
        edge_columns=columns,
        node_columns=columns,
    )
    assert excluded == []
    con.close()


def test_writes_that_match_nothing_raise(edges_table):
    """A save that changes nothing must not look like a successful one."""
    from geoapi.services.bundle_edit_service import delete_edges_by_id, update_edge

    with pytest.raises(ValueError, match="no longer in the layer"):
        update_edge(
            edges_table,
            "edges",
            ["id", "geometry", "source_node", "target_node"],
            "ghost-edge",
            {"type": "LineString", "coordinates": [[11.0, 48.0], [11.001, 48.0]]},
            {},
            "n1",
            "n2",
        )

    with pytest.raises(ValueError, match="no longer in the layer"):
        delete_edges_by_id(edges_table, "edges", ["edge-a", "ghost"])
    # The batch is refused whole: the edge that does exist is untouched.
    assert edges_table.execute("SELECT count(*) FROM edges").fetchone()[0] == 3
