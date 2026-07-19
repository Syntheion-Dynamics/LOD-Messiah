# RESEARCH — LOD3 silhouette / proxy matematika (v2)

> Datum: 2026-07-19  
> Kontext: v1 (`lod3.glb` = 1× extruded **convex hull** XY + Cycles bake OPAQUE) nestačí.  
> Feedback z Blenderu: chybí „prostřední“ část věže, černé pozadí místo alpha, moc tris na „krabici“.

---

## 1. Co přesně máme teď (v1) a proč to vypadá takhle

| Fakt | Číslo / chování |
|---|---|
| Office_Plaza `lod3.glb` | **44 tris**, 1 materiál, `alpha=OPAQUE` |
| Energy_Office `lod3.glb` | **440 tris** (hustý footprint z tisíců XY projekcí bez decimace 2D bodů) |
| Geometrie | `convex_hull_2d(XY)` → extrude Z → top/bottom cap |
| Textura | selected-to-active EMIT bake → albedo; miss ray = **černá** |

### Proč chybí „prostředek“ (věž uprostřed)

Convex hull v půdorysu je **vyplněný obrys**. U Art Deco / Office Plaza typu „nízká křídla + vysoká věž uprostřed“:

```
Půdorys skutečný:     Convex hull:
  ####                  ##########
  ####  ####            ##########
  ##########            ##########
     ##                    ##     ← výška je JEDNA (max Z)
```

Hull extruduje na **jednu výšku = max(Z)**. Celý blok má výšku věže → křídla jsou „vytáhlá“ do nebe a prostřední ustupování **neexistuje**. To není chyba bake — je to limit **0-order silhouette** (jeden obrys × jedna výška).

### Proč černá místo alpha

1. Materiál je vynuceně `OPAQUE` (pipeline/engine day-1).  
2. Bake střílí paprsky ze shellu na high-poly; kde shell trčí mimo budovu (padding / křídla ve výšce věže), paprsek **mine** → pixel = černá.  
3. Černá na stěně vypadá jako „fotka budovy na krabici“, ale není to průhledný ořez.

### Proč „hodně tris na krychli“

- Office_Plaza 44 tris ≈ rozumný hull (~10–12 footprint bodů × strany + víka).  
- Energy_Office **440** = skoro každý unique XY z dense meshe → hulný polygon s ~100+ vrcholy. Chybí **2D decimate / Douglas–Peucker** před extrude. Vizuelně „krabice“, topologicky přehuštěný n-gon.

---

## 2. Matematické rodiny řešení (co existuje)

### A) Alpha cards (billboard / cross / N planes) — nejjednodušší

**Myšlenka:** 2–4 (až 8) quady v AABB; každá = ortho render RGBA (budova + **alpha silueta**).

- Tris: **4–16** (2 tris/quad).  
- Silueta = alpha test / MASK, ne geometrie.  
- „Prostředek“ z úhlu 0°/90° vypadá dobře; z 45° prosvítají karty (klasika).  
- Matematika: ortografická projekce, UV 0–1 na quad; ve hře `discard` když `a < cutoff`.

**Verdikt pro Bungáč far LOD:** nejlepší **quick win** na alpha + low tris. Neřeší plný 3D prostředek při orbitě.

### B) Visual hull (Laurentini / Matusik) — správná „silueta ze všech stran“

**Definice:** Visual hull \( VH(R) = \bigcap_{r \in R} Cone(r, S_r) \)  
kde \( S_r \) je 2D silueta z pohledu \( r \), \( Cone \) = vytlačení siluety do 3D z kamery.

Vlastnosti:

- \( Object \subseteq VH \) — hull **nikdy neukrojí** budovu.  
- Těsnější než convex hull.  
- „Prostřední“ ustupování: pokud máš siluetu z boku (věž vs křídla), boolean průnik kuželů **vyřízne** objem křídel nad jejich skutečnou výškou.

Praktická stavba pro budovy (Gao et al. 2022 — *Low-poly Mesh Generation for Building Models*):

1. Ortografické siluety z os (typicky ±X, ±Y, ±Z nebo jen horizontální 4–8).  
2. Každou siluetu **extrudovat** podél pohledové osy přes AABB.  
3. **Boolean intersection** všech extruzí → watertight visual hull.  
4. Volitelně carve / simplify (Pareto low-poly).

Složitost: boolean CSG (Blender `bmesh.ops.intersect_boolean` / Manifold). Robustnost u Kitbash = hlavní riziko.

Paper: https://lowpoly-modeling.github.io/ · Visual Hull Series (CGF 2025) pro urban buildings.

### C) Height-slice / stack of footprints (budovy-specifický hack)

**Myšlenka:** Ne jeden hull, ale \( K \) výškových pásem:

1. Rozděl `[z_min, z_max]` na \( K \) slice (např. 3–6).  
2. V každém pásu: body s \( z \in slice \) → 2D hull (nebo alpha bitmap → contour).  
3. Extrude slice na výšku pásu; stack / loft.

```
Slice top:     ##        ← jen věž
Slice mid:   ######
Slice base: ########## ← celá podstava
```

- Tris: řádově \( K \times \) (2N) ≈ **50–200** při slušném 2D simplify.  
- Drží „prostřední“ věž bez plného visual hull booleans.  
- Matematika: interval partition + 2D convex/concave hull + prism.

**Verdikt:** ideální **v2 pro Kitbash věže** — míň křehké než full VH, výrazně lepší než v1.

### D) Voxel occupancy + marching cubes / dual contouring

Grid \( N^3 \) (např. 32–64), mark occupied cells z meshe, extract isosurface, decimate.

- Dobré na organiku; u budov často **schodovité artefakty**.  
- Tris bez decimace snadno stovky–tisíce.  
- Overkill dokud nezkusíš C.

### E) Octahedral impostor (už v TOOL)

Atlas pohledů + 2 tris. Alpha v atlasu ano; „prostředek“ jen jako 2D obrázek. Engine shader zatím není. **Není náhrada** za 3D shell, ale tier nad LOD3.

---

## 3. Alpha — správný kontrakt (nezávisle na geometrii)

Pro jakýkoli proxy, který má „okolo budovy prázdno“:

| Kanál | Obsah |
|---|---|
| RGB | albedo fasády |
| A | 1 = budova, 0 = vzduch (dilate 1–2 px kvůli mips) |

Engine / glTF:

- `alphaMode = MASK` (ne BLEND — sorting hell na skyline)  
- `alphaCutoff ≈ 0.5`  
- Bake/render s `film_transparent` + zápis A; **ne** OPAQUE overpaint černou.

Cards (A): alpha je v ortho PNG přirozeně.  
Hull bake (B/C): buď  
- (1) bake do RGBA s alpha z coverage, nebo  
- (2) geometrie už sedí na siluetu → alpha skoro nepotřeba (lepší).

---

## 4. Tris budget (cíl)

| Tier | Cíl tris | Technika |
|---|---|---|
| Far cards | 4–16 | A |
| Skyline shell | **32–128** | C (3–5 slices) nebo zjednodušený VH |
| Detail proxy | 200–800 | VH + carve (paper) |
| Fail | > 500 na „krabici“ | chybí 2D simplify (dnešní Energy_Office) |

Povinný krok před extrude: **Douglas–Peucker** / `bmesh.ops.dissolve` na 2D polygon, max 12–24 vertexů.

---

## 5. Doporučení pro LOD Messiah v2 (pořadí)

### P0 — hned (oprava v1 bolesti, 1 večer)

1. **2D simplify** footprint → max ~16 bodů (Energy 440 → ~40–60 tris).  
2. Bake/export **MASK + alpha** (ne OPAQUE černá).  
3. Volitelně: pokud coverage < práh, alpha = 0.

To nevyřeší prostřední věž, ale přestane to vypadat jako černá krabice a přestaneš platit 440 tris za nic.

### P1 — prostřední část (to, co chceš)

**Height-slice stack (C)** v Blenderu:

- \( K = 4 \) pásma podle percentilů výšky (nebo podle změn footprint area).  
- Per slice: hull + simplify + extrude.  
- Join → 1 materiál, bake selected-to-active **nebo** 4 ortho cards na stěny (hybrid).

Očekávaný výsledek u Office Plaza: nízká křídla + střední věž viditelná v siluetě z ulice i z dálky.

### P2 — research-grade

Visual hull z 4–8 ortho siluet + boolean ∩ (B), pak decimate. Teprve když P1 nestačí na L/U půdorysy.

### Ne teď

- Plný octahedral ve Vulkanu (oddělený milník).  
- Concave footprint přesné dvorky (dražší).  
- Voxel MC jako default.

---

## 6. Mapování na tvé tři body

| Požadavek | Příčina ve v1 | Fix |
|---|---|---|
| Chybí prostředek | 1 výška = max Z | Height-slice (C) nebo visual hull (B) |
| Průhledná alpha | OPAQUE + miss=black | MASK + A z render/bake |
| Moc tris na krychli | Dense 2D hull | Douglas–Peucker / max N verts |

---

## 7. Zdroje

1. Laurentini — Visual hull concept  
2. Matusik — *Image-Based Visual Hulls* (MIT)  
3. Gao et al. 2022 — *Low-poly Mesh Generation for Building Models* — https://lowpoly-modeling.github.io/  
4. Visual Hull Series (CGF) — coarse-to-fine urban buildings  
5. Billboard Clouds / card clusters (Decoret; GDC vegetation) — alpha cards  
6. Interní: `docs/AI_ENGINE_WIREUP.md`, `scripts/blender_lod3_silhouette.py` (v1)

---

## 8. Jednou větou

**v1 = convex prism (špatná výška + černá).**  
**v2 = height-slices (nebo visual hull) + MASK alpha + 2D simplify.**  
Matematika, kterou potřebuješ na „prostřední věž“, je **průnik siluet / více výškových obrysů**, ne lepší UV na jedné krabici.
