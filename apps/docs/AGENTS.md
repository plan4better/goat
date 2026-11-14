# Documentation (apps/docs)

## Documentation Writing Rules

- Before documenting a part of the UI, read in full every TSX component that renders it: exact button labels, step order, dialog titles, status names and flows can't be inferred from memory, summaries or existing docs.
- Take every UI label, in English and German, from `apps/web/i18n/locales/en/common.json` and `apps/web/i18n/locales/de/common.json` (grep both), not from existing docs, a glossary or your own translation, so the docs show the exact string the UI renders.
- Every page needs a `description` in its front matter, one sentence on what the page covers: the site's `llms.txt` and GOAT AI's list of docs pages show it, and `apps/assistant/tests/test_user_docs.py` fails for a page without one. GOAT AI answers questions about the interface from these pages (`apps/assistant/src/assistant/user_docs`), so a label that drifts from the UI reaches its answers too.
- For Docusaurus docs, also check existing DE pages (e.g. `i18n/de/...`) to confirm which terms are already in use and to maintain consistency.
- **No picture or recording is taller than 450px.** `src/css/custom.css` caps images and videos in the docs at that height and respects a smaller `maxWidth` set on the element (on a phone everything fits the column). So don't set `maxHeight` above 450px, and know that `maxHeight: "auto"` is invalid CSS and does nothing. For a narrow UI screenshot, set `maxWidth` to about half the file's pixel width so it shows at its size in GOAT. Check a page by rendering it, not by reading the markup.
- **Screen recordings are MP4, screenshots are WebP — never GIF.** Embed a recording with `<Video src={require('/img/….mp4').default} alt="…" />` (registered globally, no import); it plays muted and looped like a GIF. Convert with `ffmpeg -i in.gif -movflags +faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -crf 26 out.mp4` and `ffmpeg -i in.png -c:v libwebp -quality 85 out.webp`. The PR `file-size` check rejects images over 1 MB, videos over 4 MB and other files over 2 MB (`scripts/check-file-sizes.sh`; exceptions go in `.github/large-files.txt`). Don't commit source files (`original_files/`, `.pptx`) next to the published images.

## Docs Diagram Exports (Figma API)

Diagrams used in the documentation are exported from Figma file `SmmQgQZ9QvWwg62NBlJcN8` (P4B-Website) using the Figma API. To re-export a diagram:

```bash
# Get image URL for a node (replace NODE_ID and TOKEN)
curl -s -H "X-Figma-Token: TOKEN" \
  "https://api.figma.com/v1/images/SmmQgQZ9QvWwg62NBlJcN8?ids=NODE_ID&format=png&scale=2" | python3 -m json.tool

# Download the returned URL directly to the static folder
curl -sL "IMAGE_URL" -o apps/docs/static/img/PATH/filename.png
```

**Current diagrams:**
| File | Figma node | Path |
|------|-----------|------|
| PT trip structure + combinations (EN) | `2581-83` | `apps/docs/static/img/routing/pt_trip_structure.png` |
| PT trip structure + combinations (DE) | `2584-2` | `apps/docs/static/img/routing/pt_trip_structure_de.png` |
| Cycling edge cost by topology (EN) | `2590-2` | `apps/docs/static/img/routing/bicycle_edge_cost.png` |
| Cycling edge cost by topology (DE) | `2590-47` | `apps/docs/static/img/routing/bicycle_edge_cost_de.png` |

**Token:** stored separately — ask the user. Do not hardcode it in this file.
