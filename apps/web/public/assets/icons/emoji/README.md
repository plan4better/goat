# Emoji

GOAT Style's emoji library (`emoji:<code>`, the code points in lowercase hex joined
by `-`). One 64 px WebP per emoji and per skin tone, which the map draws; the
picker reads `sheets/`: one sheet per group and one per skin tone, so it loads a
few images instead of thousands. The
catalogue the picker and goatlib read is
`packages/python/goatlib/src/goatlib/style/data/emoji.json`; an emoji with skin
tones lists its five toned codes under `tones`.

Both are built by `apps/web/scripts/build-emoji.mjs` from the
[emoji-datasource-google](https://github.com/iamcal/emoji-data) 16.0.0 package
(`npm pack emoji-datasource-google@16.0.0`, then pass the unpacked folder).

| Source | Licence |
| --- | --- |
| Images: [Noto Emoji](https://github.com/googlefonts/noto-emoji) by Google | Apache License 2.0 |
| Names, groups and keywords: [emoji-data](https://github.com/iamcal/emoji-data) | MIT |

Library emoji are only ever added; a name never changes, so stored styles keep
drawing.
