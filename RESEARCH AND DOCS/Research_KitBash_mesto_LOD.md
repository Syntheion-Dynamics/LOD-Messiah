# Research: KitBash město ve vlastním enginu (C#/Vulkan) na RTX 4070

> **Pro:** Daniel / GTA Engine, 2026-07-19
> **Zadání:** desítky až stovky KitBash-scale budov (~150–320k tri zdroj) ve vlastním C#/Vulkan enginu, cíl 3440×1440 @ 60 FPS na RTX 4070, street-level kamera (GTA styl). Město = pár stovek budov, mix 1–2 high-poly „hero" budov na blok + modulární low-poly (10–20k tri) výplň. K dispozici: GPU instancing, BC7 komprese, LOD plán na papíře (meshopt + .lodcache), impostory jako pozdější fáze. Ochota implementovat: MDI / GPU-driven rendering, HLOD / merged proxy.

---

## TL;DR — verdikt

**ANO, jsi viable.** Tvůj přístup (meshopt LOD chain + hemi-oktahedrální impostory + BC7) je produkčně ověřená cesta — používá ji v nějaké formě většina AAA (GTA V, Fortnite, AC: Unity, MSFS). Na RTX 4070 @ 3440×1440/60 FPS je cíl „blok s 20–80 budovami, z toho pár hero 160k LOD0" **pohodlně v rozpočtu**, protože limit nikdy nebude geometrie, ale **textury (VRAM) a draw cally** — a obojí řeší věci, které už máš v plánu.

**Co ale musíš doplnit, jinak to umře jinde než čekáš:**
1. **Weld + Permissive simplify** místo čistého LockBorder přístupu — jinak ti většina KB budov zůstane „nezjednodušitelná" přesně tak, jak popisuješ (meshopt dokumentace to potvrzuje jako známý problém seamů/facetovaných meshů).[^2^][^8^]
2. **Materiálový merge + atlas na budovu** (11 materiálů → 2–3) a **1K textury jako default** — VRAM je tvůj skutečný strop, ne trojúhelníky. Budova s 11× 2K PBR setem je ~150–180 MB VRAM; 30 unikátních budov = ~5 GB jen textury.
3. **Impostor správně načasovaný** — přepínej až když je budova na obrazovce menší než bake rozlišení; pak je přechod prakticky neviditelný i bez ditheru.[^11^]
4. **Occlusion culling** (máš jako Fázi 6) je ve městě větší páka než jakýkoliv LOD — ulice ti ukryje 60–80 % budov. AC: Unity v roce 2015 na PS4 renderovalo celou Paříž GPU-driven pipelinou s ~300 „best occluders".[^36^]

---

## A) Rozpočty

### A.1 RTX 4070 — co reálně unese (3440×1440 = 4,95 Mpx, 60 FPS = 16,6 ms)

RTX 4070: 5888 CUDA jader, ~29 TFLOPS FP32, 12 GB GDDR6X @ 504 GB/s. Pro ilustraci měřítka: Assassin's Creed Unity renderovalo hustou Paříž s ~10× více instancemi než předchozí díly na **PS4 (1,84 TFLOPS)** — GPU-driven pipelinou s cluster cullingem.[^36^] RTX 4070 má ~16× výkon PS4. Geometrie města pro tebe není existenční problém; disciplína v datech ano.

Praktické inženýrské rozpočty pro klasický (non-Nanite) forward/deferred Vulkan renderer na této kartě:

| Veličina | Komfortní rozpočet @ 60 FPS | Poznámka |
| :-- | :-- | :-- |
| Viditelné trojúhelníky (po cullingu) | **5–15 M** | nad ~20 M už vertex/raster začíná bolet; s LOD chainem se tam nikdy nedostaneš |
| Draw cally (CPU-recorded, Vulkan) | **1 500–3 000** | s MDI prakticky neomezeně (tisíce sub-drawů v jednom volání)[^36^] |
| Unikátní materiály/pipeliny ve frame | stovky OK | dražší je state change než draw samotný |
| Texturní VRAM celkem | **≤ ~7–8 GB z 12 GB** | zbytek: G-buffer @ 3440×1440 (~0,5–1 GB), stíny, geometrie, systém |
| Geometrická VRAM | stovky MB | 250k tri budova ≈ 8–11 MB vč. LODů — geometrie je „zadarmo" |

### A.2 Kolik budov „150k LOD0 + impostor" uneseš

Klíčové uvědomění: **LOD systém znamená, že 150k LOD0 má viditelných vždy jen pár budov najednou.** Modelová situace (tvůj blok, street level):

| Vrstva | Počet budov | Tri na budovu | Tri celkem |
| :-- | :-- | :-- | :-- |
| LOD0 hero (blízko, < ~120 px práh nepřekročen) | 2–5 | 150k | 0,3–0,8 M |
| LOD1 (~30–50 %) | 10–20 | 45–75k | 0,5–1,5 M |
| LOD2 (~10 %) | 20–40 | 15–30k | 0,3–1,2 M |
| Impostory (zbytek + skyline) | 50–200 | **12 tri (kvad/bbox)** | ~2 400 |
| **Celkem** | **80–260** | | **~1–3,5 M tri** |

**Verdikt: 20–80 budov = hluboko pod stropem, i 200+ je OK.** Pro srovnání bez LODů: 80 × 160k = 12,8 M tri — pořád technicky renderovatelné na 4070, ale zbytečně na hraně a VRAM/draw cally by tě zabily dřív.

Benchmark z praxe (Unity/Pixyz impostor vs. reálný mesh 140k tri): **800 instancí** reálného meshe = 62,5 ms/frame, **800 impostorů = 4,0 ms**; impostor škáluje skoro lineárně s pixely, ne s instancemi (1600 instancí = 5,8 ms).[^10^] Tvých 50–200 impostorů je tedy fill-rate nepatrnost.

### A.3 Web/Three.js rozpočty (pro úplnost, kdybys portoval)

- **Mid PC (WebGL2):** ~1–5 M viditelných tri, **≤ ~500–1 000 draw callů** (draw overhead je v WebGL vyšší než v nativním Vulkanu), textury 1K/KTX2.
- **Mid mobile:** ~0,5–1 M tri, **≤ ~200–300 draw callů**, agresivní impostory už od střední vzdálenosti.
- V praxi: na webu je „80 budov po 150k" neřešitelné klasicky — tam bys musel jít cestou merged proxy (1 blok = 1 mesh) + impostory skoro všude.

### A.4 Unreal/Unity mid-range PC (referenčně)

- ~5–20 M viditelných tri, tisíce draw callů s instancingem, 8 GB VRAM cíl. KitBash3D sami v roce 2025 předělali svoje kity do „Gameplay Ready" formátu: průměrný kit ze **2,9 GB → 0,39 GB mesh memory**, draw cally **−82 %** díky instancingu a Packed Level Instances — přímý důkaz, že **surové kity nejsou game-ready a merge/instancing je povinný krok**, ne optimalizace navrchu.[^5^]

---

## B) KitBash-specifická realita

### B.1 Proč automatický simplify stojí na 40–70 %

To, co pozoruješ, je dokumentované chování, ne bug tvojí pipeline. Meshopt simplify sleduje topologii původního meshe a **nesmí kolabovat přes atributové švy** (UV seams, rozštěpené normály na hard edges, materiálové hranice). U meshe s hodně švy — a KB hard-surface budovy jich mají tisíce, protože každá fasádní lišta/okno je zvlášť UV-ostrůvek a často flat-shaded — se simplifier „zasekne" a nemůže cílový počet trojúhelníků dosáhnout.[^2^][^8^] U facetovaných meshů (flat normals) se může stát, že nezjednoduší **vůbec nic**.[^2^]

Co s tím (v pořadí účinnosti, přímo z dokumentace meshoptimizeru):

1. **Weld před simplify** — kritické: vstupní vertex buffer nesmí mít duplicity. Zrcadlové strany budov se slijí a odemkne se obrovské množství kolapsů.[^2^][^1^]
2. **`meshopt_SimplifyPermissive` + `vertex_lock` na UV švy** — Permissive mód povolí kolaps přes atributové diskontinuity, když je chyba přijatelná; přes `vertex_lock` (`SimplifyVertex_Protect`) si selektivně zamkneš jen ty švy, které musí přežít (hlavní UV ostrůvky fasády). Přesný recept je v dokumentaci: `generatePositionRemap` → porovnat atributy → lock na rozdílné UV.[^2^] **Tohle je přímá náhrada/vylepšení tvého LockBorder přístupu** — LockBorder chrání jen topologické okraje, ale tvůj problém jsou vnitřní švy, ne okraje.
3. **Error limit odblokovat pro LOD2** — tvůj plán má absolutní limity 0,05 m / 0,25 m. U LOD2 (který vidíš na 100+ m) klidně 0,5–1 m, nebo pro poslední LOD rovnou `meshopt_simplifySloppy`, který topologii nesleduje a spojuje i prostorově blízké, ale topologicky oddělené prvky — ideální pro fasádní detail, který stejně hned nahradí impostor.[^2^][^7^]
4. **Decimovat per-part je správně** (máš v plánu), ale počítej s tím, že nejmenší party (okenice, antény) se nedecimují — pro LOD2 je prostě **zahoď celé party pod N tri** (silhouette test: part < ~0,05 % obrazovky → skip).

**Realistická očekávání po těchto úpravách:** LOD1 30–50 % bez viditelné vady, LOD2 5–15 % s malými defekty ve střední vzdálenosti. Bez nich: přesně tvých „40–70 % a floor".

### B.2 Kdy stačí auto-simplify a kdy retopo/remesh + bake

Produkční pravidlo (Simplygon, Microsoft): **redukce → když cíl klesne pod ~10–20 % nebo se mesh začne rozpadat na „triangle soup", přepni na remeshed proxy.**[^14^] Konkrétně:

| Cíl | Technika |
| :-- | :-- |
| LOD1 (30–60 %) | auto-simplify (weld + permissive) — stačí vždy |
| LOD2 (5–15 %) | auto-simplify s vyšším errorem / sloppy; QC okem |
| LOD3 / poslední před impostorem (< 5 %) | **remesh proxy** (Simplygon Remesher / Blender remesh + bake normálů) — nová topologie, 1 draw call, 1 materiál, detail přepečený do textur[^14^] |
| Skyline / > 500 m | impostor (viz C) |

Bonus z praxe: Simplygon Remesher/Agregace umí sloučit **skupinu objektů do jednoho proxy objektu** (Aggregation) — to je přesně HLOD pro celý blok.[^13^][^14^] A pozor: **licenci Simplygonu zdarma dostaneš s MSFS 2024 SDK** (Xbox Game Studios nástroj, má C# API — sedí ti do stacku; komunita potvrzuje funkční addon i pro Blender).[^15^][^13^] Ten Microsoftův článek mimochodem doporučuje pro architekturu z tenké geometrie (zábradlí, ocelové konstrukce) **Billboard Cloud proxy** — redukce ani remesh na nich nefunguje.[^14^]

### B.3 Studiové workflow KitBash → game-ready (konsensus)

1. **KB assety jsou vizuální výchozí materiál, ne herní assety** — i sami KitBash3D svoje kity pro hry předělali: míň materiálů na objekt, nové UV/atlasy, kolize < 255 tri, instancing.[^5^]
2. **Merge materiálů + atlas per budova** (11 → 2–3). Většina KB materiálů jsou tiling trim/fasády — po atlasu jeden materiál na LOD úroveň.
3. **Instancing sdílených dílů** — KB kity jsou modulární; stejná okna/pilíře/lišty se opakují napříč budovami. KB v Gameplay Ready kitech tím snížili mesh memory ~7×.[^5^]
4. **Kolize zvlášť** (< 255 tri/budova)[^5^] — nikdy kolize z LOD0.
5. LOD chain (§B.2) + impostor (§C). Nanite jen pokud UE5 (§D.4).

---

## C) Far LOD strategie pro budovy — srovnání

| Technika | Tri | Kvalita | Škáluje na 50–200 instancí? | Háček |
| :-- | :-- | :-- | :-- | :-- |
| Mesh LOD chain (tvůj plán) | 15–30k na LOD2 | nejlepší | ano, ale poslední LOD je pořád drahý × 200 | poping bez cross-fade |
| **Hemi-oktahedrální impostor** | 12 | skoro pixel-perfect při správném přepnutí[^11^] | **ano — 800 impostorů ≈ 4 ms**[^10^] | paměť atlasů; parallax chyba na tenkých věžích |
| Obyčejný billboard | 2 | špatná z boku/shora | ano | jen pro extrémní dálku/mlhavou skyline |
| **HLOD / merged proxy (Simplygon Aggregation)** | ~5–20k **za celý blok** | dobrá | nejlíp ze všech — 1 draw za blok[^13^][^14^] | offline bake krok; ztráta per-budova variability |
| Hybrid (co dělá praxe) | — | — | — | — |

**Produkční vzor hybrid:** Fortnite používá oktahedrální impostory zabudované do LOD actorů pro stromy i budovy (přechod proxy → reálná geometrie viditelný třeba při seskoku); nástroj (Brucksův Impostor Baker) je od UE 4.27 přímo v enginu.[^19^] GTA V používá hierarchii HD → LOD → SLOD1–4 s výraznými skoky hustoty (u vozidel L0 60–120k → L4 500–1000 tri) a přepínacími vzdálenostmi řádu 15 / 30 / 60–70 / 120–140 m — **poměry mezi úrovněmi ~3–5×**, tvé 30 %/10 % sedí.[^21^][^24^]

### C.1 Vysoké úzké věže vs. hranolovité bloky

- **Hranolovité/blokové budovy** (většina Brooklynu): impostor ideální. Konvexní silueta = minimální parallax artefakty, hemi-sféra stačí.
- **Vysoké úzké věže (140 m mrakodrap, tvůj Brooklyn Convention Plaza):** pozor na dvě věci. (1) Ze street levelu se díváš **sakra nahoru** — hemi-oktaedr pečený pro „kameru kolem rovníku" bude mít pohled zespoda podvzorkovaný; řešení: full-sphere mód, nebo hemi s natočenou osou + vyšší počet framů ve vertikálním směru (Godot implementace má oba módy + depth-based frame blending, zdrojově dostupné jako reference pro tvůj shader).[^9^] (2) Tenké věže = výraznější parallax chyba při bočním pohybu — depth v atlasu + depth-based blending mezi framy je povinnost, ne luxus.[^9^]
- **Pravidlo přepnutí (důležitější než technika):** impostor nasaď až když je budova na obrazovce **menší než bake rozlišení** — pak je vzhled shodný se zdrojem a není potřeba žádný dither/fade (fade = kreslíš 2 věci najednou, tedy dočasně *horší* než vyšší LOD).[^11^] Prakticky: bake 512² na budovu → přepínej, když zabírá < ~512 px na výšku. U 3440×1440 a 140m věže to vychází řádově na 300–500 m — do té doby LOD1/LOD2.

### C.2 Škáluje impostor na 50–200 budov? — Ano

Čísla z Unity benchmarku výše: 800 impostorů ≈ 4 ms, skálování je fill-rate, ne instance-bound.[^10^] U tebe: 200 impostorů × kvad po ~200×400 px = ~16 Mpx fill → při BC7 atlasu a jednoduchém shaderu < 1 ms. **VRAM je jediný reálný limit:** atlas per unikátní budova (albedo+normály+depth, ~1024² BC7 ≈ 4–8 MB) × 30–50 unikátů = 120–400 MB. OK.

---

## D) Architektura enginu

### D.1 Doporučená scénová struktura (4 vrstvy)

```
0–80 m      LOD0 mesh (hero) / LOD1
80–250 m    LOD1 / LOD2 mesh          ← tvůj .lodcache, SSE výběr + hystereze (máš navrženo správně)
250–500 m   LOD2 / remesh proxy (1 materiál/budova)
500 m+      impostor (hemi/full-sphere dle výšky budovy)
Horizont    HLOD: merged proxy za blok/čtvrť (Simplygon Aggregation) — 1 draw za blok
```

Přesné metry dolaď podle SSE prahů (máš 120/40 px — rozumné startovní hodnoty). GTA V jako kalibrace: auto L1 @ 15 m, L2 @ 30 m, L3 @ 60–70 m, L4 @ 120–140 m.[^21^]

### D.2 GPU instancing / MDI / merging — co dává nejvíc za nejmíň práce

1. **Materiál merge + atlas per budova** (§B.3) — z ~11 partů × 80 budov (≈ 900–2 000 drawů) na 1–3 party × budova. **Největší poměr cena/výkon, dělej jako první.**
2. **Instancing opakujících se budov/modulů** — máš; KB Gameplay Ready ukazuje −82 % draw callů čistě instancingem.[^5^]
3. **MDI / GPU-driven (tvoje Fáze 6)** — referenční architektura je AC: Unity: CPU dělá jen hrubý quadtree culling, GPU pak per-instance frustum+occlusion culling, cluster expansion (64 tri clustery), index buffer compaction a `MultiDrawIndexedInstancedIndirect` — celá Paříž, tisíce instancí, na PS4.[^36^] Přesně tímto směrem jdi; nemusíš hned na clustery, stačí **per-instance GPU culling → indirect draw**, clustery až kdyby vertex fetch dýchal.
4. **Occlusion culling — ve městě větší páka než LOD.** Street-level = ulice jsou kaňony; typicky 60–80 % budov je skrytých. ACU recept: ~300 nejlepších occluderů (velké budovy blízko) do depth pre-passe → HiZ hierarchie → GPU culling instancí i clusterů; na PS4 jim to stálo ~750 µs.[^36^] Tvoje Fáze 6 s Intel MOC je legitimní; zvaž ale GPU HiZ rovnou, protože s MDI se to kombinuje přirozeně (culling na GPU přímo plní indirect buffery).

### D.3 Textury — tvůj skutečný rozpočet (projekce na 12 GB VRAM)

| Položka | Velikost | Poznámka |
| :-- | :-- | :-- |
| 2K BC7 s mipy | 5,33 MB / mapa | BC1: 2,67 MB |
| KB budova 11 materiálů × 3 mapy (albedo/normál/ORM) @ 2K | **~150–175 MB** | ❌ neudržitelné × 30 unikátů (~5 GB) |
| Totéž @ 1K | **~38–44 MB** | ✅ 30 unikátů ≈ 1,2 GB |
| Po atlas merge (11 → 2–3 materiály) @ 1K | **~8–12 MB / budova** | ✅✅ 30 unikátů ≈ 300 MB |
| G-buffer @ 3440×1440 + stíny | ~1–1,5 GB | fixní |

**Doporučení:** 1K default / 2K jen pro hero fasády u země; normály BC5, albedo BC7 (BC1 kde není alpha); sdílené trim materiály napříč kitem nekopírovat per budova; mip streaming až bude potřeba (Fáze 5). Geometrie s LODy (+40 % VRAM, máš v plánu) je proti tomu zaokrouhlovací chyba — tvůj odhad v §B1 plánu je správný.

### D.4 Nanite — dělá klasické LODy zbytečnými?

V UE5: **pro statickou hard-surface geometrii de facto ano** — KB Gameplay Ready kity se spoléhají na Nanite „without the need for traditional LODs"[^5^] a Nanite si dokonce sám generuje oktahedrální impostor pro nejvzdálenější úroveň.[^28^] **Ale háček pro tebe je zásadní:** Nanite není feature, je to ~2 roky práce týmu Epic — cluster pipeline (64–128 tri meshlety), software raster pro malé clustery, two-pass occlusion, virtuální streaming geometrie. Pro vlastní engine je pragmatická cesta **tvoje klasická: LOD chain + impostory + MDI + HiZ** — stejný princip, o dvě řády méně práce, a pro 80–200 budov zcela dostatečná. Cluster/meshlet pipeline (GPU-driven cluster culling ve stylu ACU[^36^]) je rozumný střední krok, pokud tě bude bavit rendering jako takový — ale **ne dřív, než budou hotové impostory a occlusion**. Pro web/WebGPU platí totéž zostra: tam Nanite-style zatím v produkci prakticky nikdo nemá.

---

## E) Konkrétní verdikt pro tvůj případ

**Zadání:** 320k zdroj → ~160k LOD0 + impostor; blok 20–80 budov; město pár stovek budov; 1–2 hero na blok + 10–20k modulární výplň; 3440×1440 @ 60 FPS, RTX 4070; vlastní C#/Vulkan s instancingem a BC7.

### ✅ ANO — s těmito minimálními dodatky (seřazeno):

| # | Krok | Proč / kolik to dá | Úsilí |
| :-- | :-- | :-- | :-- |
| 1 | **Weld + `SimplifyPermissive` + vertex_lock na UV švy** v LodCache generátoru | odemkne 30 %/10 % cíle, které teď „stojí na flooru" — dokumentovaný recept[^2^] | dny (máš infra) |
| 2 | **Materiál merge + atlas per budova, 1K default** | VRAM z ~5 GB → ~0,3–1,2 GB za unikáty; draw cally ÷ 4 | dny–týden (offline skript) |
| 3 | **Impostor přepnutí podle bake rozlišení** (ne fixní vzdálenost) + depth blending | neviditelný přechod bez ditheru[^11^] | součást impostor fáze |
| 4 | **Full-sphere / natočená hemi pro věže** | street-level pohled zespoda na 140m mrakodrapy[^9^] | parametr bakeru |
| 5 | **Occlusion culling (Fáze 6) prioritně před cluster pipeline** | ulice skryjí většinu města; ACU na PS4: ~0,75 ms za culling celého města[^36^] | týdny |
| 6 | **Sloppy simplify / remesh proxy pro LOD2→3** místo vysilování precise simplify | kvalita/draw call konsolidace na poslední mesh úrovni[^14^][^2^] | dny |
| 7 | **Kolize ≤ 255 tri, HLOD merged proxy pro horizont** | standard z KB Gameplay Ready[^5^] a Simplygon Aggregation[^13^] | později |

### Co v tvém LOD_PLAN.md hodnotím jako správně (neměnit)
- .lodcache vedle GLB s hash invalidací ✅, offline/load-time decimace ✅, SSE-lite s hysterezí ±10 % ✅, dither až jako polish krok (a možná vůbec — viz #3)[^11^] ✅, 30 %/10 % cíle ✅ (sedí na GTA poměry ~3–5× mezi úrovněmi[^21^]), LodSelector jako čistá testovatelná matematika ✅.

### Co bych v plánu upravil
- **LockBorder + vysoká UV váha jako hlavní strategie je přesně ten recept, který ti vyrábí „nezjednodušitelné" budovy.** LockBorder řeší topologické okraje (terén), ne vnitřní UV švy. Přepni na weld + Permissive + selektivní vertex_lock (bod #1).[^2^][^8^]
- U LOD2 zvaž vyšší absolutní error (0,25 m je konzervativní pro budovu viděnou na 200+ m).
- Impostory (§8 plánu) bych **neodkládal za streaming** — jsou nezávislé na streamingu a pro skyline dají nejvíc vizuálu za nejmíň ms. Pořadí bych udělal: materiál merge → LOD B → impostory → occlusion → MDI.

### Můžeš to vystřelit na jednu kartu?
Na RTX 4070 @ 3440×1440 s výše uvedeným: **~1–3,5 M viditelných tri, ~300–800 draw callů, ~2–3 GB textur** pro scénu „pár bloků + skyline". To je 30–50 % rozpočtu karty — zůstává prostor na dopravu, postavy, stíny, osvětlení. Upgrade GPU nepotřebuješ; potřebuješ body #1 a #2.

---

## Zdroje

[^1^]: glTF Transform — simplify (meshopt simplifier, weld před simplify, ratio/error): https://gltf-transform.dev/modules/functions/functions/simplify
[^2^]: meshoptimizer — dokumentace simplifieru (stuck na seams, weld, Permissive, vertex_lock, sloppy, scale/error): https://meshoptimizer.org/
[^5^]: KitBash3D — „Introducing Gameplay Ready Kits" (2,9 GB → 0,39 GB, −82 % draw callů, Nanite místo tradičních LOD, kolize < 255 tri): https://kitbash3d.com/a/blog/introducing-gameplay-ready-kits-built-for-real-time-performance-in-unreal-engine
[^7^]: meshoptimizer (npm/js) — simplify/simplifySloppy/compactMesh reference: https://www.npmjs.com/package/meshoptimizer
[^8^]: meshoptimizer GitHub discussion #878 — „UV seams are interfering with simplification": https://github.com/zeux/meshoptimizer/discussions/878
[^9^]: Godot-Octahedral-Impostors (wojtekpil) — full/hemi-sphere módy, depth blending, batch baker (referenční implementace): https://github.com/wojtekpil/Godot-Octahedral-Impostors
[^10^]: Unity Asset Transformer (Pixyz) — Bake Impostor + benchmark 140k tri mesh vs. impostor (100–1600 instancí): https://docs.unity3d.com/Packages/com.unity.industry.toolkit@3.2/manual/Actions/Autogenerated/BakeImpostor.html
[^11^]: three.js fórum — „A forest of octahedral impostors" (pravidlo přepnutí dle bake rozlišení, proč ne fade): https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735
[^13^]: Wikipedia — Simplygon (Reduction / Remeshing / Aggregation / Impostor / Occlusion mesh; Microsoft/Xbox Game Studios): https://en.wikipedia.org/wiki/Simplygon
[^14^]: Microsoft Game Dev — „Optimize 3D models for strategy games with Simplygon" (redukce → remesh proxy, aggregation, billboard cloud pro tenkou architekturu, custom engine integrace): https://developer.microsoft.com/en-us/games/articles/2026/05/optimize-3d-models-for-strategy-games-with-simplygon/
[^15^]: fsdeveloper — Simplygon licence zdarma s MSFS 2024 SDK + Blender addon: https://www.fsdeveloper.com/forum/threads/simplygon-for-blender.459473/
[^19^]: 80.lv — Impostor Baker (Ryan Brucks); použito ve Fortnite BR od mapy 2.0, součást UE 4.27+: https://80.lv/articles/impostor-baker-for-ue4
[^21^]: modding-forum — GTA V LOD Models (polycounty L0–L4, přepínací vzdálenosti 15/30/60–70/120–140 m): https://www.modding-forum.com/guide/1-lod-models/
[^24^]: Cfx.re docs — FiveM LODs: HD/LOD YMAP hierarchie, LodDist, ChildLodDist: https://docs.fivem.net/docs/assets-manual/beginner-series/part-6/
[^28^]: Unreal fórum — Nanite si generuje oktahedrální impostory pod ~128 tri: https://forums.unrealengine.com/t/ue5-foliage-and-octahedral-imposters/247858
[^36^]: Haar & Aaltonen (Ubisoft) — „GPU-Driven Rendering Pipelines", SIGGRAPH 2015 (AC: Unity: 64-tri clustery, MDI, GPU occlusion, ~300 occluderů, PS4 čísla): http://advances.realtimerendering.com/s2015/aaltonenhaar_siggraph2015_combined_final_footer_220dpi.pdf
