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
