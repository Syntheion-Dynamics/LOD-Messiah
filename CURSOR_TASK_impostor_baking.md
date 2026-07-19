## Stav (2026-07-19 večer)

**HOTOVÉ.** Pipeline peče z `lod0_embedded` (PNG), chyby jdou do `report.impostor` /
`asset.json`, Puppeteer row-by-row + Angle/D3D11. Ověřeno:
`coffee_shop_building`, `abandoned_building_polygraphenwerk_leipzig`, `free_london_skyscraper`.

---

# CURSOR TASK — dodělat impostor baking (STŘEDNÍ priorita)

> **Kontext:** LOD pipeline (`lod0/1/2.glb`) funguje. Chybí spolehlivý **octahedral impostor
> baking** (dálková placka na 2 trojúhelníky). Bez něj těžké KitBash budovy zabijí skyline
> (mají topology floor — střední LODy málo redukují). Engine impostor zatím NEkonzumuje
> (odloženo engine-side), ale výstup musí sedět ve složce assetu, ať je na to engine připravený.

## Symptom (repro)

`npm run convert -- -i ./abandoned_building_polygraphenwerk_leipzig.glb -o ./output`
→ `output/<name>/report.json` má `"impostor": null` a **žádný error/reason**. `impostor.glb`
se nevygeneruje. Lehčí assety (Office_Plaza, free_london_skyscraper) impostor dostanou,
těžké (abandoned ~295k tris, coffee_shop) NE. Chyba se tiše spolkne.

Soubory: `src/impostor.js`, `src/octahedral.js` (Puppeteer/Three headless render), volané
z `src/pipeline.js`. Podezření: Puppeteer crash / timeout / GPU-memory na high-tri meshi.

## Úkoly (v pořadí)

1. **Zhlasitit chybu.** V `pipeline.js` kolem volání impostoru: chybu NEspolkni —
   zaloguj celý `err.stack` do konzole a zapiš `report.impostor = { ok:false, reason:<msg> }`
   místo tichého `null`. (Teď nevíme, proč to padá — tohle je první krok.)
2. **Diagnóza z logu.** Pusť na `abandoned_building` a `coffee_shop`, přečti reálnou chybu.
   Pravděpodobné příčiny: Puppeteer `Target closed` / OOM při nahrání 295k tris do Three,
   `page.evaluate` timeout, headless WebGL kontext bez GPU. Podle toho:
   - timeout → zvětši `page.setDefaultTimeout` + rozděl render po snímcích (12×12 grid).
   - memory → před renderem impostoru použij **lod2** (nejhrubší) místo full mesh — na
     silhouettu/atlas stačí, ušetří to VRAM v headless prohlížeči.
   - WebGL kontext → `--enable-webgl --use-gl=swiftshader` do Puppeteer launch args (SW render).
3. **Ověření.** `impostor.glb` + `impostor_atlas.png` + `preview.html` vzniknou i pro těžké
   assety; `npm run gallery` → orbit impostoru vypadá jako budova z dálky (ne rozbitá placka).

## NEDĚLAT / pravidla

- ❌ Nesahat do enginu (`../GTA/...`) — tohle je čistě TOOL-side.
- ❌ Neměnit LOD kontrakt: `lod1/2.glb` zůstávají geometry-only, stejné pořadí materiálů.
- ✅ Engine cesta jede `--no-ktx2` (PNG→BC7 v enginu). Impostor atlas taky PNG, ne KTX2.
- ✅ Když impostor fakt nejde, pipeline **pokračuje** (LODy jsou důležitější) — jen to
  hlasitě zapíše do reportu, ne tiché `null`.
