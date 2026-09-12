"""Pointing the engine at an uploaded public-transport bundle.

An uploaded PT bundle replaces the global network with its own timetable and
its own stop-to-street linkage. The three paths belong together: ``stop_idx``
in an access/egress table indexes into the timetable it was built against, so
a table from one network read against another's timetable resolves to the
wrong stops rather than to nothing. Mixed into every analysis params model
that routes on transit, so the rule is stated once.
"""

from typing import Self

from pydantic import BaseModel, Field, model_validator


class PTNetworkOverride(BaseModel):
    """The override's three paths, or none of them. None uses the default."""

    timetable_path: str | None = Field(
        default=None,
        description="Path to a nigiri timetable .bin to use for PT routing",
    )
    access_table_path: str | None = Field(
        default=None,
        description="Path to the access-mode access/egress parquet",
    )
    egress_table_path: str | None = Field(
        default=None,
        description="Path to the egress-mode access/egress parquet",
    )

    @model_validator(mode="after")
    def validate_pt_network_override(self: Self) -> Self:
        # A timetable without its tables would fall back to the global tables,
        # whose stop indices belong to a different network — the lookups would
        # land on unrelated stops instead of failing.
        supplied = [
            bool(self.timetable_path),
            bool(self.access_table_path),
            bool(self.egress_table_path),
        ]
        if any(supplied) and not all(supplied):
            raise ValueError(
                "timetable_path, access_table_path and egress_table_path must "
                "be set together — an access/egress table's stop indices are "
                "only meaningful against the timetable it was built from"
            )
        return self
