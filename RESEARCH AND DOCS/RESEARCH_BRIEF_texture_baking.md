# RESEARCH BRIEF — Texture baking pro KitBash budovy (offline pipeline)

> **Účel:** podklad pro deep-research agenta. Cíl = zmenšit velikost zdrojových textur
> KitBash budov (disk + texel efektivita) v offline pipeline, BEZ ztráty kvality na blízko.
> Výstup pak Claude zreviduje (opraví chyby) a překlopí do exekučního plánu (Claude/Cursor split).

## Kontext — co UŽ máme (NEřešit znovu)

- **Engine:** C# + Vulkan (Silk.NET), vlastní open-world. Textury: **PNG→BC7 GPU komprese
  při načtení hotová** (texcache), mipmapy + anizotropie hotové. → Research NEcílí na GPU
  formát ani VRAM kompresi; ta je vyřešená. Cílí na **velikost zdrojové textury / texel budget**.
- **LOD:** geometrii řeší externí TOOL (Node + glTF-Transform + meshoptimizer): `lod0/1/2.glb`,
  lod1/2 geometry-only. Výběr úrovně v enginu (SSE + hystereze). Hotovo.
- **TOOL textury dnes:** (a) `dedup()` + material-merge (sloučí materiály se stejnou sadou
  textur, **bez přepečení, tiling UV zachované**); (b) `--max-texture N` = resize všech
  textur na max N px (levná páka); (c) `--atlas` = experimentální join-all bake v Blenderu,
  QC to často odmítne. Impostor (dálková placka) je samostatná odložená věc.
- **Workflow:** manuální umístění, KitBash zdroj z Blenderu (make-instances-real → export GLB).
  Zdroj se re-exportuje → generovaná data jen v cache/output, zdroj se nepřepisuje.

## JÁDRO problému (celý research se točí kolem tohoto)

KitBash materiály používají **tiling/wrapping UV** (textura se opakuje přes plochu). Klasické
atlasování (sbalit N textur do 1) tiling **rozbije** — atlas buňka se neumí opakovat. Zároveň
KitBash barák nese desítky vysokorozlišných map (albedo+normal+ORM na každý díl) → nafouknutý GLB.

**Hlavní otázka:** Jak produkční pipeline pečou hard-surface / KitBash assety s tiling UV do
kompaktní, engine-ready sady textur, bez kolapsu kvality a bez ruční práce na každý model?

## Co přesně nastudovat (algoritmy + tradeoffy)

1. **Bake-to-unique-UV (přepečení tiling do unikátního rozbalení):** rozbalit mesh na
   unikátní UV (Blender Smart UV Project, **xatlas/thekla**), pak zapéct *výsledný vzhled
   včetně tilingu* do jedné atlas textury. Řešit: alokaci **texel density** per plocha
   (velká tiled zeď potřebuje víc texelů → exploze rozlišení), seams, baking time na
   300k-tri meshi. Kdy se to vyplatí vs kdy je to horší než ponechat tiling.
2. **Dedup/merge vs full rebake — rozhodovací matice:** kdy stačí sloučení materiálů
   (dnešní stav) a `--max-texture` resize, a kdy je nutný skutečný atlas bake. Prahy
   (počet materiálů, plocha, vzdálenost od kamery / LOD úroveň).
3. **Co péct:** potvrdit, že pro **dynamicky nasvícený** engine se pečou jen PBR mapy
   (albedo/normal/metallic-roughness-occlusion), NE světlo/AO do albeda. Správnost
   **normal map přes rebake** (tangent space), packing ORM do kanálů.
4. **Alternativy k jedinému atlasu:** UDIM, **texture arrays / array atlas**, channel
   packing, sdílený atlas napříč více budovami (bindless/array — vazba na city scale).
5. **Texel density / rozlišení budgeting:** jak dimenzovat atlas, aby vzdálené budovy
   neplýtvaly texely (vazba na LOD — hrubší LOD = menší textura?).
6. **Tooling & spolehlivost:** co jde automatizovat v **glTF-Transform**, **xatlas**,
   **Blender headless (bpy) bake** vs co vyžaduje ruční QC. **Konkrétně na KitBash s tiling
   UV** — kde to selhává (proč je `--atlas` dnes nespolehlivý). Řešení: batch, retry, QC gate.
7. **Pořadí v pipeline:** péct textury PŘED nebo PO meshopt decimaci? Zachování UV při
   simplifikaci (už řešíme UV-preserving decimaci pro LOD). Interakce baking × LOD × impostor.

## Co chceme jako VÝSTUP (aby to bylo použitelné, ne esej)

- **Rankované přístupy** s pro/proti pro **solo-udržovanou offline** pipeline (Node/glTF-Transform,
  Blender volitelně). U každého: kvalita, velikost, čas, spolehlivost na KitBash.
- **Rozhodovací matice „levné vs pořádné"**: kdy stačí `--max-texture` resize, kdy atlas bake.
- **Konkrétní knihovny/nástroje** (xatlas, gltf-transform funkce, bpy bake) s poznámkou
  o spolehlivosti na tiling-UV KitBash a co je zadarmo vs co je křehké.
- **Doporučená pipeline fáze** — kam v TOOLu zapadne, pořadí vůči meshopt/impostoru.
- **Pitfally** (seams, texel density, normal-map chyby, baking time, tiling exploze rozlišení).

## Tvrdá omezení (drž research při zemi)

- Solo non-programmer, **offline / load-time only** (nikdy per-frame), žádný heavy compute.
- Zdroj se NEpřepisuje (re-export z Blenderu), generovaná data v output/cache.
- Engine **už dělá BC7** → research cílí na zdrojovou velikost + texel efektivitu, NE GPU formát.
- **Musí zvládnout tiling UV** — to je jádro, ne okrajová poznámka.
- Cílový scale: Liberty City ~6–8 km², desítky–stovky budov, hodně sdílených KitBash dílů.
