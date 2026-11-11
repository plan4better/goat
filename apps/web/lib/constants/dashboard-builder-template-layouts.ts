
export const basicLayout = {
  settings: {
    control_positions: {
      "top-left": ["location", "measure"],
      "top-right": [],
      "bottom-left": [],
      "bottom-right": ["view", "zoom_controls", "basemap", "fullscreen"],
    },
    allowed_basemaps: null,
    toolbar: true,
    project_info_content: "",
    language: "auto",
    font_family: "Mulish, sans-serif",
  },
  interface: [
    {
      id: "5a3051f4-4e87-4441-85b9-a15e9d887acf",
      type: "panel",
      config: {
        options: { style: "default" },
        position: { spacing: 0, alignItems: "start" },
        appearance: { shadow: 5, opacity: 0.7, backgroundBlur: 15 },
      },
      widgets: [
        {
          id: "da45d41f-72fc-4ffc-971d-47fa1d4634b8",
          type: "widget",
          config: {
            type: "layers",
            setup: { title: "Layers" },
            options: { show_search: true, open_legend_by_default: true },
          },
        },
      ],
      position: "left",
    },
  ],
};
