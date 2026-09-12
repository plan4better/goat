"""What every transit tool shares about an uploaded public-transport bundle.

The field that asks which bundle, the field that asks which date to route on,
and the step that hands the bundle's timetable and linkage to the analysis
params. Each tool used to carry its own copy of all three.
"""

from pathlib import Path
from typing import Any

from pydantic import Field

from goatlib.analysis.schemas.pt_network import PTNetworkOverride
from goatlib.analysis.schemas.ui import ui_field
from goatlib.bundles.artifacts.base import ArtifactSource
from goatlib.bundles.artifacts.gtfs import fetch_pt_linkage, fetch_pt_timetable


def pt_date_field(field_order: int) -> Any:
    """The date to route on, for a bundle whose timetable the weekday anchors
    do not fall inside.

    Replaces the weekday choice, which only means anything for the default
    network, so it is shown exactly when a bundle is chosen. Bounded by the
    window the chosen bundle's timetable was built for: outside it every
    journey comes back "no service".
    """
    return Field(
        default=None,
        description=(
            "Date to route on (YYYY-MM-DD). For an uploaded public-transport "
            "bundle, whose timetable covers the window its feed declares."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=field_order,
            label_key="pt_date",
            widget="date-picker",
            visible_when={
                "$and": [
                    {"routing_mode": "pt"},
                    {"pt_network_bundle_id": {"$exists": True}},
                ]
            },
            widget_options={
                "bounds_from": "pt_network_bundle_id",
                "bounds_artifact": "pt_network_graph",
            },
        ),
    )


def pt_network_bundle_field(field_order: int) -> Any:
    """The PT bundle to route on, for a tool that reads access and egress legs
    out of the bundle's stop-to-street linkage.

    Restricted to bundles whose linkage is built: the timetable alone is not
    enough for such a tool.
    """
    return Field(
        default=None,
        description=(
            "Choose a custom Public Transport bundle to use for routing. "
            "If unset, the default network will be used."
        ),
        json_schema_extra=ui_field(
            section="configuration",
            field_order=field_order,
            label_key="pt_network_bundle_id",
            widget="bundle-selector",
            visible_when={
                "$and": [
                    {"routing_mode": {"$eq": "pt"}},
                    {"show_advanced": True},
                ]
            },
            widget_options={
                "bundle_type": "pt_network_gtfs",
                "artifact_kind": "pt_network_linkage",
            },
        ),
    )


def apply_pt_bundle_override(
    source: ArtifactSource,
    analysis_params: PTNetworkOverride,
    bundle_id: str,
    dest_dir: str | Path,
    *,
    access_mode: str,
    egress_mode: str,
) -> None:
    """Point ``analysis_params`` at the bundle's timetable and linkage tables.

    Both legs read from the bundle's own linkage: mixing one network's
    timetable with another's tables would resolve stop indices to unrelated
    stops. The modes are the analysis layer's spelling ("walking"), which is
    what the tables are named for.
    """
    analysis_params.timetable_path = fetch_pt_timetable(source, bundle_id)
    analysis_params.access_table_path = fetch_pt_linkage(
        source, bundle_id, access_mode, dest_dir
    )
    analysis_params.egress_table_path = (
        analysis_params.access_table_path
        if egress_mode == access_mode
        else fetch_pt_linkage(source, bundle_id, egress_mode, dest_dir)
    )
