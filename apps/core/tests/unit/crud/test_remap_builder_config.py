from core.crud.crud_project_copy import _remap_builder_config


def _layers_widget_config() -> dict:
    return {
        "interface": [
            {
                "widgets": [
                    {
                        "type": "layers",
                        "setup": {
                            "title": "Layers",
                            "group_info": {
                                "94": "Trees info",
                                "95": "Water info",
                                "110": "Stale info",
                            },
                        },
                        "options": {
                            "show_group_icons": True,
                            "group_icon_94": {"url": "tree.svg", "source": "custom"},
                            "group_icon_95": {"url": "drop.svg", "source": "library"},
                            "group_icon_110": {"url": "stale.svg"},
                            "downloadable_layers": [10, 11],
                        },
                    }
                ]
            }
        ]
    }


def test_remaps_group_icon_keys_and_group_info_keys() -> None:
    result = _remap_builder_config(
        _layers_widget_config(), {10: 20, 11: 21}, {94: 102, 95: 103}
    )
    widget = result["interface"][0]["widgets"][0]
    opts = widget["options"]

    assert opts["group_icon_102"] == {"url": "tree.svg", "source": "custom"}
    assert opts["group_icon_103"] == {"url": "drop.svg", "source": "library"}
    assert "group_icon_94" not in opts
    assert "group_icon_95" not in opts
    # Unmapped (stale) keys are preserved, matching the import behaviour
    assert opts["group_icon_110"] == {"url": "stale.svg"}

    info = widget["setup"]["group_info"]
    assert info == {"102": "Trees info", "103": "Water info", "110": "Stale info"}

    # layer_project id remap in arrays still works alongside the group remap
    assert opts["downloadable_layers"] == [20, 21]


def test_group_map_omitted_keeps_group_keys_untouched() -> None:
    result = _remap_builder_config(_layers_widget_config(), {10: 20, 11: 21})
    widget = result["interface"][0]["widgets"][0]
    assert "group_icon_94" in widget["options"]
    assert widget["setup"]["group_info"]["94"] == "Trees info"


def test_numbers_that_equal_an_old_link_id_keep_their_value() -> None:
    """Reported 2026-10-10: a copy of a project whose links had small ids
    turned a panel's `shadow: 5` into 48 and `opacity: 1` into 29, and the web
    app refused to open the copy. Only fields that name a link are mapped."""
    config = {
        "interface": [
            {
                "type": "panel",
                "config": {
                    "appearance": {"shadow": 5, "opacity": 1, "backgroundBlur": 15}
                },
                "widgets": [
                    {
                        "config": {
                            "layer_project_id": 5,
                            "options": {
                                "x_axis_ticks": [1, 5],
                                "downloadable_layers": [1, 5],
                            },
                            "setup": {
                                "target_layers": [
                                    {"layer_project_id": 1, "column_name": "a"}
                                ]
                            },
                        }
                    }
                ],
            }
        ]
    }

    result = _remap_builder_config(config, {1: 29, 5: 48})

    panel = result["interface"][0]
    assert panel["config"]["appearance"] == {
        "shadow": 5,
        "opacity": 1,
        "backgroundBlur": 15,
    }
    widget = panel["widgets"][0]["config"]
    assert widget["layer_project_id"] == 48
    assert widget["options"] == {
        "x_axis_ticks": [1, 5],
        "downloadable_layers": [29, 48],
    }
    assert widget["setup"]["target_layers"] == [
        {"layer_project_id": 29, "column_name": "a"}
    ]


def test_an_id_is_mapped_once_when_new_and_old_ids_overlap() -> None:
    """With {9: 6, 6: 3} the entry that was 9 must end up 6, not 3."""
    config = {"widgets": [{"layer_project_id": 9}, {"layer_project_id": 6}]}
    result = _remap_builder_config(config, {9: 6, 6: 3})
    assert result == {"widgets": [{"layer_project_id": 6}, {"layer_project_id": 3}]}
