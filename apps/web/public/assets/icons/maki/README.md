# Marker icons

The marker icons of the layer style marker gallery (`lib/constants/icons.ts`)
and the default point marker (`foundation-marker.svg`). The web app serves
them at `/assets/icons/maki/<name>.svg`; stored layer styles reference them by
that path.

`symbols.json` holds the catalogue icons' path data in one file, so the icon
picker draws all of them from one request. `pnpm generate:style` writes it from
the SVGs; a test fails when it no longer matches them.

They come from several icon sets, each under its own licence:

| Source | Files | Licence |
| --- | --- | --- |
| [Mapbox Maki](https://github.com/mapbox/maki) 8.2 | the 15×15 icons (`viewBox="0 0 15 15"`) except the three below | CC0 1.0 |
| [Temaki](https://github.com/rapideditor/temaki) 5.13 | `bicycle_parked.svg`, `meat.svg`, `wind_turbine.svg` | CC0 1.0 |
| [Font Awesome Free](https://fontawesome.com) 6.5 | files whose header reads "Font Awesome Free" | icons CC BY 4.0, see https://fontawesome.com/license/free |
| [Foundation Icon Fonts 3](https://github.com/zurb/foundation-icon-fonts) | `foundation-marker.svg` | MIT |

Font Awesome files carry their attribution in the SVG comment; keep it when
editing them.
