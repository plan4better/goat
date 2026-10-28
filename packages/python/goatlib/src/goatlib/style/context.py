"""What validation knows about the data a style draws.

A `DataContext` describes one dataset: its kind, geometry, fields, raster bands or
map service. It is built by whoever can read the data (processes, from DuckLake)
and passed in; `goatlib.style` itself does no IO.
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

FieldType = Literal["string", "number", "integer", "boolean", "date", "datetime"]

#: Constructs a deployment may not render yet (the specification's section 19,
#: "Later"). A deployment passes the subset it supports.
ALL_CAPABILITIES: frozenset[str] = frozenset(
    {"h3", "band_formulas", "raster_service", "service_popups"}
)


@dataclass(frozen=True)
class FieldInfo:
    name: str
    type: FieldType
    values: tuple[Any, ...] | None = None
    min: float | None = None
    max: float | None = None


@dataclass(frozen=True)
class BandInfo:
    index: int
    min: float
    max: float


@dataclass(frozen=True)
class DataContext:
    """One dataset as validation sees it.

    `fields` is None when the fields are unknown (field checks are skipped) and an
    empty mapping when the dataset has none.
    """

    kind: Literal["vector", "raster"]
    geometry: Literal["point", "line", "polygon"] | None = None
    feature_count: int | None = None
    fields: Mapping[str, FieldInfo] | None = None
    source: Literal["file", "wms", "wmts", "xyz"] = "file"
    bands: tuple[BandInfo, ...] = ()
    no_data: float | None = None
    data_type: str | None = None
    color_table: bool = False
    service_styles: tuple[str, ...] = ()
    legend_image: bool = False
    capabilities: frozenset[str] = ALL_CAPABILITIES
    cluster_feature_limit: int = 100_000

    @property
    def is_service(self) -> bool:
        return self.source in ("wms", "wmts", "xyz")

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "DataContext":
        fields = None
        if d.get("fields") is not None:
            fields = {
                f["name"]: FieldInfo(
                    name=f["name"],
                    type=f["type"],
                    values=tuple(f["values"]) if f.get("values") is not None else None,
                    min=f.get("min"),
                    max=f.get("max"),
                )
                for f in d["fields"]
            }
        return cls(
            kind=d["kind"],
            geometry=d.get("geometry"),
            feature_count=d.get("feature_count"),
            fields=fields,
            source=d.get("source", "file"),
            bands=tuple(
                BandInfo(index=b["index"], min=b["min"], max=b["max"])
                for b in d.get("bands", ())
            ),
            no_data=d.get("no_data"),
            data_type=d.get("data_type"),
            color_table=bool(d.get("color_table", False)),
            service_styles=tuple(d.get("service_styles", ())),
            legend_image=bool(d.get("legend_image", False)),
        )


@dataclass(frozen=True)
class MapContext:
    """What a map document is checked against: the project's layers, each with the
    ids of its named styles, and the positions the basemap offers."""

    layers: Mapping[int, frozenset[str]]
    positions: frozenset[str] = field(
        default=frozenset({"top", "below_labels", "below_roads"})
    )
