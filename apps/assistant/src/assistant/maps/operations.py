"""What ``map_update`` takes: a closed list of operations on the map.

An operation changes one thing: a layer's state on the map or its name, its
filter, the place of a layer or group in the tree, a group, the basemap, the
3D scene or the view. The model writes them in the order they are applied.
Layers are named by their number in the project, groups by their id; a group
that an earlier operation of the same call adds has no id yet and is named by
that operation's index (``new_group_index``).
"""

import re
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    WithJsonSchema,
    field_validator,
    model_validator,
)

from assistant.maps.filter_rows import RowOp
from assistant.tools.filters import _decoded

MAX_OPERATIONS = 30
#: Row operations one ``filter`` operation takes.
MAX_ROW_OPERATIONS = 20
#: Scene operations one ``set_scene`` operation takes.
MAX_SCENE_OPERATIONS = 20
#: Core's limit for the name of a group, and of a table or raster layer.
MAX_NAME = 255

_NEW_GROUP = re.compile(r"new:(\d{1,2})")
NOT_A_STYLE_ID = (
    "active_style_id is a style's id from project_get_layers (style.id, or an "
    "id of style.others)."
)

Position = Literal["top", "below_labels", "below_roads"]
LayerNumber = Annotated[int, Field(ge=1)]
#: A group's id, or ``new:<index>`` for a group this call adds.
GroupRef = (
    Annotated[int, Field(ge=1)] | Annotated[str, Field(pattern=r"^new:[0-9]{1,2}$")]
)
Name = Annotated[str, Field(min_length=1, max_length=MAX_NAME)]

_LAYER = (
    "The layer's ID within the open project (layer_project_id from project_get_layers)."
)
_GROUP = (
    "The group's id (groups[].id from project_get_layers). A group that an "
    'add_group operation earlier in this call adds is named "new:<index>", '
    'with that operation\'s index in operations, counting from 0: "new:0" is '
    "the group the first operation adds."
)


def new_group_index(ref: int | str) -> int | None:
    """The index of the ``add_group`` operation a reference names; None for
    the id of a group that exists."""
    if isinstance(ref, int):
        return None
    found = _NEW_GROUP.fullmatch(ref)
    return int(found.group(1)) if found else None


class _Operation(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def _given(operation: BaseModel, names: tuple[str, ...]) -> list[str]:
    return [name for name in names if getattr(operation, name) is not None]


class SetLayer(_Operation):
    op: Literal["set_layer"] = Field(
        description=(
            "Change a layer's state on the map (shown or hidden, position, "
            "drawn style, legend) or its name."
        )
    )
    layer_project_id: LayerNumber = Field(description=_LAYER)
    visible: bool | None = Field(
        default=None,
        description=(
            "false hides the layer, true shows it. A layer is drawn only when "
            "it and its group are shown."
        ),
    )
    position: Position | None = Field(
        default=None,
        description=(
            "Where the layer is drawn against the basemap: top (above "
            "everything of the basemap), below_labels (under the basemap's "
            "labels) or below_roads (under its roads and labels)."
        ),
    )
    active_style_id: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "Make another of the layer's named styles the one the map draws: "
            "style.id, or an id of style.others, from project_get_layers."
        ),
    )
    legend_expanded: bool | None = Field(
        default=None,
        description="Whether the layer's legend is open in the layer list.",
    )
    name: Name | None = Field(
        default=None,
        description=(
            "The layer's new name in this project, in the user's language. "
            "Example: Districts 2024."
        ),
    )

    @field_validator("active_style_id")
    @classmethod
    def _canonical_style_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            return str(UUID(value))
        except ValueError:
            raise ValueError(NOT_A_STYLE_ID) from None

    @model_validator(mode="after")
    def _changes_something(self) -> "SetLayer":
        if not self.fields():
            raise ValueError(
                "set_layer takes at least one of visible, position, "
                "active_style_id, legend_expanded and name."
            )
        return self

    def state_fields(self) -> list[str]:
        """The fields of the layer's map state this operation sets."""
        return _given(
            self, ("visible", "position", "active_style_id", "legend_expanded")
        )

    def fields(self) -> list[str]:
        return _given(
            self, ("visible", "position", "active_style_id", "legend_expanded", "name")
        )


class FilterLayer(_Operation):
    op: Literal["filter"] = Field(
        description=(
            "Change a layer's saved filter row by row, and its area: set_area "
            "keeps only what lies inside (or outside) regions by id from "
            "catalog_find_region, features of another polygon layer or the "
            "current map view; clear_area removes it."
        )
    )
    layer_project_id: LayerNumber = Field(description=_LAYER)
    rows: list[RowOp] = Field(
        min_length=1,
        max_length=MAX_ROW_OPERATIONS,
        description=(
            f"1 to {MAX_ROW_OPERATIONS} row operations, applied in order. Row "
            "numbers are the ones project_get_layers shows in the layer's "
            "filter."
        ),
    )


class ItemRef(_Operation):
    type: Literal["layer", "group"] = Field(
        description="Whether the item is a layer or a group."
    )
    id: GroupRef = Field(
        description=(
            "A layer's layer_project_id, or a group's id (a group this call "
            'adds: "new:<index>", as for group_id).'
        )
    )

    @model_validator(mode="after")
    def _a_layer_has_a_number(self) -> "ItemRef":
        if self.type == "layer" and not isinstance(self.id, int):
            raise ValueError("A layer is named by its layer_project_id, a number.")
        return self


class Move(_Operation):
    op: Literal["move"] = Field(
        description=(
            "Put a layer or a group at another place in the layer list: into "
            "a group or to the top level, first there or after another item. "
            "The list's order is the drawing order, the first item on top."
        )
    )
    item: ItemRef = Field(description="The layer or group to move.")
    group_id: GroupRef | None = Field(
        default=None,
        description=(
            "The group the item goes into; leave it out or null for the top "
            f"level. {_GROUP}"
        ),
    )
    after: ItemRef | None = Field(
        default=None,
        description=(
            "The item in the same group (or at the top level) that the moved "
            "item follows; leave it out or null to put it first."
        ),
    )


class AddGroup(_Operation):
    op: Literal["add_group"] = Field(
        description=(
            "Add an empty group to the layer list. Its id comes back in the "
            "result (applied[].group_id); later operations of this call name "
            'it "new:<index>".'
        )
    )
    name: Name = Field(
        description="The group's name, in the user's language. Example: Transport."
    )
    parent_group_id: GroupRef | None = Field(
        default=None,
        description=(
            "A top-level group to put the new group into; leave it out for "
            f"the top level. Groups nest two deep at most. {_GROUP}"
        ),
    )


class RenameGroup(_Operation):
    op: Literal["rename_group"] = Field(description="Give a group another name.")
    group_id: GroupRef = Field(description=_GROUP)
    name: Name = Field(description="The group's new name, in the user's language.")


class SetGroup(_Operation):
    op: Literal["set_group"] = Field(
        description="Show or hide a group with everything in it, or open or close it."
    )
    group_id: GroupRef = Field(description=_GROUP)
    visible: bool | None = Field(
        default=None,
        description=(
            "false hides every layer of the group, whatever each layer's own "
            "state; true shows the ones that are not hidden themselves."
        ),
    )
    expanded: bool | None = Field(
        default=None,
        description="Whether the group is open in the layer list.",
    )

    @model_validator(mode="after")
    def _changes_something(self) -> "SetGroup":
        if not self.fields():
            raise ValueError("set_group takes at least one of visible and expanded.")
        return self

    def fields(self) -> list[str]:
        return _given(self, ("visible", "expanded"))


class RemoveGroup(_Operation):
    op: Literal["remove_group"] = Field(
        description=(
            "Remove a group that is empty. A group with layers or groups in "
            "it is refused: move them out first."
        )
    )
    group_id: GroupRef = Field(description=_GROUP)


class RemoveLayer(_Operation):
    op: Literal["remove_layer"] = Field(
        description=(
            "Remove a layer from the project, with its styles and its filter. "
            "Needs the user's pick in a card: without it nothing of the call "
            "is applied and the result's confirm says what to ask. To take a "
            "layer out of sight, hide it with set_layer."
        )
    )
    layer_project_id: LayerNumber = Field(description=_LAYER)


class SetBasemap(_Operation):
    op: Literal["set_basemap"] = Field(description="Switch the project's basemap.")
    basemap_id: str = Field(
        min_length=1,
        max_length=64,
        description=(
            "The id of one of the project's basemaps (map.basemaps[].id from "
            "project_get_layers). Example: dark."
        ),
    )


class SetView(_Operation):
    op: Literal["set_view"] = Field(
        description=(
            "Move the map's camera, or switch between 2D and 3D or the "
            "projection, on this user's page. Give camera parts (center, "
            "zoom, pitch, bearing) or fit_layer_project_id, and with either "
            "of them mode and projection as needed. Several set_view "
            "operations of one call make one view: a later one overrides the "
            "same field of an earlier one, and a fit and camera parts take "
            "each other's place. Nothing is saved to the project."
        )
    )
    center: list[float] | None = Field(
        default=None,
        min_length=2,
        max_length=2,
        description="[longitude, latitude] in WGS84. Example: [11.57, 48.14].",
    )
    zoom: float | None = Field(
        default=None, ge=0, le=24, description="Zoom level, 0 (the world) to 24."
    )
    pitch: float | None = Field(
        default=None,
        ge=0,
        le=85,
        description="Tilt in degrees, 0 (straight down) to 85.",
    )
    bearing: float | None = Field(
        default=None,
        ge=-360,
        le=360,
        description="Rotation in degrees clockwise from north.",
    )
    mode: Literal["2d", "3d"] | None = Field(
        default=None,
        description=(
            "2d is the flat map seen from above; 3d tilts it and draws "
            "heights (terrain, buildings, extruded layers)."
        ),
    )
    projection: Literal["mercator", "globe"] | None = Field(
        default=None, description="The flat map (mercator) or the globe."
    )
    fit_layer_project_id: LayerNumber | None = Field(
        default=None,
        description=(
            "Fit the view to this layer's features, as its saved filter keeps "
            "them (GOAT computes the extent): the layer_project_id of a layer "
            "of the open project with geometry, not a table or a raster. "
            "The fit decides the camera: mode and projection may come with "
            "it, center, zoom, pitch and bearing may not."
        ),
    )

    @model_validator(mode="after")
    def _camera_or_fit(self) -> "SetView":
        if self.fit_layer_project_id is not None:
            camera = self.camera_parts()
            if camera:
                raise ValueError(
                    "fit_layer_project_id decides the camera: leave out "
                    f"{', '.join(camera)}. mode and projection may come with it."
                )
            return self
        if not self.parts():
            raise ValueError(
                "set_view takes at least one of center, zoom, pitch, bearing, "
                "mode, projection and fit_layer_project_id."
            )
        if self.center is not None:
            longitude, latitude = self.center
            if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                raise ValueError("center is [longitude, latitude] in WGS84.")
        return self

    def camera_parts(self) -> list[str]:
        """The camera parts this operation gives."""
        return _given(self, ("center", "zoom", "pitch", "bearing"))

    def parts(self) -> list[str]:
        """The camera parts, mode and projection this operation gives."""
        return _given(
            self, ("center", "zoom", "pitch", "bearing", "mode", "projection")
        )


class SceneEdit(_Operation):
    op: Literal["set", "remove"] = Field(
        description=(
            "set: write a value, creating missing objects on the way. remove: "
            "delete a key, which then takes its automatic value again."
        )
    )
    path: str = Field(
        max_length=200,
        description=(
            "JSON pointer into the scene as project_get_layers shows it "
            "(map.scene); its sections are terrain, buildings, sky, fog, glow "
            "and light. Examples: /terrain/exaggeration, /buildings, "
            "/sky/color."
        ),
    )
    value: Annotated[
        Any,
        WithJsonSchema(
            {
                "anyOf": [
                    {"type": "string"},
                    {"type": "number"},
                    {"type": "boolean"},
                    {"type": "object"},
                    {"type": "array"},
                    {"type": "null"},
                ],
                "description": "set only: the new value, any JSON. Example: 1.5.",
                "default": None,
            }
        ),
    ] = None

    @model_validator(mode="after")
    def _value_goes_with_set(self) -> "SceneEdit":
        if self.op == "set" and "value" not in self.model_fields_set:
            raise ValueError("set needs value; use remove to delete the key.")
        if self.op == "remove" and self.value is not None:
            raise ValueError("remove takes no value; it reads path.")
        return self


class SetScene(_Operation):
    op: Literal["set_scene"] = Field(
        description=(
            "Change the project's 3D scene (terrain, buildings, sky, fog, "
            "glow, light), or put it back to automatic. Give automatic or "
            "operations, not both."
        )
    )
    automatic: bool | None = Field(
        default=None,
        description=(
            "true removes every scene setting: the scene then follows the basemap."
        ),
    )
    operations: list[SceneEdit] | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_SCENE_OPERATIONS,
        description=(
            f"1 to {MAX_SCENE_OPERATIONS} changes to the stored scene, applied "
            "in order, all or none; an automatic scene starts empty. The "
            "server checks the result."
        ),
    )

    @model_validator(mode="after")
    def _one_way(self) -> "SetScene":
        if (self.automatic is True) == (self.operations is not None):
            raise ValueError(
                "set_scene takes either automatic: true or operations, and not both."
            )
        return self


MapOp = Annotated[
    SetLayer
    | FilterLayer
    | Move
    | AddGroup
    | RenameGroup
    | SetGroup
    | RemoveGroup
    | RemoveLayer
    | SetBasemap
    | SetView
    | SetScene,
    Field(discriminator="op"),
]


class MapUpdateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operations: list[MapOp] = Field(
        min_length=1,
        max_length=MAX_OPERATIONS,
        description=(
            f"1 to {MAX_OPERATIONS} operations, applied in order; each has op "
            "and the fields of that op. A later operation sees what an "
            "earlier one did. Indexes count from 0: the result's "
            "applied[].index and failed.index, a refusal's operations[<index>] "
            'and "new:<index>" for a group this call adds all name an '
            "operation by its place in this list."
        ),
    )

    @field_validator("operations", mode="before")
    @classmethod
    def _decode(cls, value: Any) -> Any:
        """The list, or an operation, sent as JSON text is read as the object."""
        value = _decoded(value)
        if isinstance(value, list):
            return [_decoded(item) for item in value]
        return value
