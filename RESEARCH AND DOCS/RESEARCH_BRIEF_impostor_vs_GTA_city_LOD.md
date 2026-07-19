# RESEARCH BRIEF — Distant city LOD: „GTA styl“ vs hemi-okta impostory (Fortnite/Brucks)

> **Účel:** podklad pro deep-research agenta. Cíl = rozhodnout, jestli pro Vulkan city engine „Bungáč“ (KitBash budovy, GTA-škála, street + helicopter pohledy) zůstat u **hemi-oktaedrálních impostorů per budova**, nebo jestli je „GTA feel“ lepší řešit **jinou distant reprezentací** (mesh LOD + proxy/HLOD + streaming/cull), případně hybrid.  
> **Datum:** 2026-07-19  
> **Výstup** pak člověk/Claude zreviduje a překlopí do TOOL change listu + engine roadmapy.

---

## Kontext — co UŽ máme (NEřešit znovu jako open question)

- **Engine:** C# + Vulkan (Silk.NET), open-world město, street-level kamera (GTA styl). Cíl ~3440×1440 @ 60 FPS, RTX 4070 třída.
- **TOOL (LOD Messiah):** offline peče `lod0/1/2.glb` (meshopt) + **hemi-oktaedrální impostor atlas** (`impostor_atlas.png`, `impostor.json`, billboard quad). Bake: Puppeteer/Three, ortho, 2× SS, unlit flatten + sky glass. Default často 16×16 @ 4096².
- **Už hotový research:** `Research_impostoru_a_HLOD_pro_Vulkan_city_engine/` — uzavírá: hemi-okta je průmyslově validní; hlavní gap = **Vulkan runtime shader** + TOOL gutters/premult/meta; HLOD bloky = fáze 2.
- **Engine dnes:** LOD0–2 swap (distance/screen-size plán); **impostor shader ještě NENÍ**. Day-1 handoff impostor vědomě skipuje.
- **Obsah:** KitBash hard-surface budovy (statické), mix hero + filler; sdílené moduly napříč městem.

## JÁDRO problému (celý research se točí kolem tohoto)

Autor má dojem: „Fortnite impostory jsou na stromy / cartoon — nechci Fortnite look, chci **GTA**. Není lepší to dělat à la GTA a impostory zahodit?“

**Hlavní otázka:** Co z veřejně doložených AAA pipeline **skutečně** tvoří GTA-like distant city (silueta skyline, pop-in, streaming, LOD), a jaká část z toho je (a) mesh LOD chain, (b) merged/proxy HLOD, (c) image impostor, (d) occlusion/streaming — a co z toho má smysl pro **solo + KitBash + už existující hemi-okta bake**?

**Není otázka:** „Je Fortnite hezký?“ Ani „zkopíruj RAGE“ (RAGE building-impostor detaily jsou **neveřejné** — to explicitně říct a neodhadovat).

---

## Co přesně nastudovat

### A) Co je veřejně známé o „GTA / RAGE“ distant world
1. Co Rockstar / Courrèges / GDC / rozhovory **opravdu** říkají o LOD, streamingu, draw distance, pop-in (letiště/auta vs chůze).
2. Co je **neznámé** (building impostor formát, HLOD math, atlas layout) — seznam unknowns, žádné spekulace maskované jako fakta.
3. Co hráči/teardowny pozorují (nízké LODy, soft siluety) vs co jde citovat jako studio tech.

### B) Co je veřejně známé o Fortnite / Impostor Baker
1. Scope: **stromy/foliage** při vypnutém Nanite; 12×12, 2048, upper hemisphere, 3-frame blend — citace Epic docs.
2. Oddělit: **math/runtime pattern** (použitelný i na budovy) vs **art direction / use case** (stromy ≠ fasády).
3. Kde hemi-okta na **budovách** selhává (swim u pólu, tvrdé hrany, waste texelů u tall AABB, absence parallaxu) — s citacemi / měřitelnými artefakty.

### C) City-scale reference, které JSOU doložené (priorita nad GTA spekulací)
1. **AC Unity / Anvil** — GPU-driven, modular buildings, cluster cull (SIGGRAPH 2015).
2. **UE City Sample / World Partition HLOD** — merged/simplified/approximated layers, Impostor-as-MaxLOD.
3. **Avalanche / Just Cause** (pokud veřejné) — LOD grid, instancing, alpha cards.
4. Případně Simplygon/InstaLOD „building proxy / aggregation“ — co pečou místo okta atlasu.

### D) Rozhodovací matice pro NÁŠ case (KitBash, Vulkan, TOOL už peče okta)
Pro každou distant strategii spočítat / odhadnout (s jistotou):

| Strategie | Silueta 300–800 m | VRAM / unikátní budova | Draw cost @ 5–20k | Authoring cost (TOOL) | Helicopter / střechy | Denní cyklus / relight |
|---|---|---|---|---|---|---|
| A. Zůstat hemi-okta per budova (+ doražit shader/gutters) | | | | | | |
| B. Drop impostorů; jen agresivní LOD2 + cull | | | | | | |
| C. LOD2 + **merged HLOD bloky** (1 proxy/blok), bez per-asset impostoru | | | | | | |
| D. Hybrid: okta jen hero/skyline; filler = cheap mesh/proxy | | | | | | |
| E. Klasické multi-card billboardy (GTA-era vibe) | | | | | | |

### E) „GTA feel“ checklist — co impostor NEřeší
Explicitně oddělit systémy, bez kterých město „nepůsobí jako GTA“ i s perfektním atlasem:
- streaming / cell residency
- occlusion (HZB / occluders)
- screen-size LOD + hysterese + dither
- shared materials / instancing
- HLOD na >1–2 km

Research musí říct: **které 2–3 položky mají vyšší prioritu než výměna impostor math.**

### F) Validace vůči našemu bake
1. Je 16×16 @ 4096² pro budovy overkill vs Fortnite 12×12 @ 2048?
2. Stačí unlit albedo v1, nebo je pro GTA denní cyklus GBuffer bake nutný dřív?
3. 3-frame barycentric vs 2×2 bilinear — dopad na budovy (ghosting na rovných fasádách).

---

## Co chceme jako VÝSTUP (použitelné, ne esej)

1. **Verdikt ≤ 15 řádků:** zůstat / dropnout / hybrid — s jednou doporučenou roadmapou (týden / měsíc / později).
2. **Tabulka „GTA vs Fortnite vs naše“:** co z čeho brát (math, streaming, HLOD), co ignorovat.
3. **Explicitní unknowns** (RAGE atd.) — oddělená sekce.
4. **Rankované strategie A–E** s pro/proti pro solo + existující TOOL.
5. **Minimální TOOL + engine change list**, pokud verdikt = „zůstat u okta“ nebo „hybrid“.
6. **Citace primárních zdrojů** (Epic docs, SIGGRAPH PDF, Courrèges, JCGT) — žádné „studia obvykle…“ bez odkazu.

## Tvrdá omezení

- Solo / malý tým; **offline bake v TOOL**, engine jen čte.
- Žádný Nanite-from-scratch jako v1.
- KitBash = **statické** budovy; helicopter pohledy **ano** (hemi-okta relevantní; pure side-billboard slabý).
- Neodhadovat interní RAGE building pipeline.
- Nehodnotit „jestli je Fortnite cool“ — jen technickou přenositelnost patternu.
- Preferovat zdroje 2015–2026; u GTA V grafiky OK i starší Courrèges, ale oddělit observation vs engine fact.

## Vstupní materiály (agent má přečíst nejdřív)

- `RESEARCH AND DOCS/Research_impostoru_a_HLOD_pro_Vulkan_city_engine/Research_impostoru_a_HLOD_pro_Vulkan_city_engine.md`
- `RESEARCH AND DOCS/Research_KitBash_mesto_LOD.md`
- `docs/AI_ENGINE_WIREUP.md` (kontrakt impostoru)
- `src/octahedral.js` (co TOOL reálně peče: hemi, j0_top, 2×2 blend v preview, bez gutterů)

## Anti-cíle (NEpsát)

- Tutoriál „jak napsat octa shader od nuly“ (to už research 1 má).
- Nanite reverse-engineering.
- Srovnání art style Fortnite vs GTA.
- Doporučení koupit Simplygon jako jedinou odpověď bez open/tooling alternativy.
