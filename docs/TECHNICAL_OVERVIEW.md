# LOD Messiah — technická dokumentace

> Offline cooker: KitBash / high-poly budovy → engine-ready LOD chain (GLB + atlas + `asset.json`).  
> Runtime hry **nevaří** — jen čte výstup. Repo: [LOD-Messiah](https://github.com/Syntheion-Dynamics/LOD-Messiah).

Související dokumenty:
- `AI_ENGINE_WIREUP.md` — kontrakt pro engine AI (co načíst, MASK, siblings)
- `ARCHITECT_LOD_STATUS.md` — mapa pro QC / architekta (kde klikat)
- `ENGINE_HANDOFF_8H.md` — krátký napojovací plán
- `legacy/README.md` — starý octahedral impostor / Blender hull (opt-in)

---

## 1. Co to je

**LOD Messiah** je Node.js pipeline, která z jednoho high-poly modelu (typicky KitBash `.glb`) vyrobí sadu souborů pro Vulkan engine:

| Výstup | Účel |
|--------|------|
| `default.glb` | Plná kvalita před decimací (diagnostika; do hry se obvykle nekopíruje) |
| `lod0.glb` | Blízko — mesh + textury (PNG, tiling multi-material) |
| `lod1.glb` | Střed — hrubší mesh, **geometry-only** (materiály/textury z LOD0 podle jména) |
| `lod2.glb` | Dál — ještě hrubší mesh; volitelně unique-UV + PBR atlas |
| `lod3.glb` | Daleko — levná **3D silueta** + self-contained **MASK** albedo |
| `lod3_atlas/albedo.png` | Sidecar atlas (stejný jako embedded v `lod3.glb`) |
| `asset.json` | Discovery LODů, metadata LOD3, shared textures |
| `report.json` | QA čísla (tris, glass QC, …) |

Kontrakt: **TOOL peče offline, engine jen čte.** Žádná decimace / bake v enginu.

---

## 2. Na čem to běží

### Runtime

| Požadavek | Poznámka |
|-----------|----------|
| **Node.js ≥ 20** | ESM (`"type": "module"`) |
| **npm install** | závislosti v `package.json` |
| **Windows** | bat wrappery (`convert-kitbash.bat`, …); pipeline je cross-platform Node |
| **GPU / WebGL** | LOD2 atlas + LOD3 bake běží v headless Chromium (Puppeteer) |

### Hlavní knihovny

| Balíček | Role |
|---------|------|
| `@gltf-transform/*` | Čtení/zápis GLB, materiály, prune/dedup/flatten |
| `meshoptimizer` | Decimace meshů (LOD0–2) |
| `sharp` | Resize textur (albedo vs normal/ORM cap) |
| `three` + `puppeteer` | Headless WebGL bake (LOD2 atlas, LOD3 ortho + heightmap) |
| `watlas` | Unique UV / atlas (LOD2) |

### Externí nástroje (volitelné)

| Nástroj | Kdy |
|---------|-----|
| **Blender** | Konverze FBX/OBJ → GLB; volitelný normal bake |
| **toktx** | KTX2 komprese textur (`--ktx2`; pro engine day-1 typicky **`--no-ktx2`**, engine dělá PNG→BC7) |

### Co není v gitu

- `Kitbash Assets/` — koupené zdroje (licence + velikost)
- `output/` — výsledek cooku (regeneruj)
- `node_modules/`

Po clone: `npm install` + lokální KitBash (nebo jiný input) → cook.

---

## 3. Architektura složek

```
TOOL/
├── src/                      # ★ pipeline
│   ├── cli.js                # CLI vstup
│   ├── pipeline.js           # orchestrace assetu
│   ├── convert.js            # discovery, normalize → GLB, work dirs
│   ├── permissive-simplify.js + glass-materials.js
│   ├── lod2-atlas.js
│   ├── lod3-silhouette.js    # ★ LOD3 slicecards (+ boxcards fallback)
│   ├── impostor.js           # thin wrapper → legacy octa (opt-in)
│   ├── material-merge.js, ktx2.js, stats.js, …
├── scripts/                  # rebake / ship helpery
├── legacy/                   # starý impostor + Blender hull (default OFF)
├── docs/                     # handoffy + tato dokumentace
├── gallery/                  # lokální web náhled (není runtime hry)
├── cook-ui/                  # lokální UI: výběr kitů + LODů k pečení
├── Kitbash Assets/           # vstup (gitignore)
├── output/                   # výstup cooku (gitignore)
├── convert-kitbash.bat       # 1 budova
├── convert-kitbash-all.bat   # celý kit / batch
├── cook-ui.bat               # UI picker (port 4174)
├── rebake-lod3-kitbash.bat   # jen LOD3 znovu
└── ship-to-engine.bat        # kopie do engine Assets
```

CLI entry: `npm run convert` → `src/cli.js` → `processAsset` / `processBatch` v `pipeline.js`.

### Cook UI (výběr kitů + LODů)

Spouštění:

```bat
cook-ui.bat
rem nebo: npm run cook-ui  →  http://127.0.0.1:4174
```

UI vylistuje složky pod `Kitbash Assets/` (kity). Checkboxy:

| Checkbox | Co dělá |
|----------|---------|
| **LOD0 / LOD1** | Spustí plný `npm run convert` pro vybrané kity (`--only`) |
| **LOD2-atlas** | Stejný convert **s** atlas bake (bez checkboxu → `--no-lod2-atlas`) |
| **LOD3** | S convertem: `--lod3-silhouette`; **samotný** LOD3 → `npm run rebake:lod3 -- --force` |

Mapování:

- jen LOD3 → `rebake:lod3` (rychlé, potřebuje už uvařený lod2 atlas / default)
- LOD0/1 a/nebo LOD2-atlas → `convert --kits-root "./Kitbash Assets" --only A,B …`

Jeden job najednou; log se polluje v prohlížeči.

---

## 4. Jak funguje cook (pipeline)

Pro každý asset (`processAsset`):

```text
vstup (.glb / .fbx / …)
    │
    ▼
normalize → GLB
    │
    ▼
merge materiálů (tiling zachován pro lod0/1)
    │
    ▼
resize textur (volitelně: albedo ≤ max-texture, normal/ORM ≤ 1024)
    │
    ▼
default.glb  (+ volitelně external URI → kit/_shared/textures/)
    │
    ▼
KTX2 (default ON v CLI; baty pro engine: --no-ktx2)
    │
    ├─► LOD0 / LOD1 / LOD2  — meshoptimizer simplify
    │      • glass/emissive primitivy chráněné (nevymazat okna)
    │      • LOD1 = geometry-only (textury z LOD0 ve hře)
    │      • LOD2 = geo-only NEBO unique UV + atlas (default atlas ON)
    │
    ├─► LOD2 atlas           — watlas + Blender; glass → opaque sky proxy před EMIT bake
    ├─► LOD3 slicecards      — Puppeteer; zdroj preferuje lod2.glb (proxy-chain)
    │      • fallback → 6-quad AABB boxcards
    │
    └─► legacy impostor      — jen s --impostor (default OFF)
    │
    ▼
asset.json + report.json + cleanup junk
```

### LOD0–2 (stručně)

- Poměry default: `0.5 / 0.3 / 0.1`
- Error ladder: LOD0 jemnější, LOD2 agresivnější (viz `pipeline.js`)
- **Glass-safe:** tenká okna / emissive fasády se neodebírají simplifikací; soft QC v reportu (≥95 % glass tris)
- LOD1/geo-LOD2 v Blenderu vypadají „bílé“ — to je záměr; textury doplní engine ze slotů LOD0

### Shared textury

`--shared-textures` (zapínají baty): PNG jdou do `output/<Kit>/_shared/textures/<sha1>.png`, GLB mají external URI. Engine resolve relativně ke složce assetu.

---

## 5. LOD3 — slicecards (aktuální default)

LOD3 je **levný far proxy**: pořád 3D mesh (ne billboard impostor), ale řádově desítky–stovky tris, jedna MASK textura, self-contained materiál.

Soubor: `src/lod3-silhouette.js`.

### 5.1 Proč to existuje

Starý hull / height-slice z raw KitBash geometrie u dutých fasád často skončil u „rámečků“.  
**Slicecards** staví siluetu z **výškových pásů půdorysu** a na stěny **promítne ortho fotky** budovy — dutá skořápka / římsy / podlaha nekazí „fotku“, jen mírně AABB.

Když extrakce pásů selže → automatický fallback na **boxcards** (6 quads na AABB). Engine kontrakt zůstává stejný.

### 5.2 Výstupní kontrakt (engine)

| Položka | Hodnota |
|---------|---------|
| Soubor | `lod3.glb` |
| Atlas | `lod3_atlas/albedo.png` (+ embedded v GLB) |
| Materiál | `Lod3SilhouetteMaterial` |
| `alphaMode` | `MASK` |
| `alphaCutoff` | `0.5` |
| Tris limity | 1 … 3000 (QC) |
| `asset.json` → `lod3.backend` | `"slicecards"` nebo `"boxcards"` |

Engine: opaque pass + `discard` pod cutoff; **zachovat alpha** (BC7, ne BC1); u MASK **clamp UV** + **bez mipmap** (jinak silueta řídne). LOD3 **nesdílí** materiálové sloty s LOD0.

### 5.3 Bake pipeline (krok za krokem)

Běží v headless Chromiu (Puppeteer) + Three.js; Node pak sestaví GLB přes glTF-Transform.

```text
1) 6 ortho „fotek“ (preferovaně z **lod2.glb** atlasu — stejné pixely skla/fasády)
      → atlas 3×2, default 2048 px, pad 8 px
      → RGBA, A = coverage (pro MASK); albedo gain **1.0** (žádné ×1.45)

2) Top-down heightmapa všech trojúhelníků
      → per-pixel max world Y (stěny = edges, plochy = barycentric fill)

3) Roofline detection
      → histogram max Y → až 5 hranic pásů (max ~5 bands)

4) Per band:
      coverage mask → morph close → flood-fill interior
      → exterior contours → **radiální fit** (válec) pre-DP, jinak Douglas–Peucker

5) Geometrie (slicecards):
      per contour per band = prism
      • side walls (quady)
      • top caps (ear-clip)
      UVs = box projection: dominantní normála stěny → odpovídající ortho tile

6) Fallback:
      žádné použitelné pásy / GLB > MAX_TRIS → 6 AABB quads (boxcards)
```

Atlas layout (row-major): `+X −X +Y / −Y +Z −Z`.

### 5.4 Co uvidíš v QC

- **Slicecards:** budova má „stupně“ (křídlo / věž / nástavba vlastní výšku a půdorys); z orbitů vypadá jako hrubá 3D silueta s fotkou na stěnách
- **Boxcards fallback:** krabice ze 6 stran; z ~45° prosvítají hrany karet — očekávané
- Typicky **~30–350 tris** u slicecards (vs 12 u čistých boxcards)

### 5.5 Rychlé ovládání

```bat
rem celý cook 1 budovy
convert-kitbash.bat "Kitbash Assets\Manhattan\Office_Plaza.glb"

rem jen LOD3 (už máš default.glb)
rebake-lod3-kitbash.bat Manhattan

rem nižší atlas / paralel
set LOD3_RES=1024
set LOD3_JOBS=3
```

Vypnout LOD3: `--no-lod3-silhouette`.  
Legacy octa impostor: `--impostor` (viz `legacy/`).

---

## 6. `asset.json` (kontrakt)

Příklad (zkráceno):

```json
{
  "name": "Manhattan/Office_Plaza",
  "default": "default.glb",
  "lods": [
    { "level": 0, "file": "lod0.glb", "targetRatio": 0.5 },
    { "level": 1, "file": "lod1.glb", "targetRatio": 0.3, "note": "geometry-only; materials from lod0" },
    { "level": 2, "file": "lod2.glb", "targetRatio": 0.1, "atlas": true, "maps": "lod2_atlas/" },
    {
      "level": 3,
      "file": "lod3.glb",
      "atlas": true,
      "maps": "lod3_atlas/",
      "note": "silhouette slice stack + box-projected MASK atlas; self-contained"
    }
  ],
  "lod3": {
    "ok": true,
    "file": "lod3.glb",
    "atlas": "lod3_atlas/",
    "triangles": 142,
    "resolution": 2048,
    "backend": "slicecards",
    "slices": 3,
    "alphaMode": "MASK"
  },
  "sharedTextures": true
}
```

Engine může discovery dělat ze sibling souborů (`lod0`…`lod3`) nebo z `lods[]` / bloku `lod3`.

---

## 7. Jak spustit (developer)

```bat
cd C:\Users\yukit\Downloads\TOOL
npm install

rem 1 budova (engine-ready flagy)
convert-kitbash.bat

rem nebo přímo
npm run convert -- -i "Kitbash Assets\Manhattan\Office_Plaza.glb" -o ./output --no-ktx2 --max-texture 2048 --no-impostor --lod3-silhouette --lod3-res 2048 --shared-textures

rem náhled
gallery.bat

rem do hry
ship-to-engine.bat Manhattan\Office_Plaza
```

Výstup: `output\<Kit>\<Asset>\` (s `--kits-root` / KitBash layout) nebo flat `output\<Asset>\`.

### Užitečné env / flagy

| Flag / env | Význam |
|------------|--------|
| `--lod3-res N` / `LOD3_RES` | hrana atlasu (default 2048) |
| `--no-lod3-silhouette` | přeskočit LOD3 |
| `--no-lod2-atlas` | LOD2 jen geo |
| `--shared-textures` | kit `_shared/textures/` |
| `--jobs N` / `CONVERT_JOBS` | paralelní assety |
| `--impostor` | legacy octa/box (OFF) |

---

## 8. Engine napojení (1 odstavec)

Scéna odkazuje **jen** `lod0.glb`. Loader najde `lod1`/`lod2`/`lod3` ve stejné složce. `LodSelector` přepíná podle vzdálenosti + hystereze. LOD1/2 berou textury ze stejně pojmenovaných materiálů LOD0. LOD3 je self-contained MASK. Detailní checklist: `AI_ENGINE_WIREUP.md`.

---

## 9. Legacy vs current

| Cesta | Stav |
|-------|------|
| LOD3 **slicecards** (+ boxcards fallback) | **Default** — `src/lod3-silhouette.js` |
| Octahedral / box impostor | `legacy/impostor/` — opt-in `--impostor` |
| Blender visual-hull LOD3 | `legacy/lod3-silhouette/` — nepoužívat v default cooku |

---

## 10. Klíčové soubory ke čtení kódu

| Soubor | Co říká |
|--------|---------|
| `src/cli.js` | Flagy a defaulty |
| `src/pipeline.js` | Pořadí kroků, zápis `asset.json` |
| `src/lod3-silhouette.js` | Celý LOD3 bake (HTML baker + extractSlices + GLB build) |
| `src/permissive-simplify.js` | Glass-safe decimace |
| `scripts/ship-to-engine.js` | Co se kopíruje do Assets |

---

*Poslední aktualizace dokumentace: 2026-07-23 — LOD3 slicecards jako default backend.*
