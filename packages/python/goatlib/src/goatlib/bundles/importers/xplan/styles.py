"""How each XPlan class is drawn: the colours and line types of the PlanZV
(Planzeichenverordnung), the symbols a printed German plan uses.

The PlanZV annex (https://www.gesetze-im-internet.de/planzv_90/anlage.html)
names a colour per item, not a colour code ("Rot mittel", "Goldocker"); the
values here are GOAT's reading of those names.

GOAT Style documents keyed by class (a role `<Class>:<geometry>` uses its class's
entry). Building areas are coloured by their decoded use
(`artDerBaulNutzungWert`), the way a plan colours residential areas
red, mixed ones brown, commercial ones grey.
"""

from typing import Any

from goatlib.style.ids import assign_ids
from goatlib.tools.style import styled

BUILDING_LIMIT_BLUE = "#1f4fd1"
#: PlanZV 6.1 Straßenverkehrsflächen: Goldocker.
ROAD_OCHRE = "#e3b448"
GREEN = "#8cc63f"
#: PlanZV 13 (nature, planting): Grün dunkel.
FOREST_GREEN = "#3f8f3f"
#: PlanZV 12.2 Flächen für Wald: Blaugrün.
FOREST_BLUE_GREEN = "#2e8b7a"
WATER_BLUE = "#7fb8e6"
#: PlanZV 10.2 Wasserwirtschaft: Blau dunkel.
WATER_BLUE_DARK = "#1f5fa8"
#: PlanZV 4.1 Flächen für den Gemeinbedarf: Karminrot mittel.
PUBLIC_USE_CARMINE = "#c8325a"
#: PlanZV 15.11 and 15.13: Grau dunkel.
BOUNDARY_GREY = "#333333"
RED = "#d7191c"
#: PlanZV 5.2.1 Bahnanlagen: Violett mittel; 5.4 Luftverkehr: Violett dunkel.
VIOLET = "#9b59b6"
VIOLET_DARK = "#6a3d9a"
#: PlanZV 7 Versorgungsflächen and 15.1: Gelb hell.
YELLOW_LIGHT = "#f2e14c"
#: PlanZV 12.1 Flächen für die Landwirtschaft: Gelbgrün.
YELLOW_GREEN = "#c5d94a"

#: Colour of each kind of building area, by its decoded name: PlanZV 1.1
#: Wohnbauflächen Rot mittel, 1.2 gemischte Bauflächen Braun mittel, 1.3
#: gewerbliche Bauflächen Grau mittel, 1.4 Sonderbauflächen Orange mittel.
LAND_USE_COLORS: dict[str, str] = {
    "Kleinsiedlungsgebiet": "#f08080",
    "Reines Wohngebiet": "#e05050",
    "Allg Wohngebiet": "#e86f5f",
    "Besonderes Wohngebiet": "#d9573f",
    "Dorfgebiet": "#c99a6b",
    # A mixed area in the PlanZV (1.2.2, Braun mittel), not a residential one.
    "Doerfliches Wohngebiet": "#c99a6b",
    "Mischgebiet": "#b48250",
    "Urbanes Gebiet": "#a0703c",
    "Kerngebiet": "#8c5a32",
    "Gewerbegebiet": "#a6a6a6",
    "Industriegebiet": "#7f7f7f",
    "Sondergebiet Erholung": "#f5a623",
    "Sondergebiet Sonst": "#f5a623",
    "Wochenendhausgebiet": "#f5a623",
    "Sondergebiet": "#f5a623",
    "Sonstiges Gebiet": "#cccccc",
    # The general use, for plans that state only it, in its family's colour.
    "Wohn Bauflaeche": "#e86f5f",
    "Gemischte Bauflaeche": "#b48250",
    "Gewerbliche Bauflaeche": "#a6a6a6",
    "Sonder Bauflaeche": "#f5a623",
    "Sonstige Bauflaeche": "#cccccc",
}

#: A class without a look of its own: drawn, but never over the rest of the plan.
UNSTYLED_GREY = "#8c8c8c"


def _fill(color: str) -> tuple[str, dict[str, Any]]:
    return "polygon", {"fill": {"color": color, "opacity": 0.7}, "outline": False}


def _outline(color: str, dash: str = "solid") -> tuple[str, dict[str, Any]]:
    return "polygon", {
        "fill": False,
        "outline": {"color": color, "width": 2, "dash": dash},
    }


def _line(color: str, dash: str = "solid") -> tuple[str, dict[str, Any]]:
    return "line", {"line": {"color": color, "width": 2, "dash": dash}}


#: Building areas: one fill class per kind of use.
_LAND_USE = (
    "polygon",
    {
        # An area without a known kind of use (a municipality's own code)
        # belongs to no class below: the grey of an unstyled class.
        "fill": {"color": UNSTYLED_GREY, "opacity": 0.7},
        "outline": False,
        # The plan's zoning label, built at import (`beschriftung`).
        "label": {
            "text": "{beschriftung}",
            "placement": "inside",
            "size": 11,
            "color": "#222222",
            "halo": {"color": "#ffffff", "width": 1},
        },
    },
    {
        "field": "artDerBaulNutzungWert",
        "method": "categories",
        # Kinds sharing a colour (the special areas) are one class.
        "classes": [
            {
                "values": [n for n, c in LAND_USE_COLORS.items() if c == color],
                "fill": {"color": color},
            }
            for color in dict.fromkeys(LAND_USE_COLORS.values())
        ],
    },
)

#: Class to (the geometry its look is for, the symbol parts[, the classification]).
XPLAN_CLASS_STYLES: dict[str, tuple] = {
    "BP_Plan": _outline(BOUNDARY_GREY, "dashed"),
    "FP_Plan": _outline(BOUNDARY_GREY, "dashed"),
    "BP_Bereich": _outline(BOUNDARY_GREY, "dotted"),
    "FP_Bereich": _outline(BOUNDARY_GREY, "dotted"),
    "BP_BaugebietsTeilFlaeche": _LAND_USE,
    "FP_BebauungsFlaeche": _LAND_USE,
    "BP_UeberbaubareGrundstuecksFlaeche": _outline(BUILDING_LIMIT_BLUE),
    "BP_BauGrenze": _line(BUILDING_LIMIT_BLUE, "dashed"),
    "BP_BauLinie": _line(RED),
    "BP_NutzungsartenGrenze": _line(BOUNDARY_GREY, "dotted"),
    "BP_StrassenbegrenzungsLinie": _line("#2e8b57"),
    "BP_StrassenVerkehrsFlaeche": _fill(ROAD_OCHRE),
    "FP_Strassenverkehr": _fill(ROAD_OCHRE),
    # From XPlanGML 6 roads, water and water management are shared classes.
    "SO_Strassenverkehr": _fill(ROAD_OCHRE),
    "SO_Gewaesser": _fill(WATER_BLUE),
    "SO_Wasserwirtschaft": _outline(WATER_BLUE_DARK),
    "BP_VerkehrsflaecheBesondererZweckbestimmung": _fill("#efd48c"),
    "BP_GruenFlaeche": _fill(GREEN),
    "FP_Gruen": _fill(GREEN),
    "BP_WaldFlaeche": _fill(FOREST_BLUE_GREEN),
    "FP_WaldFlaeche": _fill(FOREST_BLUE_GREEN),
    "BP_GewaesserFlaeche": _fill(WATER_BLUE),
    "BP_WasserwirtschaftsFlaeche": _outline(WATER_BLUE_DARK),
    "FP_Wasserwirtschaft": _outline(WATER_BLUE_DARK),
    "FP_Gewaesser": _fill(WATER_BLUE),
    "BP_GemeinbedarfsFlaeche": _fill(PUBLIC_USE_CARMINE),
    "FP_Gemeinbedarf": _fill(PUBLIC_USE_CARMINE),
    "BP_KennzeichnungsFlaeche": _outline(BOUNDARY_GREY),
    "FP_Kennzeichnung": _outline(BOUNDARY_GREY),
    "BP_AnpflanzungBindungErhaltung": _outline(FOREST_GREEN),
    "SO_Schienenverkehrsrecht": _fill(VIOLET),
    "SO_Luftverkehrsrecht": _outline(VIOLET_DARK),
    "BP_VerEntsorgung": _fill(YELLOW_LIGHT),
    "FP_VerEntsorgung": _fill(YELLOW_LIGHT),
    "BP_LandwirtschaftsFlaeche": _fill(YELLOW_GREEN),
    "FP_LandwirtschaftsFlaeche": _fill(YELLOW_GREEN),
    # PlanZV 13.1 and 13.3: Grün dunkel.
    "BP_SchutzPflegeEntwicklungsFlaeche": _outline(FOREST_GREEN),
    "FP_SchutzPflegeEntwicklung": _outline(FOREST_GREEN),
    "SO_SchutzgebietNaturschutzrecht": _outline(FOREST_GREEN),
    # PlanZV 14.1, 14.2 and 15.3: Rot.
    "BP_ErhaltungsBereichFlaeche": _outline(RED),
    "SO_Denkmalschutzrecht": _outline(RED),
    "BP_NebenanlagenFlaeche": _outline(RED),
    "BP_GemeinschaftsanlagenFlaeche": _outline(RED),
    "FP_KeineZentrAbwasserBeseitigungFlaeche": _outline(YELLOW_LIGHT),
}


def _unstyled(geometry: str | None, seed: str | None) -> dict[str, Any] | None:
    """A thin grey outline, line or dot: a random colour, which is what any
    other upload gets, would cover the plan's other layers."""
    parts = {
        "polygon": {"fill": False, "outline": {"color": UNSTYLED_GREY, "width": 1}},
        "line": {"line": {"color": UNSTYLED_GREY, "width": 1}},
        "point": {"marker": {"color": UNSTYLED_GREY, "size": 5}},
    }.get(geometry or "")
    return assign_ids(styled(geometry, parts, seed=seed)) if parts else None


def xplan_role_style(
    role: str, geometry: str | None, *, seed: str | None = None
) -> dict[str, Any] | None:
    """The style of a member layer of this role: its class's PlanZV look for the
    layer's geometry, else the grey of a class without one."""
    entry = XPLAN_CLASS_STYLES.get(role.split(":", 1)[0])
    if entry is None or entry[0] != geometry:
        return _unstyled(geometry, seed)
    doc = styled(geometry, entry[1], seed=seed)
    if len(entry) > 2:
        doc["classify"] = [entry[2]]
    return assign_ids(doc)
