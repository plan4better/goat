"""The layers the workflow chains run on.

They are the assistant eval's workflow project (`WORKFLOW_LAYERS` in the
assistant's evals/backends.py): the same layer ids, project entry ids, names
and fields, so a workflow the assistant builds for that project runs here as
it is. The features are a fixed grid in Leipzig, inside the area the eval's
own features are spread over: twelve schools and twelve supermarkets in four
columns by three rows, a population grid of eight by six cells offset from
the district borders, and four districts that split the area into quarters.
"""

from dataclasses import dataclass

from goatlib.utils.layer import layer_schema_name

SCHULEN = 31
SCHULEN_2019 = 32
EINWOHNER = 33
SUPERMAERKTE = 34
STADTBEZIRKE = 35

_GEOMETRY = "::GEOMETRY('OGC:CRS84')"


def _schools(count: int) -> str:
    return f"""
        SELECT
            'Schule ' || (i + 1) AS name,
            CASE WHEN i < 6 THEN 'Grundschule' WHEN i < 9 THEN 'Gymnasium'
                 ELSE 'Oberschule' END AS schulart,
            ST_Point(12.335 + (i % 4) * 0.025, 51.315 + (i // 4) * 0.02){_GEOMETRY}
                AS geometry
        FROM range({count}) t(i)
    """


@dataclass(frozen=True)
class WorldLayer:
    #: The project entry id (layer_project_id) the eval's drafts name.
    link_id: int
    name: str
    #: point or polygon, as the layer record stores it.
    geometry: str
    #: The DuckDB query its rows come from.
    select: str

    @property
    def layer_id(self) -> str:
        return f"e2000000-0000-0000-0000-{self.link_id:012d}"

    @property
    def table(self) -> str:
        return f"lake.{layer_schema_name()}.t_{self.layer_id.replace('-', '')}"


WORLD: dict[int, WorldLayer] = {
    SCHULEN: WorldLayer(SCHULEN, "Schulen", "point", _schools(12)),
    SCHULEN_2019: WorldLayer(
        SCHULEN_2019, "Schulen (Stand 2019)", "point", _schools(9)
    ),
    EINWOHNER: WorldLayer(
        EINWOHNER,
        "Einwohner Raster",
        "polygon",
        f"""
        SELECT
            (50 + (x * 37 + y * 101) % 850)::INTEGER AS einwohner,
            ST_MakeEnvelope(
                12.3275 + x * 0.0125, 51.3075 + y * 0.01,
                12.34 + x * 0.0125, 51.3175 + y * 0.01
            ){_GEOMETRY} AS geometry
        FROM range(8) a(x), range(6) b(y)
        """,
    ),
    SUPERMAERKTE: WorldLayer(
        SUPERMAERKTE,
        "Supermärkte",
        "point",
        f"""
        SELECT
            'Markt ' || (i + 1) AS name,
            ['Edeka', 'Rewe', 'Lidl', 'Aldi'][i % 4 + 1] AS kette,
            ST_Point(12.3475 + (i % 4) * 0.025, 51.325 + (i // 4) * 0.02){_GEOMETRY}
                AS geometry
        FROM range(12) t(i)
        """,
    ),
    STADTBEZIRKE: WorldLayer(
        STADTBEZIRKE,
        "Stadtbezirke",
        "polygon",
        f"""
        SELECT
            ['Mitte', 'Nordost', 'Ost', 'Südost'][x * 2 + y + 1] AS name,
            ST_MakeEnvelope(
                12.33 + x * 0.05, 51.31 + y * 0.03, 12.38 + x * 0.05, 51.34 + y * 0.03
            ){_GEOMETRY} AS geometry
        FROM range(2) a(x), range(2) b(y)
        """,
    ),
}
