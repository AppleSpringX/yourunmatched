# Hero portraits

Drop hero portrait images here as `<slug>.webp` (or `.png`/`.jpg` — adjust HTML if you change format).

The slug for each hero comes from `src/data/heroes.json`. Examples:

- `geralt.webp` → Геральт из Ривии
- `ciri.webp` → Цири
- `ancient-leshen.webp` → Древний Леший
- `medusa.webp` → Медуза
- `spider-man.webp` → Человек-Паук

Recommended specs:
- **Size:** 256×256 px (square, will be cropped to circle in UI)
- **Format:** WebP for size; PNG also fine
- **Background:** transparent or solid (no preference — UI clips to circle)

Until you drop a file for a slug, the avatar shows a colored letter on a deterministic hashed background. So missing portraits don't break anything visually — they just look more like uniform letter circles.

## Full slug list

Get fresh list from the API: `GET /api/heroes` returns `{id, name, slug, set_name}` for every hero. Or run:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('src/data/heroes.json','utf8')).map(h=>h.slug).join('\n'))"
```
