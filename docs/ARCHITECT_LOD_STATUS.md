# Stav LOD Messiah → Bungáč (pro architekta)

> Datum: 2026-07-20 (LOD3 **slicecards** nasazeno — silueta z výškových pásů + promítnuté fotky; boxcards zůstal jako fallback)  
> Ty nejsi programátor — tohle je mapa „co máme / kde klikat / co ještě bolí“.  
> **Důležité zjištění z Blenderu:** LOD2 vypadá bíle (bez textur) = OK u geo-only. Okna na LOD0/1/2 = glass-safe simplify (§4.2).

---

## 1. Jednou větou

Kitbash se **peče offline** v TOOL. Hra jen načte hotové soubory.  
**LOD3 = slicecards**: silueta budovy z výškových pásů (křídla / věž / nástavba každé svou výšku a půdorys) a na ni **promítnuté ortho fotky** podle směru stěny (stejný 3×2 MASK atlas jako boxcards). Když extrakce selže, spadne to na starý AABB box. Typicky 30–350 tris.  
Vzorky: **Office_Plaza** + **Brooklyn_Luxury_Flats** (připečené). QC: Blender orbit → Force LOD 3 ve hře.

---

## 2. Kde co hledat

### TOOL (vařič)
Kořen: `C:\Users\yukit\Downloads\TOOL`

| Co | Cesta |
|---|---|
| Koupené zdroje | `Kitbash Assets\` (Brooklyn, Every City, Manhattan, …) |
| Uvařené výstupy | `output\<Kit>\<Asset>\` např. `output\Manhattan\Office_Plaza\` |
| Náhled ve webovce | `gallery.bat` → http://127.0.0.1:4173 |
| Cook 1 budovy | `convert-kitbash.bat` *(už boxcards + bez legacy impostoru)* |
| Cook celý kit | `convert-kitbash-all.bat` |
| Jen LOD3 znovu (rychlé) | `rebake-lod3-kitbash.bat Manhattan` |
| Kopíruj do hry | `ship-to-engine.bat Manhattan\Office_Plaza` |
| Návod pro AI enginu | `docs\AI_ENGINE_WIREUP.md` |
| Tento stav | `docs\ARCHITECT_LOD_STATUS.md` |
| Starý impostor / hull | `legacy\` (opt-in, default off) |

### Co je ve složce assetu (příklad Office_Plaza)

```
output\Manhattan\Office_Plaza\
  default.glb     ← plná kvalita před ořezem (těžké; do hry se nekopíruje)
  lod0.glb        ← runtime blízko (mesh + textury)
  lod1.glb        ← střední vzdálenost (jen geometrie)
  lod2.glb        ← dál (jen geometrie u našeho cooku)
  lod3.glb        ← silueta z výškových pásů + promítnutý atlas (slicecards, ~30–350 tris)
  lod3_atlas\     ← albedo (RGBA, A = coverage)
  asset.json      ← seznam LODů + blok "lod3": { backend: "slicecards", slices: N }
  report.json     ← QA čísla
```

### Engine (hra) — jen když shipneš
`…\GTA\Assets\Buildings\Manhattan\Office_Plaza\`  
Scéna: objekt `Office_Plaza_LOD` → `Buildings/Manhattan/Office_Plaza/lod0.glb`

### Otevřít v Blenderu (bez enginu)
File → Import → glTF → vyber `lod0.glb` / `lod1.glb` / `lod2.glb` / `lod3.glb` / `default.glb`.

---

## 3. Co máme hotové (funguje jako systém)

| Věc | Stav | Poznámka |
|---|---|---|
| Cook LOD0/1/2 geometrie | ✅ | meshoptimizer, poměry ~0.5 / 0.3 / 0.1 |
| Per-typ resize textur | ✅ | albedo ≤2048, normal/ORM ≤1024 |
| `asset.json` místo obřího pack.glb | ✅ | |
| Ship script do Assets | ✅ | day-1 bez default/impostor |
| Engine: načte lod0 + sourozence | ✅ | Force LOD 0/1/2/3 v DEBUG |
| Engine: lod1 bere textury z lod0 | ✅ | podle jména materiálů |
| LOD3 slicecards (silueta pásů + MASK) | ✅ | 20.07 — nahradilo boxcards jako default; boxcards = fallback. Engine kontrakt beze změny |
| Engine MASK cutout pro LOD3 | ✅ | bez mipů + clamp UV na self-contained |
| Octahedral impostor bake | ⏸ legacy | v `legacy\`; default cook **vypnutý** (čeká Vulkan shader) |
| Celý Kitbash uvařený | ❌ | jen vzorky (Office_Plaza, Energy_Office, …) |
| Shared textury napříč kitem | ❌ | default off (každá budova nese vlastní PNG) |

---

## 4. Důležité bugy / nedorozumění (okna + bílé LOD1/2)

### 4.0 LOD1 (a geo-only LOD2) — textury ve hře ANO, v souboru NE

> **K potvrzení architektem** — kontrakt, ne dojem z Blenderu.

| | Blender (import `lod1.glb`) | Engine (Force LOD 1) |
|---|---|---|
| Textury v souboru | Nejsou (geometry-only) | — |
| Viditelný vzhled | Bílá / clay | **Má mít textury z LOD0** |

**Jak to engine dělá:**

1. Načte `lod0.glb` → mesh + všechny textury.  
2. Načte `lod1.glb` → jen hrubší mesh, **stejná jména** materiálů.  
3. Při kreslení LOD1: „slot Sklo = textura ze stejného slotu u LOD0“.

```text
Disk:   lod0 = mesh + textury
        lod1 = jen mesh   (schválně malý soubor)

Hra:    LOD1 mesh + textury z LOD0  →  otexturovaná budova
```

Blender **neumí** „půjč textury z vedlejšího GLB“ — proto LOD1 v Blenderu vypadá líp tvarem, ale bez fasády.  
To **není** důkaz, že ve hře bude LOD1 bez textur.

**LOD2:**

- `atlas: false` (např. Office_Plaza) → stejné jako LOD1 (bílá v Blenderu, textury ve hře z LOD0).  
- `atlas: true` (`Lod2AtlasMesh`) → vlastní ošklivější atlas **v** souboru; v Blenderu texturu vidíš, ve hře ji **nesdílí** s LOD0.

- [ ] **Architekt potvrzuje:** LOD1 ve hře má brát textury z LOD0; bílá v Blenderu = OK / očekávané.  
- [ ] **Architekt potvrzuje:** QC LOD1 = Force LOD 1 v enginu (ne import `lod1.glb` do Blenderu).

### 4.1 LOD2 v Blenderu — bílá vs atlas

U Office_Plaza má `asset.json`:

```text
lod2: atlas: false
note: geometry-only; materials from lod0
```

**Znamená to:** v `lod2.glb` **nejsou** textury (schválně, ať je soubor malý).  
V Blenderu vedle sebe: LOD0 barevný, LOD2 bílý clay = **normální** pro tenhle cook.

**Ve hře** má engine natáhnout materiály/okna z LOD0 na stejná jména slotů.  
Když v Blenderu chceš vidět LOD2 s texturami, musíš buď:

- zapnout LOD2 atlas cook (`lod2_atlas`, self-contained), **nebo**
- dívat se v gallery / v enginu, ne čekat textury uvnitř `lod2.glb`.

→ **Akce:** nerozhodovat „LOD2 je mrtvý“ jen z bílého Blenderu. Ověřit ve hře Force LOD 2 **nebo** přecook s atlasem.

### 4.2 LOD0/1/2 ztrácí okna — opraveno (glass-safe simplify na všech LODech)

**Příčina:** meshopt decimace mazala tenké okenní plošky (Kitbash glass/emissive primitiva). UV protect nestačil. Dřív se chránilo jen LOD0/1 → LOD2 zůstával dutý (~42k tris bez skla). Starý cook bez `glassQc` / LOD0 ~127k tris = neplatný pro QC oken.

**Oprava:** Při simplify **všechny LOD0/1/2 přeskakují** primitiva se sklem / emissive (`glass|window|curtainwall` ve jméně, nebo emissive mapa/factor). QC v `report.json` → `glassQc` počítá glass tris na **LOD0 + LOD1 + LOD2** (warn pod 95 % na kterékoli úrovni; u atlas LOD2 se bere počet po simplify, před sloučením materiálů).

**Office_Plaza (přecook 19.07):** `glassQc` 91 780 → 91 780 na LOD0/1/2 (100 %). LOD2 ~126k tris (ne ~42k). Cook: `--no-lod2-atlas` (geo-only; textury ve hře z LOD0).

→ **Akce:** v Blenderu porovnej `default` vs `lod0/1/2` — skleněné plošky musí zůstat (ne průhledný skelet). Ve hře Force LOD 0→2.

---

## 5. LOD3 = boxcards (varianta A) — hotovo 19.07 večer

| | |
|---|---|
| Co to je | **6 quadů** na stěnách AABB (±X ±Y ±Z), každá = ortho fotka plného meshe |
| Proč | Dutá Kitbash skořápka / podlaha / římsy **nevadí** — nefotíme geometrii, fotíme vzhled zvenku |
| Tris | vždy **12** (6×2) |
| Materiál | `Lod3SilhouetteMaterial`, `MASK`, cutoff `0.5` |
| Atlas | jeden `lod3_atlas/albedo.png` (mřížka 3×2 + padding) + embedded v GLB |
| `asset.json` | `"lod3": { "backend": "boxcards", "alphaMode": "MASK", … }` |
| Engine | stejný MASK kontrakt jako dřív — **neměnit** loader kvůli boxcards |
| Starý hull/slice | `legacy\lod3-silhouette\` (nepoužívat) |

**Co máš vidět v Blenderu:** krabice ze **všech** stran (ne jedna placka). Z ~45° uvidíš hrany karet — to je očekávané u A.

**QC vzorky teď:**
1. `output\Manhattan\Office_Plaza\lod3.glb`
2. `output\Brooklyn\Brooklyn_Luxury_Flats\lod3.glb` (dřív rozbitá silueta)

Pak `ship-to-engine.bat …` → Force LOD 3. Když stará textura: smaž `.cache\texcache`.

### 5.1 Rozhodnutí — **A přijato a uvařeno**

Dřívější volby B/C/D zůstávají v historii; default cook je **A**.  
Engine práce navíc: **0** (MASK už umí). Octa impostor = později, ne day-1.

### 5.2 Bat soubory (root TOOL) — už nastavené

| Bat | Co dělá |
|---|---|
| `convert-kitbash.bat` | 1 budova: LOD0/1/2 + LOD3 boxcards, **bez** impostoru |
| `convert-kitbash-all.bat` | celý kit / jeden kit |
| `rebake-lod3-kitbash.bat` | **jen** LOD3 (když už máš `default.glb`) — řádově sekundy/budova |
| `ship-to-engine.bat` | kopie do Assets |

Rychlost (bez velké investice):
- Jen LOD3: `rebake-lod3-kitbash.bat Manhattan` (ne celý convert)
- Nižší atlas: `set LOD3_RES=1024` před batem (default 2048)
- Paralel: `set LOD3_JOBS=3` / `CONVERT_JOBS=7`

---

## 6. Co ještě není dořešené (backlog pořadí)

### Musí dřív než „celé město z Kitbashe“

1. ~~**LOD0/1/2 okna**~~ — ✅ glass-safe.  
2. **LOD2 vizuál** — Force LOD 2 v enginu.  
3. ~~**LOD3 strategie**~~ — ✅ **A boxcards** uvařeno; QC + re-ship Office_Plaza / Brooklyn.  
4. **Shared textury per kit** — jinak VRAM.  
5. Cook + ship dalších budov po jedné.

### Později

- Octahedral shader ve Vulkanu  
- Memory / streaming  
- Prefab/block-fill s LODy  
- Celý Manhattan/Brooklyn batch
- Coverage-preserving alpha mips (teď cutout = bez mipů, ostré okraje)

### Záměrně ne teď

Pouštět engine „jen vyzkoušet“ těžký lod0, když stačí Blender — cache se zbytečně plní (smazatelná: `.cache\texcache`, ale zdržuje).  
Po re-shipu LOD3: když vidíš starou siluetu, smaž texcache pro ten asset / celý `.cache\texcache`.

---

## 7. Rychlý checklist „je asset OK?“

V Blenderu na jedné budově:

| Soubor | Čekáš |
|---|---|
| `default.glb` | Plná krása + okna (referencia) |
| `lod0.glb` | Skoro jako default, **okna musí zůstat** |
| `lod1.glb` | Hrubší tvar, v Blenderu často bez textur = OK |
| `lod2.glb` | Ještě hrubší; bílá v Blenderu = OK pokud `atlas: false` |
| `lod3.glb` | **6 placek** (krabice) + **MASK**; ze všech stran; z 45° hrany karet = OK |

V gallery: LOD tabulka + velikosti.  
Ve hře (až budeš chtít): Force LOD 0→3.

---

## 8. Shrnutí pro tebe

- **LOD3 = boxcards (A)** — 6 placek + fotka strany; kontrakt MASK stejný pro engine.  
- **Vzorky hotové:** Office_Plaza + Brooklyn_Luxury_Flats → Blender orbit → ship → Force LOD 3.  
- **Okna LOD0/1/2:** glass-safe. QC textur LOD1 = Force LOD v enginu (§4.0).  
- Další krok: re-ship vzorků + shared textury / další budovy po jedné.

---

## 9. Checklist potvrzení architekta

| # | Tvrzení | Potvrzeno |
|---|---|---|
| A | LOD1 v `lod1.glb` nemá textury schválně; ve hře je bere z LOD0 | [ ] |
| B | Bílá LOD1/LOD2 (geo-only) v Blenderu ≠ bug | [ ] |
| C | QC textur LOD1 = editor Force LOD 1, ne Blender import | [ ] |
| D | LOD2 s atlasem (`Lod2AtlasMesh`) má vlastní bake — může vypadat hůř než LOD1 | [ ] |
| E | Glass-safe LOD0/1/2: okna zůstávají (`glassQc` ≥95 % na všech) | [ ] |
| F | LOD3 = boxcards (6 placek); z 45° smí být „karty“ | [ ] |

Datum potvrzení: __________   Podpis / poznámka: __________

---

## 10. Bugbot review engine (19.07.2026) — co našel a jak se to opravilo

Review necommitnutých LOD změn v Bungáči (Composer / Bugbot). Tři nálezy, všechny opravené ve stejném dni.

### 9.1 Editace materiálů při Force LOD 3 → pád / špatná textura (high)

**Co se stalo:** Když budova ukazuje LOD3 (silueta má třeba 1 materiál), editor pořád čísluje sloty podle LOD0 (desítky materiálů). Úprava slotu šla do „právě zobrazených“ GPU materiálů → crash (`ArgumentOutOfRange`) nebo přepis siluety.

**Oprava:** Mutace materiálů (`UpdateMaterialSlot`, UV/PBR/alpha, `EnsureInstanceOwnsMaterials`) vždy cílí na **LOD0 sadu**. Self-contained LOD3 bundle se při editaci nepřepisuje; po návratu na LOD0/1/2 platí změny normálně.

**Soubory:** `Engine.RHI/Vulkan/VulkanRenderer.cs`

### 9.2 Force LOD 3 → Auto → pád (high)

**Co se stalo:** DEBUG umí Force LOD 3. Starší `lod_settings.json` má jen 2 prahy (LOD0→1, LOD1→2). Po vypnutí Force hystereze sahala na `thresholds[2]` → `IndexOutOfRangeException`.

**Oprava:** `LodSelector` při kroku dolů z úrovně za polem prahů **neindexuje mimo** — rovnou o jednu úroveň níž (bez hystereze), dokud nesedí na auto-cíli. Unit test: Force 3 + 2 prahy → Auto konverguje na LOD2 bez crash.

**Soubory:** `Engine.RHI/LodSelector.cs`, `Engine.Core.Tests/LodSelectorTests.cs`

### 9.3 Rozbitý prostřední lodN → lod3 se nenačetl (medium)

**Co se stalo:** Když `lod2.glb` existoval, ale selhal (špatný atlas / jména materiálů), loader **ukončil celý řetězec** — platný `lod3.glb` vedle na disku se vůbec nezkoušel.

**Oprava:** Selhání jedné úrovně = warning + **placeholder** (geometrie z předchozí úrovně, ať index = číslo souboru), pak se zkouší další `lodN.glb`. Lod3 tedy projde i když lod2 je rozbitý.

**Soubory:** `Engine.Core/Assets/MeshLoader.cs`

### 9.4 Co z toho plyne pro tebe

- Force LOD 0→3 a zpět na **Auto** by už nemělo shodit editor.  
- Editace materiálů budovy při zapnutém Force LOD 3 by neměla padat ani kazit siluetu.  
- Stále platí §4–§6: glass-safe cook + Force LOD QC textur; runtime pády výše jsou opravené.

---

## 11. Engine + LOD3 boxcards (kontrakt beze změny)

TOOL peče boxcards; engine dál jen MASK cutout (bez mipů, clamp UV).

### Co TOOL peče
- `lod3.glb` — 6 placek, 1 materiál `Lod3SilhouetteMaterial`, `MASK` / `0.5`
- `lod3_atlas/albedo.png` + embedded
- `asset.json` → `"lod3": { "backend": "boxcards", "alphaMode": "MASK", … }`

### Co engine dělá (beze změny oproti v2 MASK)
| Věc | Proč |
|---|---|
| MASK + cutoff | díry ve vzduchu, ne černý box |
| Bez mipmap u cutout | mipy ředí alpha |
| Clamp UV | padding mezi dlaždicemi; bez REPEAT bleedu |

### Jak ověřit
1. Blender: import `lod3.glb` — **krabice ze všech stran**, ne jedna placka.  
2. Editor: Force LOD **3**.  
3. Stará textura → smaž `.cache\texcache`.

Detail: `docs\AI_ENGINE_WIREUP.md` §4.5.
