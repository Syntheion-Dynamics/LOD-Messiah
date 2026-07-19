# Legacy bakers (kept, not destroyed)

Code here is **opt-in / reference only**. Default KitBash cook uses **LOD3 boxcards** (`src/lod3-silhouette.js`).

| Path | What |
|------|------|
| `impostor/` | Octahedral + AABB box impostor (`--impostor`) |
| `lod3-silhouette/` | Visual-hull / height-slice LOD3 (Blender) |

Enable legacy impostor:

```bat
npm run convert -- ... --impostor --impostor-mode octahedral
npm run rebake:impostors
```

Legacy LOD3 hull (manual):

```js
import { bakeLod3Silhouette } from '../legacy/lod3-silhouette/lod3-silhouette-hull.js';
```
