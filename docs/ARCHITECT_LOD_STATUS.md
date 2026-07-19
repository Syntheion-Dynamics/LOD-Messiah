# Stav LOD Messiah → Bungáč (pro architekta)

> Datum: 2026-07-19  
> Ty nejsi programátor — tohle je mapa „co máme / kde klikat / co ještě bolí“.  
> **Důležité zjištění z Blenderu:** LOD2 vypadá bíle (bez textur) = OK u geo-only. Okna na LOD0/1/2 = glass-safe simplify (§4.2).

---

## 1. Jednou větou

Kitbash se **peče offline** v TOOL. Hra jen načte hotové soubory.  
Hlavní vzorek: **Office_Plaza** (nashipovaná včetně LOD3 v2 MASK). QC siluety: Blender → Force LOD 3 ve hře.

---

## 2. Kde co hledat

### TOOL (vařič)
Kořen: `C:\Users\yukit\Downloads\TOOL`

| Co | Cesta |
|---|---|
| Koupené zdroje | `Kitbash Assets\` (Brooklyn, Every City, Manhattan, …) |
| Uvařené výstupy | `output\<Kit>\<Asset>\` např. `output\Manhattan\Office_Plaza\` |
| Náhled ve webovce | `gallery.bat` → http://127.0.0.1:4173 |
| Cook 1 budovy | `convert-kitbash.bat` |
| Cook celý kit | `convert-kitbash-all.bat` |
| Kopíruj do hry | `ship-to-engine.bat Manhattan\Office_Plaza` |
| Návod pro AI enginu | `docs\AI_ENGINE_WIREUP.md` |
| Research LOD3 (silueta, alpha, prostředek) | `docs\RESEARCH_LOD3_silhouette_math.md` |
| Tento stav | `docs\ARCHITECT_LOD_STATUS.md` |

### Co je ve složce assetu (příklad Office_Plaza)

```
output\Manhattan\Office_Plaza\
  default.glb     ← plná kvalita před ořezem (těžké; do hry se nekopíruje)
  lod0.glb        ← runtime blízko (mesh + textury)
  lod1.glb        ← střední vzdálenost (jen geometrie)
  lod2.glb        ← dál (jen geometrie u našeho cooku)
  lod3.glb        ← silueta v2 (MASK alpha, height-slice / hull)
  lod3_atlas\     ← albedo siluety
  asset.json      ← seznam LODů
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
| LOD3 height-slice + MASK (v2) | ✅ | P0+P1 cook; Office_Plaza shipped |
| Engine MASK cutout pro LOD3 | ✅ | 19.07 — bez mipů + clamp UV na self-contained |
| Octahedral impostor bake | ⚠️ | v gallery OK-ish; ve hře shader **ne** |
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

## 5. LOD3 silueta — co je a co není

| | |
|---|---|
| Cíl | Levná 3D silueta na dálku (ne octa placka) |
| Teď | **v2** height-slice (nebo visual-hull) + **MASK** alpha bake (`alphaCutoff` 0.5) |
| Research | `docs\RESEARCH_LOD3_silhouette_math.md` |
| Engine (19.07 večer) | MASK cutout + bez mipů + clamp UV na self-contained; Office_Plaza **znovu nashipovaná** |
| QC | Blender (tvar + díry ve vzduchu) → pak Force LOD 3 ve hře |

**Co máš vidět u Office_Plaza (po shipu):** ~100+ tris (ne 44), průhledný vzduch přes alpha (ne černý box), stupňovitá silueta.

### 5.1 ⚠️ POTŘEBUJE ROZHODNUTÍ ARCHITEKTA (19.07 večer) — rozbité LOD3 u části Kitbashe

**Problém (ověřeno v Blenderu):** u některých budov (např. `Brooklyn_Luxury_Flats`) je `lod3.glb` vizuálně rozbitý — místo budovy jen **fragmenty fasád / říms / okenních rámů**. Cook to přitom **pustí** (tris v limitu, report = OK). Office_Plaza a podobné masy vypadají lépe; duté Kitbash pláště ne.

**Proč to bolí (bez programátorské omáčky):**
- Kitbash = často **dutá skořápka** (stěny ano, vnitřek ne) + **podlaha / chodník / base plate**.
- Současná 3D silueta (height-slice / visual-hull) z toho skládá obrys z bodů meshe → u duté fasády vycházejí tenké „rámečky“, ne hmota.
- **Odstranit podlahu pomůže**, ale nestačí: římsy, sloupy, balkony, okenní šambrány stejně zkreslí footprint. Čím víc architektonického bordelu na plášti, tím horší 3D silueta z raw meshe.

**Silueta jako idea není těžká.** Těžké je spolehlivě ji uvařit z Kitbash GLB bez ručního čištění každé budovy.

#### Varianty — vyber jednu (nebo hybrid)

| Volba | Co to je | Výhody | Nevýhody | Práce TOOL | Práce engine |
|---|---|---|---|---|---|
| **A — 6 placek + fotka strany** *(návrh z QC)* | AABB box: 6 quads (±X ±Y ±Z), každá = ortho render budovy (RGBA / MASK) | Jednoduché, předvídatelné, podlaha/římsy skoro nevadí (jsou „na fotce“), ~12 tris | Z 45° prosvítají hrany karet; není to plný 3D objem | Střední (bake 6 views) | Malá (už umí MASK; 6 materiálů/UV nebo 1 atlas) |
| **B — hloupá 3D krabice** | 1× convex/AABB footprint × výška (+ volitelně ořez podlahy) | Robustní, vždy „nějaká budova“ | U věží chybí prostředek; římsy pořád nafukují box | Malá | 0 (už jede) |
| **C — opravovat v2 siluetu** | Lepší footprint (global plan, filtr podlahy, QC „vypadá jako budova“) | Drží směr „3D proxy“ | Pořád křehké u dutých Kitbashů; římsy/sloupy zůstanou edge case | Velká | 0 |
| **D — LOD3 přeskočit** | Ve hře `lod2 → impostor` (až bude shader) / jen lod2 na dálku | Žádný další pain teď | Chybí levný mid-far stupeň mezi lod2 a impostorem | 0 | Kontrakt LOD řetězce |

**Doporučení z TOOL strany (ne závazné):** **A (6 placek)** sedí na to, co jsi řekl u Blenderu — „6 placek a fotka toho boku“. Je to blízko box-impostoru, ne komplexní 3D hull. B jako nouzový fallback. C jen pokud trváme na „pravé“ 3D siluetě za cenu dalších cook iterací.

**Doplňující otázky pro tebe:**
1. Smí LOD3 z 45° vypadat jako karty (A), nebo musí držet objem při orbitě (B/C)?  
2. Čistíme zdroje (mazat podlahu v Kitbash / Blenderu), nebo má vařič podlahu ignorovat sám?  
3. Do shipu města: radši **žádné LOD3** u rozbitých assetů, než špatné fragmenty?

**Rozhodnutí:** __________   Datum: __________   Poznámka: __________

---

## 6. Co ještě není dořešené (backlog pořadí)

### Musí dřív než „celé město z Kitbashe“

1. ~~**LOD0/1/2 okna**~~ — ✅ glass-safe na všech LODech; Office_Plaza `glassQc` 100 %.  
2. **LOD2 vizuál** — Force LOD 2 v enginu (bílá v Blenderu = OK u geo-only).  
3. ~~**LOD3 v2 v enginu**~~ — ✅ cook + ship + MASK podpora (19.07); živé QC Force LOD 3.  
3b. **⚠️ LOD3 strategie u Kitbashe** — rozhodnutí §5.1 (6 placek vs krabice vs opravovat v2 vs skip). Do té doby nerozbíjet další budovy „úspěšným“ špatným LOD3.  
4. **Shared textury per kit** — jinak VRAM zabije 4070 při N budovách.  
5. Cook + ship dalších budov po jedné (ne celý kit najednou).

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
| `lod3.glb` | Silueta s **MASK** alpha; průhledný vzduch (ne černý kvádr) |

V gallery: LOD tabulka + velikosti.  
Ve hře (až budeš chtít): Force LOD 0→3.

---

## 8. Shrnutí pro tebe

- **LOD3 v2 je v enginu** — Force LOD 3; po shipu očekávej MASK díry + nový tvar (§11).  
- **⚠️ LOD3 u části Kitbashe je rozbité** (fragmenty fasád) — nepokračovat slepě; **rozhodnutí §5.1** (návrh: 6 placek + fotka strany).  
- **Okna LOD0/1/2:** glass-safe cook hotový (Office_Plaza 100 %). QC textur LOD1/geo-LOD2 = Force LOD v enginu (§4.0).  
- QC tvarů v **Blenderu / gallery**; textury LOD1/geo-LOD2 + LOD3 alpha jen **Force LOD v enginu**.  
- Další krok: rozhodnutí LOD3 strategie → pak shared textury / další budovy.

---

## 9. Checklist potvrzení architekta

| # | Tvrzení | Potvrzeno |
|---|---|---|
| A | LOD1 v `lod1.glb` nemá textury schválně; ve hře je bere z LOD0 | [ ] |
| B | Bílá LOD1/LOD2 (geo-only) v Blenderu ≠ bug | [ ] |
| C | QC textur LOD1 = editor Force LOD 1, ne Blender import | [ ] |
| D | LOD2 s atlasem (`Lod2AtlasMesh`) má vlastní bake — může vypadat hůř než LOD1 | [ ] |
| E | Glass-safe LOD0/1/2: okna zůstávají (`glassQc` ≥95 % na všech) | [ ] |
| F | LOD3 strategie (§5.1): A 6 placek / B krabice / C opravovat v2 / D skip | [ ] volba: ___ |

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

## 11. Engine podpora LOD3 v2 (19.07.2026 večer)

TOOL silueta je lepší (height-slice / visual-hull + **MASK** alpha). Engine doplněn tak, aby to ve hře vypadalo stejně ostré.

### Co TOOL teď peče
- `lod3.glb` — 1 materiál `Lod3SilhouetteMaterial`, `alphaMode: MASK`, `alphaCutoff: 0.5`
- RGBA albedo (coverage v alpha) — embedded v GLB + kopie `lod3_atlas/albedo.png`
- `asset.json` → blok `"lod3": { "alphaMode": "MASK", "slices": …, "backend": "…" }`

### Co engine nově dělá
| Věc | Proč |
|---|---|
| Čte MASK + cutoff (už dřív) | `discard` v shaderu = díry ve vzduchu, ne černý box |
| **Bez mipmap** u cutout materiálů | Mipy ředí alpha → silueta se na dálku drobí |
| **Clamp UV** u self-contained MASK | Atlas nemá tiling; REPEAT by bleedoval barvu přes okraj |
| Re-ship Office_Plaza | Assets mají nový `lod3.glb` (~96 KB) + `lod3_atlas/` |

### Jak ověřit (ty)
1. Spusť editor.  
2. DEBUG → Force LOD **3**.  
3. Čekáš: stupňovitá / hull silueta, **průhledný vzduch**, ne plný černý kvádr.  
4. Když pořád stará silueta → smaž `.cache\texcache` (nebo aspoň záznamy Office_Plaza) a načti scénu znovu.

### Soubory v enginu
`MeshDrawBridge.cs` (DisableMipmaps), `MeshLoader.cs` (clamp u self-LOD MASK), Assets Office_Plaza (ship).

Detailní AI kontrakt: `docs\AI_ENGINE_WIREUP.md` §4.5.
