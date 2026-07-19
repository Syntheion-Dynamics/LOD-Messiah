# Handoff TOOL ↔ Bungáč Engine — cíl: výsledek do ~8 h

> Datum: 2026-07-19  
> Kontrakt: **TOOL vyrábí LODy, engine jen čte.** Žádný `.lodcache`, žádná decimace v enginu.

## Verdikt na 8 hodin

**Ano, stihnete vidět LOD přepínání ve hře** — pokud nebudete řešit baking, impostory ani KTX2.

| Priorita | Úkol | Kde | ~čas |
|---|---|---|---|
| P0 | Convert Office_Plaza `--no-ktx2 --no-impostor` | TOOL | 15–40 min |
| P0 | Zkopírovat `output/Office_Plaza/` → engine `Assets/…` + scéna → `lod0.glb` | ručně / ty | 10 min |
| P0 | `CURSOR_TASK_lod_config_ui.md` (HUD + Force LOD + lod_settings.json) | engine | 1–2 h |
| P1 | Ověřit v editoru: Force LOD 0/1/2 + auto při oddálení | ty + Claude review | 30–60 min |
| P2 | Střecha AC (volitelně) | Blender | kdykoli |
| ❌ dnes | Atlas/material bake, impostor, KTX2, streaming | — | odlož |

## Co už sedí (nesahat)

- TOOL: `lod0` = mesh + PNG textury; `lod1`/`lod2` = geometry-only, **stejné pořadí/jména materiálů**
- Engine: sibling load + LodSelector + hystereze ±10 % (Claude, build green)
- Engine textury: **PNG → BC7** v texcache — proto **`--no-ktx2`**

## Convert příkaz (engine-ready)

```bash
cd "c:\Users\yukit\Downloads\TOOL"
npm run convert -- --input "Kitbash Assets/Manhattan/Office_Plaza.glb" --output ./output --no-impostor --no-ktx2
```

Pak celou složku `output/Office_Plaza/` (minimálně `lod0.glb`, `lod1.glb`, `lod2.glb`, textury uvnitř lod0) zkopíruj do engine Assets a ve scéně odkaž **jen** `lod0.glb`.

## Baking — potřebuješ ho teď?

**Ne.** Pro 8h demo:

- Engine už „bakeuje“ kompresi textur (PNG→BC7) při loadu.
- Blender **material atlas bake** (33→1) je pořád rizikový / vypnutý default — **neblokuje**.
- **Lepší je víc materiálů (2–3+ tiling)** než 1 atlas: sdílené fasády napříč budovami = méně VRAM. TOOL material-merge jen dedupuje stejné sety; nesráží násilně na 1.

Až později (ne dnes): atlas/remesh jen pro LOD2 proxy nebo HLOD bloků.

## Impostory

Odloženo v LOD_PLAN v2. Gallery preview ≠ day-1 ve Vulkanu. Nejdřív LOD chain ve scéně.

## Cursor task (engine)

Soubor už je:  
`Documents/PROJEKT X/Programming Projects/GTA/CURSOR_TASK_lod_config_ui.md`

To je **engine UI** (ne TOOL). Až doběhne → Claude review → pípni.

## Pořadí „za 8 hodin“ (checklist)

1. [ ] TOOL convert Office_Plaza (`--no-ktx2 --no-impostor`)
2. [ ] Copy do `Assets/` + scéna odkazuje `lod0.glb`
3. [ ] Cursor: lod_settings + HUD + Force LOD (task výše)
4. [ ] Otevřít editor: vidět LOD: x/y/z v HUD, Force LOD 2 zjednoduší model
5. [ ] (volitelně) vyhodit klimatizace na střeše — LOD2 stejně sežere detaily

## Co NEdělat dnes

- Celý KitBash folder s KTX2 (trvá věčnost, engine KTX2 neumí)
- `--atlas` bake
- Impostor shader ve Vulkanu
- Memory streaming (až po viditelném LOD)

## Rychlá odpověď na „3 materiály vs 1“

**3 (nebo víc tiling) > 1 atlas** pro KitBash město na 4070. Jedna atlas textura per budova zabíjí sdílení. Nech multi-material + PNG→BC7 v enginu.
