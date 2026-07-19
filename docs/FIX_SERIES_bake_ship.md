# FIX SERIES — od „456 MB lod0" k „hoď to do enginu"

> Datum: 2026-07-19. Diagnóza z reálných výstupů v `output/` + zdrojů v `Kitbash Assets/`.
> LOD chain (geometrie) funguje a NESAHÁ se do něj. Tohle řeší textury, velikost výstupu,
> impostory a engine-ready kontrakt.

## Diagnóza (změřeno, ne dojmy)

| Fakt | Číslo | Důsledek |
|---|---|---|
| Office_Plaza zdroj | 92 textur PNG, všechny 2048px, 425 MB | `--max-texture 2048` = no-op, nic nezmenší |
| `lod0.glb` | 456 MB | nepoužitelné pro engine/město |
| `pack.glb` | 456 MB — **kopie lod0** | zdvojený disk, žádná přidaná hodnota |
| `_source.glb` v output | 467 MB — kopie zdroje od impostor bakeru | + `_bake.html`, `_bad_*.bin` bordel |
| Impostor u těžkých assetů | tiché `null`, žádný error | baker dostává 456MB GLB → Puppeteer OOM/timeout |
| KB3D_MIM_* textury | stejné napříč kitem | každá budova je embeduje znovu → N× duplicity |
| `--kits-root` stem | `Kitbash Assets__Manhattan__Office_Plaza` | duplicitní 1,3GB výstup vedle `Office_Plaza` |

Klíčové: **VRAM po BC7** = 2048² ≈ 5,3 MB/texturu s mipy. 92 unikátních textur ≈ 490 MB
VRAM na JEDNU budovu, pokud se nesdílí. Sdílení KB3D textur napříč kitem je páka č. 1,
ne atlas per budova (ten sdílení zabíjí — viz vlastní research brief).

---

## P0 — dnes večer (cíl: budova v enginu, rozumná velikost)

### 1. Sdílená texturová knihovna per kit (největší páka)
- Při cooku extrahovat textury z GLB do `output/_textures/<hash>.png` (dedup podle
  SHA-1 obsahu — hash už počítá `material-merge.js`).
- `lod0.glb` odkazuje textury **externí URI** (`../_textures/<hash>.png`) místo embedu.
- Efekt: lod0 klesne z 456 MB na ~5–15 MB mesh; textury se platí **jednou za kit**,
  ne jednou za budovu. Disk i load time řádově dolů.
- ⚠️ OVĚŘIT: Bungáč loader musí umět glTF external image URI. Pokud ne → fallback:
  nechat embed, ale engine texcache dedupovat podle content-hashe (engine-side mini fix).
  Ověření = 15 min test s jedním GLB dřív, než se to nasadí všude.

### 2. Per-typ texture cap (druhá páka, funguje i bez enginu)
`--max-texture` je dnes jeden globální limit a na 2048px zdrojích nic nedělá. Rozdělit:
- basecolor/emissive: 2048 (kvalita na blízko)
- **normal: 1024** (největší žrouti, 8 MB/ks; po BC7 rozdíl na budově neuvidíš)
- ORM/metallic-roughness/occlusion: 1024
- Implementace: v `resizeTexturesSafe` rozlišit slot podle toho, kde je textura
  napojená (API `listParents` → Material slot), cap per slot. ~30 min práce.
- Efekt bez sdílení: 456 MB → ~150–180 MB. Se sdílením: kit celkem ~150 MB textur.

### 3. Zrušit `pack.glb`, metadata do `asset.json`
- `writePackGlb` smazat / za flag. Metadata (lodFiles, impostor, triangles) zapsat do
  `asset.json` vedle GLB — engine kontrakt na sidecar už existuje.
- Efekt: −456 MB na budovu, okamžitě.

### 4. Uklidit output
- `_source.glb`, `_bake.html`, staging impostoru → **workDir**, ne outDir
  (octahedral.js dnes stageuje do outDir a neuklízí).
- `_bad_*.bin` — dohledat, kdo je zapisuje, a přesunout/zrušit.
- Fix `assetStem` pro `--kits-root`: výstup `output/<Kit>/<Asset>/`, žádné
  `Kitbash Assets__...` duplicity.

### 5. `default.glb` — plnokvalitní model v kontraktu
- Po merge+resize (před decimací) zapsat `default.glb` = plná geometrie, ošetřené
  textury. Pro hero záběry / editor placement. Je to jen `io.write` navíc v místě,
  kde už dokument existuje. Přidat do `asset.json` (`"default": "default.glb"`).
- LOD0 zůstává ratio 0.5 pro běžný runtime; engine si vybere.

## P1 — impostor spolehlivě (zítra večer)

### 6. Impostor péct z LOD0 výstupu, ne z full zdroje
- Dnes: `impostorSourceGlb` = merged full-res GLB (456 MB) → Puppeteer umírá.
- Fix: péct z **hotového `lod0.glb`** (po resize/sdílení ~des. MB, textury má).
  Silueta i barva pro 341px/view atlas bohatě stačí.
- K tomu úkoly z `CURSOR_TASK_impostor_baking.md`:
  - chybu NEpolykat — `err.stack` do konzole, `report.impostor = {ok:false, reason}`;
  - Puppeteer launch args `--enable-webgl --use-gl=swiftshader` (headless bez GPU);
  - delší timeout + render po snímcích.
- Ověření: impostor.glb + atlas vznikne i pro abandoned_building (295k tris)
  a coffee_shop; `npm run gallery` orbit vypadá jako budova.

### 7. Impostor v `asset.json` kontraktu
- `"impostor": { file, atlas, frames, hemi, resolution }` — engine ho zatím nečte,
  ale až se ve Vulkanu napíše octahedral shader (engine task, ne TOOL), data už čekají.

## P2 — skutečný texture bake (víkend, NE dnes)

### 8. Atlas bake JEN pro LOD2 (+ impostor tier)
- lod0/lod1: nechat tiling multi-material + sdílené textury (správně per research brief
  — atlas per budova zabíjí sdílení a VRAM).
- lod2: unikátní UV (xatlas) + zapéct výsledný vzhled do **jednoho 1024px atlasu**
  per budova. Z dálky tiling detail nikdo nevidí; lod2 přestane záviset na lod0
  materiálech → jednodušší streaming vzdálených bloků.
- Tohle je odpověď na „lody s baknutými texturami": bake tam, kde dává smysl (dálka),
  tiling tam, kde je kvalita (blízko).

### 9. `--atlas` (join-all Blender bake) — zrušit
- Nespolehlivý, QC ho zamítá, a i kdyby fungoval, je to špatný cíl (viz 8).
  Neopravovat, smazat cestu, míň kódu na údržbu.

## Pořadí exekuce dnes

1. [x] Fix 2 (per-typ caps) + Fix 3 (asset.json místo pack.glb) + Fix 4 (úklid) — ~1,5 h
2. [x] Fix 5 (default.glb) — ~20 min
3. [x] Ověřit externí URI v enginu (15 min test) → Fix 1 — ~1–2 h
4. [x] Přecookovat Office_Plaza → zkopírovat do enginu → LOD přepínání ve hře
5. [ ] Zítra: Fix 6+7 (impostor)

## Co se NEMĚNÍ

- LOD kontrakt: `lod1/2.glb` geometry-only, stejné pořadí materiálů. Platí dál.
- `--no-ktx2` pro engine (PNG→BC7 v texcache). Platí dál.
- Zdrojové kity se nikdy nepřepisují.
