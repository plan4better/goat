"""Editability and artifact status as the API reports them.

Resolved from the live spec at request time. There is nowhere else to resolve
them from: the reference table that once held a copy of each type's structure is
gone, precisely because the copy drifted.
"""

import pytest
from core.endpoints.v2.bundle import role_is_editable
from core.schemas.bundle import (
    BundleArtifactSummary,
    BundleByLayerResponse,
    BundleMemberResponse,
    BundleRead,
)
from goatlib.models.bundle import BundleTypeName

LAYER = "3fa85f64-5717-4562-b3fc-2c963f66afa6"


@pytest.mark.parametrize(
    ("role", "expected"),
    [("edges", True), ("nodes", False), (None, False), ("made_up", False)],
)
def test_role_editability_comes_from_the_spec(role, expected):
    assert role_is_editable(BundleTypeName.street_network, role) is expected


def test_editability_defaults_to_closed_on_the_wire():
    """A client that gets no flag must not assume it may edit."""
    assert BundleMemberResponse(layer_id=LAYER, role="nodes").editable is False
    assert (
        BundleByLayerResponse(
            bundle_id=LAYER, bundle_type="street_network", role="edges", editable=True
        ).editable
        is True
    )


def test_artifacts_are_reported_individually():
    """Not collapsed to one status: a GTFS bundle has two artifacts, and "one of
    them failed" is not useful without saying which. The storage path stays
    internal."""
    summary = BundleArtifactSummary(
        kind="street_network_graph",
        build_status="complete",
        state="outdated",
        revision=7,
    )
    assert (summary.kind, summary.state, summary.revision) == (
        "street_network_graph",
        "outdated",
        7,
    )
    assert "storage_path" not in BundleArtifactSummary.model_fields
    # A bundle with nothing built reports an empty list, not a null status.
    assert BundleRead.model_fields["artifacts"].default_factory() == []


@pytest.mark.parametrize(
    ("build_status", "revision", "layers_revision", "storage_path", "expected"),
    [
        ("complete", 4, 4, "p.tar", "ready"),
        ("complete", 3, 4, "p.tar", "outdated"),
        # Provenance missing, so nothing says which layers it came from.
        ("complete", None, 0, "p.tar", "outdated"),
        # A finished build with nothing to point at is not routable.
        ("complete", 4, 4, None, "failed"),
        ("building", 3, 4, None, "building"),
        ("failed", 4, 4, "p.tar", "failed"),
        # A value from a newer release.
        ("something_else", 4, 4, "p.tar", "failed"),
    ],
)
def test_artifact_state_is_derived_not_stored(
    build_status, revision, layers_revision, storage_path, expected
):
    """One definition, shared by the read DTO and by the consumer that decides
    whether a tool may route on the artifact, so the two cannot disagree."""
    from goatlib.models.bundle import artifact_state

    assert (
        artifact_state(build_status, revision, layers_revision, storage_path).value
        == expected
    )


def test_a_dependency_that_moved_on_makes_an_artifact_outdated() -> None:
    """The same answer the bundle's own revision gives, across the dependency
    edge: a linkage built from a street network that has since been edited
    describes a network that no longer exists."""
    from goatlib.models.bundle import artifact_state

    current = artifact_state("complete", 4, 4, "p.tar", True)
    stale = artifact_state("complete", 4, 4, "p.tar", False)
    assert (current.value, stale.value) == ("ready", "outdated")

    # Nothing else changes meaning: a failed build stays failed, and a build
    # still running stays building, whatever the dependencies are doing.
    assert artifact_state("failed", 4, 4, "p.tar", False).value == "failed"
    assert artifact_state("building", 4, 4, None, False).value == "building"


@pytest.mark.parametrize(
    ("bundle_type", "from_layers"),
    [
        (BundleTypeName.street_network, True),
        # The timetable is built from the uploaded feed, which is not kept.
        (BundleTypeName.pt_network_gtfs, False),
    ],
)
def test_filter_and_rebuild_follow_one_rule(bundle_type, from_layers) -> None:
    """Filtering and rebuilding both need artifacts built from the layers.

    Two tools refuse on it, the builder exposes it, and the API reports it to
    gate the UI — so the point is that all of them read the one spec rather
    than each deciding for itself.
    """
    from goatlib.bundles.artifacts import get_artifact_builder
    from goatlib.models.bundle import artifacts_from_layers

    assert artifacts_from_layers(bundle_type) is from_layers
    assert get_artifact_builder(bundle_type).builds_from_layers is from_layers

    reported = BundleRead(
        id=LAYER,
        user_id=LAYER,
        folder_id=LAYER,
        name="b",
        bundle_type=bundle_type.value,
        status="ready",
        artifacts_from_layers=artifacts_from_layers(bundle_type),
    )
    assert reported.artifacts_from_layers is from_layers


@pytest.mark.parametrize(
    ("bundle_type", "role"),
    [
        # The edges are the network; the nodes are only where they meet.
        (BundleTypeName.street_network, "edges"),
        # Stops show where a feed serves; shapes are a tangle at this size.
        (BundleTypeName.pt_network_gtfs, "stops"),
    ],
)
def test_each_type_names_the_member_that_stands_for_it(bundle_type, role) -> None:
    """A bundle has no geometry of its own, so its thumbnail is a member's.

    Named on the spec rather than guessed from the roles: "the first one with
    geometry" would give a GTFS feed its shapes, and adding a role later would
    silently change what every existing bundle looks like.
    """
    from goatlib.models.bundle import get_spec

    spec = get_spec(bundle_type)
    assert spec.thumbnail_role == role
    # And it has to be a role the type actually has, or nothing resolves.
    assert spec.role(spec.thumbnail_role) is not None
