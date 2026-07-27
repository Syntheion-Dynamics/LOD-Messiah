# AI návod: napojení LOD Messiah (TOOL) → Vulkan hra

> Účel: dej tento dokument AI v **engine** repu. Má vědět co TOOL dělá, co načíst, co ignorovat, a jak zapojit LOD chain.  
> TOOL root: `c:\Users\yukit\Downloads\TOOL`  
> Engine: Bungáč (Vulkan). Kontrakt: **TOOL peče offline, engine jen čte.** Žádná decimace / bake v enginu.

---

## 1. Jednou větou

**LOD Messiah** bere KitBash / high-poly budovy a vyrábí engine-ready složku: `lod0` + `lod1` + `lod2` (+ volitelně octahedral impostor atlas). Hra zkopíruje složku do Assets, ve scéně odkáže `lod0.glb`, sibling LODy přepíná podle vzdálenosti. Textury jsou **PNG** → engine je komprimuje na **BC7** v texcache.

---

## 2. Co je co (role)

| Věc | Role |
|---|---|
| **TOOL** (`Downloads\TOOL`) | Offline cooker / pipeline (Node). Není runtime hry. |
| **Kitbash Assets/** | Koupené zdroje (gitignore). Vstup cooku. |
| **output/** | Výsledek cooku — **tohle jde do hry**. |
| **gallery** (`gallery.bat`) | Lokální web náhled cooku. Není součást hry. |
| **Engine** | Vulkan loader + LodSelector + (později) impostor shader. |

---

## 3. Adresáře TOOL (orientace)

```
TOOL/
├── Kitbash Assets/          # vstup (Brooklyn, Every City, Manhattan, …)
├── input/                   # obecné .glb/.fbx/.obj (ne KitBash)
├── output/                  # ★ cooked assety → kopíruj do engine Assets
│   ├── <Asset>/             # flat (starší / single convert)
│   └── <Kit>/<Asset>/       # preferred layout z --kits-root
├── src/                     # pipeline kód (engine AI čte jen kvůli kontraktu)
├── scripts/                 # Blender bakers, rebake impostorů
├── gallery/                 # UI náhledu
├── runtime/                 # Three.js příklad LOD — NENÍ Vulkan
├── docs/                    # handoffy (tento soubor + ENGINE_HANDOFF_8H.md)
├── convert-kitbash.bat      # 1 budova
├── convert-kitbash-all.bat  # celé kity
├── rebake-kitbash-impostors.bat
└── gallery.bat
```

Klíčové zdroje kontraktu (čti při nejasnosti):
- `docs/AI_ENGINE_WIREUP.md` — tento soubor
- `docs/ENGINE_HANDOFF_8H.md` — krátký 8h plán
- `src/pipeline.js` — co se zapisuje na disk
- `src/octahedral.js` — impostor atlas layout (až budete shader)
- `src/cli.js` — CLI flagy

---

## 4. Engine den 1 — minimální napojení (LOD chain)

### 4.1 Co zkopírovat

**Preferuj script** (day-1 soubory, bez `default.glb` / impostoru):

```bat
cd /d c:\Users\yukit\Downloads\TOOL
ship-to-engine.bat Manhattan\Office_Plaza
```

Nebo ručně celou složku assetu, např.:

`TOOL/output/Manhattan/Office_Plaza/` → `Engine/Assets/Buildings/Manhattan/Office_Plaza/`

Minimální soubory pro LOD ve hře:

| Soubor | Engine musí |
|---|---|
| `lod0.glb` | **Načíst** — root reference ve scéně (mesh + PNG textury) |
| `lod1.glb` | **Načíst** jako sibling LOD (geometry-only) |
| `lod2.glb` | **Načíst** jako sibling LOD (geo-only nebo atlas) |
| `lod3.glb` | **Načíst** — silhouette proxy (height-slice / visual-hull) + **MASK** albedo (self-contained) |
| `asset.json` | Volitelně — discovery LODů / impostoru / blok `lod3` |
| `lod2_atlas/*` | Jen pokud `asset.json` říká `atlas: true` u lod2 |
| `lod3_atlas/*` | Sidecar albedo (PNG); runtime bere i embedded image z `lod3.glb` |

### 4.2 Scéna

1. Entity / actor odkazuje **jen** `lod0.glb`.
2. Engine najde sibling `lod1.glb`, `lod2.glb`, `lod3.glb` ve stejné složce (nebo přečte `asset.json` → `lods[].file`).
3. `LodSelector` přepíná podle vzdálenosti / screen size + **hystereze** (~±10 %).
4. Textury z lod0: **PNG → BC7** v texcache. TOOL vařit s **`--no-ktx2`**.
5. LOD3 = self-contained MASK (viz §4.5) — v DEBUG **Force LOD**: engine numbering je posunuté — Force **N** ≈ soubor `lod(N-1)` (Force 3 = `lod2.glb`, Force 4 = `lod3.glb`).

### 4.4 LOD thresholds / pop (engine handoff)

- Prahy `T LOD1` … musí být **rozestoupené** (ne `T LOD1 == T LOD2`) — jinak Auto přeskočí úroveň.
- Hystereze ~10–12 % proti flickeru; na vizuální pop lod2↔lod3 nestačí — TOOL peče LOD3 z `lod2.glb` (stejné albedo pixely).
- Ideálně **alpha stipple / dither crossfade** při přechodu (GTA-style); fog pomáhá schovat zbylý skok.
- LOD3 může být o ~2 % „tlustší“ (MARGIN / dilate) — reziduum, ne bug loaderu.

### 4.5 LOD3 v2 — MASK cutout (povinné chování enginu)

TOOL peče siluetu s coverage v alpha kanálu:

| Pole v GLB | Hodnota | Engine |
|---|---|---|
| `alphaMode` | `MASK` | Opaque pass + `discard` pod cutoff (**ne** BLEND) |
| `alphaCutoff` | `0.5` | Import → `AlphaCutoff`; 0 = žádný cutout |
| Albedo | RGBA PNG | BC7 (texconv); **zachovat alpha** — BC1 fallback kazí MASK |
| Sampler | často REPEAT | U self-contained MASK **force clamp** (atlas bleed) |
| Mipmapy | — | U `AlphaCutoff > 0` **DisableMipmaps** (jako foliage) — jinak silueta řídne |

Self-contained materiály LOD3 **nesdílí** sloty s LOD0 (1 mat vs desítky). Editor editace vždy cílí LOD0 (viz Bugbot fix).

`asset.json` příklad bloku:
```json
"lod3": {
  "ok": true,
  "file": "lod3.glb",
  "atlas": "lod3_atlas/",
  "triangles": 107,
  "slices": 6,
  "alphaMode": "MASK",
  "backend": "height-slice+blender"
}
```

---

### 4.3 Materiály napříč LODy

| LOD | Textury | Materiály |
|---|---|---|
| **lod0** | Embedded PNG (nebo složka textur) | Plné PBR, multi-material, tiling UV |
| **lod1** | Žádné (geometry-only) | **Stejná jména / pořadí** jako lod0 — bind textury z lod0 |
| **lod2** | Buď geometry-only jako lod1, **nebo** self-contained `lod2_atlas/` (1 materiál, unique UV) | Viz `asset.json` → `lods[2].atlas` |

**Pravidlo:** u lod1 (a lod2 bez atlasu) **nesnaž se hledat textury v GLB** — vezmi materiály z lod0 podle jména/indexu.

### 4.4 Příklad `asset.json` (skutečný)

```json
{
  "name": "Office_Plaza",
  "default": "default.glb",
  "lods": [
    { "level": 0, "file": "lod0.glb", "atlas": false },
    { "level": 1, "file": "lod1.glb", "atlas": false,
      "note": "geometry-only; materials from lod0" },
    { "level": 2, "file": "lod2.glb", "atlas": true,
      "maps": "lod2_atlas/",
      "note": "self-contained PBR atlas (unique UV)" }
  ],
  "impostor": {
    "ok": true,
    "file": "impostor.glb",
    "atlas": "impostor_atlas.png",
    "frames": 16,
    "hemi": true,
    "resolution": 4096,
    "mode": "octahedral"
  },
  "sharedTextures": true,
  "sharedTextureFiles": ["18b2b14383d9b0ad.png", "…"]
}
```

`sharedTextures: false` = textury embedded v `lod0.glb`.  
`sharedTextures: true` = per-kit pool `output/<Kit>/_shared/textures/<sha1>.png` + external URI v `default.glb` / `lod0.glb` (např. `../_shared/textures/<hash>.png`). Engine řeší URI vůči složce GLB (`GltfImageDecodeCache`). Lod2/lod3 atlasy zůstávají embedded. Ship kopíruje `_shared/` **jednou** za kit.

---

## 5. Co enginednes IGNORUJ (day-1)

| Soubor / věc | Proč |
|---|---|
| `impostor.glb`, `impostor_atlas.png`, `impostor.json` | Potřebují view-dependent octahedral shader — **ještě ne** |
| `preview.html` | WebGL gallery only |
| `report.json`, `batch_summary.json` | QA cooku |
| `default.glb` | Full mesh před decimací — editor/debug, ne LOD chain |
| `pack.glb` | Jen pokud někdo zapne `--pack`; preferuj `asset.json` |
| `gallery/`, Puppeteer bake | Není runtime |
| KTX2 / Basis | Engine má PNG→BC7; cook s `--no-ktx2` |

---

## 6. Impostor (až P2 v enginu — kontrakt dat)

Až budete napojovat far LOD:

### Soubory
- `impostor_atlas.png` — grid `frames × frames` (typicky 16×16 v atlasu 4096 → **256 px / pohled**); **RGB premultiplied by A**; tiles have **gutter** (default 2 px, 4 px if tile ≤ 128)
- `impostor.json` — meta (source of truth for shader)
- `impostor.glb` — billboard quad (~2 tris) + atlas; **bez custom shaderu vypadá jako plochý atlas**

### `impostor.json` (v1)
```json
{
  "version": 1,
  "type": "octahedral",
  "hemi": true,
  "frames": 16,
  "atlasSize": 4096,
  "atlas": "impostor_atlas.png",
  "atlasOrigin": "top-left",
  "atlasLayout": "j0_top",
  "gutterPx": 2,
  "alphaMode": "premultiplied",
  "colorSpace": "srgb",
  "mipPolicy": "engine-from-png",
  "alphaCutoff": 0.35,
  "transitionScreenSize": 0.07,
  "channelMap": { "albedo": "RGBA", "alpha": "coverage" },
  "kitId": null,
  "atlasId": null,
  "center": { "x": …, "y": …, "z": … },
  "radius": …,
  "size": { "x": …, "y": …, "z": … }
}
```

`asset.json` → `impostor` také odkazuje `meta: "impostor.json"`, `gutterPx`, `alphaMode`.

### Shader kontrakt (povinné)
- **Hemi-octahedral**, Y-up (`hemi: true`); `center`/`radius` = **bounding sphere** (ne AABB mid)
- Atlas layout **`j0_top`** + `atlasOrigin: "top-left"`: řádek `j=0` je **nahoře** v PNG
- Sample: view dir → octa UV → **3 nejbližší framy + barycentrické váhy** (ne 2×2 bilinear přes diagonálu)
- UV clamp dovnitř dlaždice o `(gutterPx + 0.5)` texelů — bilinear nesmí sahat do sousedního framu
- `alphaMode: "premultiplied"` — při blendu / mip filtraci respektuj premult; alpha-test `discard` pod `alphaCutoff`
- `impostor.glb` jako mesh je OK jako quad; **barva musí jít z view-dependent atlas sample**, ne z naivního UV 0–1 přes celý atlas
- Blender / default glTF viewer **neumí** impostor správně — ověřuj v gallery `preview.html` nebo ve hře

Reference: `src/octahedral.js` (baker + preview shader = engine reference).

---

## 7. Jak se assety vaří (ať AI ví odkud data jsou)

### Engine-ready convert (doporučené flagy)

```bat
cd /d c:\Users\yukit\Downloads\TOOL
convert-kitbash.bat "Kitbash Assets\Manhattan\Office_Plaza.glb"
```

Interně (ekvivalent):
```bash
npm run convert -- --input "…" --output ./output --no-ktx2 --max-texture 2048 --impostor-res 4096 --impostor-frames 16
```

Celé kity:
```bat
convert-kitbash-all.bat
convert-kitbash-all.bat Manhattan
```

Jen přepéct impostory (už existuje `default.glb`):
```bat
rebake-kitbash-impostors.bat Brooklyn
```

### Výstupní layout

| Vstup | Výstup |
|---|---|
| `--input path/to/Office_Plaza.glb` | `output/Office_Plaza/` |
| `--kits-root "Kitbash Assets"` | `output/<KitName>/<AssetName>/` ← preferuj toto |

Pozn.: může existovat **flat i nested** (`output/Office_Plaza` i `output/Manhattan/Office_Plaza`) — do enginu ber **kit cestu**, ať nemáš duplicity.

### Důležité CLI flagy

| Flag | Pro engine |
|---|---|
| `--no-ktx2` | **Povinné** (PNG pro BC7 v enginu) |
| `--max-texture 2048` | Cap albedo; normal/ORM ≤ 1024 |
| `--no-impostor` | Rychlejší cook, jen mesh LODy |
| `--no-lod2-atlas` | lod2 = geometry-only jako lod1 |
| `--shared-textures` | **Zapnuto** v `convert-kitbash*.bat` — kit `_shared/textures/` + external URI |

---

## 8. Checklist pro AI v engine repu

### Musí udělat
1. [x] Asset import: složka s `lod0.glb` (+ siblings).
2. [x] Scéna → `lod0.glb`.
3. [x] Sibling load `lod1` / `lod2` / `lod3` (filename discovery).
4. [x] Material bind: lod1/lod2-without-atlas → textury z lod0 podle **jména materiálu**.
5. [x] Lod2 s `atlas: true` → vlastní materiál (self-contained).
6. [x] PNG decode → BC7 texcache.
7. [x] LodSelector + hystereze + Force LOD debug HUD.
7b. [x] LOD3 MASK: `AlphaCutoff` + `DisableMipmaps` + clamp UV na self-contained (19.07).

### Nesmí dělat
- Decimaci / bake / KTX2 decode v enginu „protože TOOL to umí“.
- Brát `impostor.glb` jako běžný mesh LOD bez octa shaderu.
- Očekávat, že Blender ukáže impostor správně.
- Zapomenout shipnout `Assets/Buildings/<Kit>/_shared/` spolu s budovami.
- Míchat flat `output/Office_Plaza` a nested `output/Manhattan/Office_Plaza` jako dva různé hero assety bez důvodu.

### Až později (impostor)
8. [ ] Načíst `impostor.json` + atlas → BC7.
9. [ ] Octahedral hemi sample shader (`j0_top`).
10. [ ] Distance swap LOD2 → impostor (+ crossfade/dither ideálně).

---

## 9. Pseudokód napojení (engine)

```text
loadAsset(dir):
  manifest = readJSON(dir / "asset.json") optional
  lod0 = loadGLB(dir / "lod0.glb")          // textures here
  lod1 = loadGLB(dir / "lod1.glb")          // geometry only
  lod2 = loadGLB(dir / "lod2.glb")

  bindMaterialsFromLod0(lod1, lod0)
  if manifest.lods[2].atlas:
      bindLod2Atlas(lod2, dir / manifest.lods[2].maps)
  else:
      bindMaterialsFromLod0(lod2, lod0)

  // day-1: ignore impostor.*
  return LodChain(lod0, lod1, lod2, distances=[d0,d1,d2], hysteresis=0.1)

update(camera):
  pick lod level by distance/screen size with hysteresis
  draw only active lod
```

---

## 10. Časté chyby

| Symptom | Příčina |
|---|---|
| lod1/lod2 bílé / černé | Neproběhl bind materiálů z lod0 |
| Obří VRAM / dlouhý load | Cook bez `--no-ktx2` a engine neumí KTX2; nebo zbytečně vysoké textury |
| Impostor = plochý obrázek atlasu | Chybí view-dependent shader |
| Impostor „škaredý zblízka“ | Normální — je pro dálku; tile ≈ atlas/frames px |
| Impostor silueta / moc tmavý | Starý bake (metallic KitBash); rebake novým TOOL |
| Galerie nevidí `Manhattan/...` | Starý gallery server — restart `gallery.bat` (není engine bug) |
| Dva Office_Plaza | Flat vs nested output — vyber jeden |

---

## 11. Kde ověřit cook mimo engine

```bat
gallery.bat
→ http://127.0.0.1:4173
```

Ukazuje seznam z `output/`, LOD tabulku, impostor atlas + orbit preview.  
**Gallery ≠ důkaz že Vulkan shader funguje** — jen že TOOL data existují.

---

## 12. Shrnutí pro AI (zkopíruj do system promptu)

```
You are wiring LOD Messiah cooked assets into a Vulkan engine (Bungáč).

Contract: TOOL cooks offline; engine only loads. No runtime decimation.

Per asset folder (prefer output/<Kit>/<Asset>/):
  LOAD: lod0.glb (mesh+PNG), lod1.glb, lod2.glb, optional asset.json, optional lod2_atlas/
  IGNORE day-1: impostor.*, preview.html, report.json, default.glb, gallery

Rules:
  - Scene references lod0.glb; siblings are LODs
  - lod1 (and lod2 without atlas) = geometry-only; bind materials/textures FROM lod0 by name/order
  - Textures are PNG; engine compresses PNG→BC7 (TOOL uses --no-ktx2)
  - Impostor is hemi-octahedral atlas (j0_top); needs custom shader later — do not treat impostor.glb as normal mesh

Primary docs in TOOL repo:
  docs/AI_ENGINE_WIREUP.md
  docs/ENGINE_HANDOFF_8H.md
```

---

*Poslední sync s pipeline: 2026-07-19. Při změně výstupů aktualizuj tento soubor.*
