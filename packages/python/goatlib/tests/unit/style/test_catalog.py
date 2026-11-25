import re

from goatlib.style.catalog import icon_names, palette_colors, palettes

RASTER_RAMPS = [
    "d3:cividis",
    "d3:inferno",
    "d3:plasma",
    "goat:terrain",
    "goat:hypsometric",
    "goat:ndvi",
]

SPEC_PALETTES = [
    "d3:viridis",
    "d3:magma",
    "colorbrewer:OrRd",
    "colorbrewer:YlGnBu",
    "colorbrewer:Purples",
    "colorbrewer:RdBu",
    "colorbrewer:Set2",
    "carto:Bold",
    "goat:green",
    "goat:elevation",
]


def test_the_spec_palettes_exist_with_hex_colors() -> None:
    cat = palettes()
    for pid in SPEC_PALETTES:
        assert pid in cat
    assert all(
        re.fullmatch(r"#[0-9a-f]{6}", c, re.I) for p in cat.values() for c in p.colors
    )


def test_the_raster_ramps_carry_their_published_colors() -> None:
    cat = palettes()
    # matplotlib's perceptual maps, seven even samples as viridis and magma.
    assert cat["d3:cividis"].colors == (
        "#00224e",
        "#2a3f6d",
        "#575d6d",
        "#7d7c78",
        "#a59c74",
        "#d2c060",
        "#fee838",
    )
    assert cat["d3:inferno"].colors[0] == "#000004"
    assert cat["d3:inferno"].colors[-1] == "#fcffa4"
    assert cat["d3:plasma"].colors[0] == "#0d0887"
    assert cat["d3:plasma"].colors[-1] == "#f0f921"
    # matplotlib's terrain, sea blue to snow; Wikipedia's hypsometric tints (GMT),
    # lowland green to summit white; Earth Engine's NDVI, bare soil to dense green.
    assert cat["goat:terrain"].colors[0] == "#333399"
    assert cat["goat:terrain"].colors[-1] == "#ffffff"
    assert cat["goat:hypsometric"].colors[0] == "#acd0a5"
    assert cat["goat:hypsometric"].colors[-1] == "#f5f4f2"
    assert cat["goat:ndvi"].colors[0] == "#ce7e45"
    assert all(cat[p].kind == "sequential" for p in RASTER_RAMPS)
    # One group in the picker with the other scientific and elevation ramps.
    science = {pid for pid, p in cat.items() if p.group == "science"}
    assert science == {*RASTER_RAMPS, "d3:viridis", "d3:magma", "goat:elevation"}


def test_palette_colors() -> None:
    assert palette_colors(["#000000", "#ffffff"]) == ["#000000", "#ffffff"]
    assert palette_colors("x:none") is None
    assert palette_colors("goat:green")[0] == "#e6f6ef"


def test_icons() -> None:
    names = icon_names()
    assert {"circle-solid", "star-solid", "caret-up-solid", "arrow-up-solid"} <= names
    assert len(names) >= 180


def test_icon_libraries() -> None:
    from goatlib.style.catalog import icon_libraries

    libraries = icon_libraries()
    assert set(libraries) == {"goat", "emoji"}
    assert {"park", "farm_shop_basket", "star-solid"} <= libraries["goat"]
    # Emoji are named by their code points, joined by "-".
    assert {"1f525", "1f692", "2764-fe0f", "1f1e9-1f1ea"} <= libraries["emoji"]


def test_emoji_catalogue() -> None:
    from goatlib.style.catalog import EMOJI_GROUPS, emoji, icon_libraries

    entries = emoji()
    assert len(entries) > 1800
    codes = [e["code"] for e in entries]
    assert len(codes) == len(set(codes))
    fire = next(e for e in entries if e["code"] == "1f525")
    assert fire["name"] == "fire" and fire["group"] == "travel_places"
    assert "fire" in fire["keywords"]
    assert [g for g in EMOJI_GROUPS if any(e["group"] == g for e in entries)] == list(
        EMOJI_GROUPS
    )
    assert {e["group"] for e in entries} == set(EMOJI_GROUPS)
    # Skin tones are variants of their emoji, light to dark; toned codes are icon names too.
    wave = next(e for e in entries if e["code"] == "1f44b")
    assert wave["tones"] == [f"1f44b-1f3f{t}" for t in "bcdef"]
    assert not any("1f3fb" in c for c in codes)
    assert "1f44b-1f3fd" in icon_libraries()["emoji"]


def test_colorbrewer_palettes_carry_every_class_count() -> None:
    orrd = palettes()["colorbrewer:OrRd"]
    assert sorted(orrd.variants) == list(range(3, 10))
    assert orrd.variants[5] == ("#fef0d9", "#fdcc8a", "#fc8d59", "#e34a33", "#b30000")
    assert orrd.colors == orrd.variants[9]
    assert palettes()["goat:green"].variants == {}


GROUP_IDS = [
    ("urban_infrastructure", "icon_category_urban_infrastructure"),
    ("cultural_landmark", "icon_category_cultural_landmark"),
    ("shopping_services", "icon_category_shopping_services"),
    ("recreation_entertainment", "icon_category_recreation_entertainment"),
    ("nature_environment", "icon_category_nature_environment"),
    ("health_safety", "icon_category_health_safety"),
    ("transportation_vehicles", "icon_category_transportation_vehicles"),
    ("shapes_pins", "icon_category_shapes_pins"),
]


def test_every_icon_is_in_exactly_one_group() -> None:
    from goatlib.style.catalog import icon_groups

    groups = icon_groups()
    assert [(g["id"], g["label_key"]) for g in groups] == GROUP_IDS
    listed = [i for g in groups for i in g["icons"]]
    assert len(listed) == len(set(listed))
    assert set(listed) == icon_names()
    group_of = {i: g["id"] for g in groups for i in g["icons"]}
    # The icons the web's old gallery did not group: the eight from the shared bucket and the four shapes.
    assert {
        n: group_of[n]
        for n in (
            "bike_parking_big",
            "electric-bike-icon",
            "bread-loaf-solid",
            "butcher_meat",
            "farm_shop_basket",
            "food_vending_machine",
            "library-icon",
            "wine-glass-solid",
            "circle-solid",
            "star-solid",
            "caret-up-solid",
            "arrow-up-solid",
        )
    } == {
        "bike_parking_big": "transportation_vehicles",
        "electric-bike-icon": "transportation_vehicles",
        "bread-loaf-solid": "shopping_services",
        "butcher_meat": "shopping_services",
        "farm_shop_basket": "shopping_services",
        "food_vending_machine": "shopping_services",
        "library-icon": "shopping_services",
        "wine-glass-solid": "recreation_entertainment",
        "circle-solid": "cultural_landmark",
        "star-solid": "cultural_landmark",
        "caret-up-solid": "cultural_landmark",
        "arrow-up-solid": "cultural_landmark",
    }
