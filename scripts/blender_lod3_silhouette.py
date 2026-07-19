"""
LOD3 silhouette proxy v2: height-slice stack + Douglas–Peucker + MASK alpha bake.

  blender --background --python blender_lod3_silhouette.py -- \\
    --input source.glb --output lod3.glb --faces-dir ./lod3_atlas \\
    --resolution 1024 --slices 4
"""
import argparse
import math
import os
import sys


def parse_args(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--faces-dir", required=True)
    p.add_argument("--resolution", type=int, default=2048)
    p.add_argument(
        "--padding",
        type=float,
        default=0.0,
        help="Fraction of footprint extent added to hull (default 0 — tighter shell)",
    )
    p.add_argument(
        "--slices",
        type=int,
        default=8,
        help="Max height bands; splits placed on A(z) jumps (default 8)",
    )
    p.add_argument(
        "--max-footprint-verts",
        type=int,
        default=56,
        help="Max verts per band footprint after Douglas–Peucker",
    )
    p.add_argument(
        "--contour",
        choices=("concave", "convex"),
        default="concave",
        help="Per-band / silhouette footprint: concave (default) or convex hull",
    )
    p.add_argument(
        "--method",
        choices=("visual-hull", "slices"),
        default="visual-hull",
        help="Geometry: visual-hull = top+side silhouettes ∩ (default); slices = A(z) stack",
    )
    p.add_argument(
        "--vh-views",
        type=int,
        default=5,
        help="Visual-hull orthographic views: 3=top+X+Y, 5=+sides, 9=+diagonals (default 5)",
    )
    return p.parse_args(argv)


def clear_scene(bpy):
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_meshes_single_user(bpy, meshes):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.make_single_user(object=True, obdata=True, material=False, animation=False)
    for obj in meshes:
        if obj.data and obj.data.users > 1:
            obj.data = obj.data.copy()


def join_all_meshes(bpy, name="Lod3Source"):
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh objects in GLB")

    make_meshes_single_user(bpy, meshes)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    if len(meshes) == 1:
        meshes[0].name = name
        return meshes[0]

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    return obj


def world_bounds(obj):
    import mathutils

    min_c = mathutils.Vector((1e18, 1e18, 1e18))
    max_c = mathutils.Vector((-1e18, -1e18, -1e18))
    for corner in obj.bound_box:
        w = obj.matrix_world @ mathutils.Vector(corner)
        min_c.x = min(min_c.x, w.x)
        min_c.y = min(min_c.y, w.y)
        min_c.z = min(min_c.z, w.z)
        max_c.x = max(max_c.x, w.x)
        max_c.y = max(max_c.y, w.y)
        max_c.z = max(max_c.z, w.z)
    return min_c, max_c


def collect_world_verts(obj):
    """Return list of world-space (x, y, z) tuples. Blender Z-up after glTF import."""
    pts = []
    mw = obj.matrix_world
    for v in obj.data.vertices:
        w = mw @ v.co
        pts.append((float(w.x), float(w.y), float(w.z)))
    return pts


def expand_polygon(pts, padding_frac):
    if padding_frac <= 0 or len(pts) < 3:
        return pts
    cx = sum(p.x for p in pts) / len(pts)
    cy = sum(p.y for p in pts) / len(pts)
    max_r = max(math.hypot(p.x - cx, p.y - cy) for p in pts) or 1.0
    pad = max_r * padding_frac
    out = []
    for p in pts:
        dx, dy = p.x - cx, p.y - cy
        r = math.hypot(dx, dy)
        if r < 1e-8:
            out.append(p.copy())
        else:
            s = (r + pad) / r
            out.append(type(p)((cx + dx * s, cy + dy * s)))
    return out


def _perp_dist(pt, a, b):
    """Perpendicular distance from pt (x,y) to segment a→b."""
    ax, ay = a
    bx, by = b
    px, py = pt
    dx, dy = bx - ax, by - ay
    len_sq = dx * dx + dy * dy
    if len_sq < 1e-20:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / len_sq
    t = max(0.0, min(1.0, t))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy)


def douglas_peucker(points, epsilon):
    """Ramer–Douglas–Peucker on open polyline of (x,y) tuples. Returns subset preserving order."""
    if len(points) < 3:
        return list(points)

    def _rec(pts):
        if len(pts) < 3:
            return list(pts)
        a, b = pts[0], pts[-1]
        max_d = -1.0
        max_i = 0
        for i in range(1, len(pts) - 1):
            d = _perp_dist(pts[i], a, b)
            if d > max_d:
                max_d = d
                max_i = i
        if max_d > epsilon:
            left = _rec(pts[: max_i + 1])
            right = _rec(pts[max_i:])
            return left[:-1] + right
        return [pts[0], pts[-1]]

    return _rec(list(points))


def simplify_closed_ring(ring_xy, plan_diag, max_verts=48):
    """
    Douglas–Peucker on a closed convex ring (no duplicate closing vertex).
    ε starts at 0.5% of plan diagonal; grows until <= max_verts.
    """
    if len(ring_xy) <= 3:
        return list(ring_xy)

    eps = max(plan_diag * 0.005, 1e-6)
    pts = list(ring_xy)
    # Work on open polyline; last connects to first conceptually via DP on full cycle:
    # break at first vertex, DP the chain, keep closed.
    for _ in range(16):
        simplified = douglas_peucker(pts + [pts[0]], eps)[:-1]
        if len(simplified) < 3:
            # Too aggressive — back off
            eps *= 0.5
            simplified = douglas_peucker(pts + [pts[0]], eps)[:-1]
            if len(simplified) < 3:
                return pts[: max(3, min(len(pts), max_verts))]
        if len(simplified) <= max_verts:
            return simplified
        eps *= 1.6
        pts = simplified

    # Hard cap: keep every k-th vertex of current ring
    if len(pts) > max_verts:
        step = max(1, len(pts) // max_verts)
        capped = pts[::step][:max_verts]
        if capped[0] != pts[0]:
            capped[0] = pts[0]
        if len(capped) < 3:
            capped = pts[:max_verts]
        return capped
    return pts


def polygon_area_xy(ring_xy):
    """Shoelace area of closed ring [(x,y), ...]."""
    n = len(ring_xy)
    if n < 3:
        return 0.0
    a = 0.0
    for i in range(n):
        x0, y0 = ring_xy[i]
        x1, y1 = ring_xy[(i + 1) % n]
        a += x0 * y1 - x1 * y0
    return abs(a) * 0.5


def band_boundaries_from_percentiles(zs, k):
    """Fallback: K+1 Z boundaries from height percentiles."""
    if not zs:
        return [0.0, 1.0]
    zs_sorted = sorted(zs)
    n = len(zs_sorted)
    z0 = zs_sorted[0]
    z1 = zs_sorted[-1]
    if abs(z1 - z0) < 1e-3:
        return [z0, z0 + 1.0]

    k = max(1, int(k))
    bounds = []
    for i in range(k + 1):
        t = i / k
        idx = min(n - 1, max(0, int(round(t * (n - 1)))))
        bounds.append(zs_sorted[idx])

    out = [bounds[0]]
    for b in bounds[1:]:
        if b <= out[-1] + 1e-5:
            out.append(out[-1] + (z1 - z0) * 0.001)
        else:
            out.append(b)
    out[0] = z0
    out[-1] = z1
    return out


def band_boundaries_adaptive_area(world_pts, k, n_bins=80):
    """
    Place up to K bands where cross-section area A(z) jumps (setbacks / roofs).
    A(z) ≈ convex-hull area of XY verts in each Z bin.
    Falls back to percentiles if jumps are weak.
    """
    from mathutils import geometry
    import mathutils

    zs = [p[2] for p in world_pts]
    z0, z1 = min(zs), max(zs)
    if abs(z1 - z0) < 1e-3:
        return [z0, z0 + 1.0]

    k = max(1, int(k))
    n_bins = max(n_bins, k * 4)
    dz = (z1 - z0) / n_bins
    areas = []
    bin_z = []
    for bi in range(n_bins):
        lo = z0 + bi * dz
        hi = lo + dz
        mid = 0.5 * (lo + hi)
        bin_z.append(mid)
        pts2 = [
            mathutils.Vector((p[0], p[1]))
            for p in world_pts
            if lo <= p[2] <= hi
        ]
        if len(pts2) < 3:
            areas.append(0.0)
            continue
        hull_idx = geometry.convex_hull_2d(pts2)
        if len(hull_idx) < 3:
            areas.append(0.0)
            continue
        ring = [(float(pts2[i].x), float(pts2[i].y)) for i in hull_idx]
        areas.append(polygon_area_xy(ring))

    # Smooth lightly
    smooth = areas[:]
    for i in range(1, n_bins - 1):
        smooth[i] = 0.25 * areas[i - 1] + 0.5 * areas[i] + 0.25 * areas[i + 1]

    # Jump score at bin boundaries (between i and i+1)
    jumps = []
    a_max = max(smooth) or 1.0
    for i in range(n_bins - 1):
        d = abs(smooth[i + 1] - smooth[i]) / a_max
        # Prefer drops (setbacks) slightly over growth
        drop = max(0.0, smooth[i] - smooth[i + 1]) / a_max
        score = d + 0.5 * drop
        z_split = z0 + (i + 1) * dz
        jumps.append((score, z_split, i))

    jumps.sort(reverse=True, key=lambda t: t[0])
    min_thick = (z1 - z0) / max(k * 2.5, 4.0)
    chosen = []
    for score, z_split, _ in jumps:
        if score < 0.02 and len(chosen) >= max(1, k // 2):
            break
        if any(abs(z_split - c) < min_thick for c in chosen):
            continue
        chosen.append(z_split)
        if len(chosen) >= k - 1:
            break

    if len(chosen) < 1:
        print("LOD3 A(z): weak jumps → percentile bands")
        return band_boundaries_from_percentiles(zs, k)

    bounds = [z0] + sorted(chosen) + [z1]
    # Enforce strictly increasing
    out = [bounds[0]]
    for b in bounds[1:]:
        if b <= out[-1] + 1e-5:
            out.append(out[-1] + min_thick * 0.25)
        else:
            out.append(b)
    out[0] = z0
    out[-1] = z1
    print(
        f"LOD3 A(z): {len(out) - 1} adaptive bands "
        f"(requested≤{k}, jumps={len(chosen)})"
    )
    return out


def _dilate_grid(grid, w, h, rounds=1):
    g = [row[:] for row in grid]
    for _ in range(rounds):
        nxt = [row[:] for row in g]
        for y in range(h):
            for x in range(w):
                if g[y][x]:
                    continue
                hit = False
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        xx, yy = x + dx, y + dy
                        if 0 <= xx < w and 0 <= yy < h and g[yy][xx]:
                            hit = True
                            break
                    if hit:
                        break
                if hit:
                    nxt[y][x] = 1
        g = nxt
    return g


def _fill_solid_from_shell(grid, w, h):
    """
    Vert projections of hollow building facades are thin wall rings.
    Flood-fill exterior from the border; solid = everything not exterior.
    """
    exterior = [[0] * w for _ in range(h)]
    stack = []
    for x in range(w):
        if not grid[0][x]:
            stack.append((x, 0))
        if not grid[h - 1][x]:
            stack.append((x, h - 1))
    for y in range(h):
        if not grid[y][0]:
            stack.append((0, y))
        if not grid[y][w - 1]:
            stack.append((w - 1, y))

    seen = set()
    while stack:
        x, y = stack.pop()
        key = y * w + x
        if key in seen:
            continue
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        if grid[y][x]:
            continue
        seen.add(key)
        exterior[y][x] = 1
        stack.append((x + 1, y))
        stack.append((x - 1, y))
        stack.append((x, y + 1))
        stack.append((x, y - 1))

    solid = [[0] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if not exterior[y][x]:
                solid[y][x] = 1
    return solid


def _raster_fill_polygon(grid, w, h, ring_xy, min_x, min_y, span_x, span_y):
    """Fill convex (or simple) polygon into occupancy grid (scanline)."""
    n = len(ring_xy)
    if n < 3:
        return
    # Convert to pixel coords
    poly = []
    for x, y in ring_xy:
        ix = (x - min_x) / span_x * (w - 1)
        iy = (y - min_y) / span_y * (h - 1)
        poly.append((ix, iy))

    ys = [p[1] for p in poly]
    y0 = max(0, int(math.floor(min(ys))))
    y1 = min(h - 1, int(math.ceil(max(ys))))
    for y in range(y0, y1 + 1):
        nodes = []
        j = n - 1
        for i in range(n):
            yi, yj = poly[i][1], poly[j][1]
            xi, xj = poly[i][0], poly[j][0]
            if (yi < y and yj >= y) or (yj < y and yi >= y):
                t = (y - yi) / (yj - yi + 1e-30)
                nodes.append(xi + t * (xj - xi))
            j = i
        nodes.sort()
        for k in range(0, len(nodes) - 1, 2):
            x_a = int(math.floor(nodes[k]))
            x_b = int(math.ceil(nodes[k + 1]))
            for x in range(max(0, x_a), min(w, x_b + 1)):
                grid[y][x] = 1


def _moore_boundary(grid, w, h):
    """
    Moore-neighborhood outer contour → list of (x,y) cell centers in order.
    Returns [] if no boundary found.
    """
    start = None
    for y in range(h):
        for x in range(w):
            if grid[y][x] and (y == 0 or not grid[y - 1][x]):
                start = (x, y)
                break
        if start:
            break
    if not start:
        return []

    dirs = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]

    def occupied(x, y):
        return 0 <= x < w and 0 <= y < h and grid[y][x]

    contour = []
    x, y = start
    back_dir = 5
    for _ in range(w * h * 4):
        contour.append((x, y))
        start_search = (back_dir + 6) % 8
        found = None
        for k in range(8):
            di = (start_search + k) % 8
            nx, ny = x + dirs[di][0], y + dirs[di][1]
            if occupied(nx, ny):
                found = (nx, ny, di)
                break
        if found is None:
            break
        nx, ny, di = found
        if (nx, ny) == start and len(contour) > 2:
            break
        back_dir = di
        x, y = nx, ny
        if len(contour) > 2 and (x, y) == start:
            break

    if len(contour) > 2 and contour[0] == contour[-1]:
        contour = contour[:-1]
    return contour


def _ring_aabb_area(ring_xy):
    if not ring_xy:
        return 0.0
    xs = [p[0] for p in ring_xy]
    ys = [p[1] for p in ring_xy]
    return max(max(xs) - min(xs), 1e-9) * max(max(ys) - min(ys), 1e-9)


def footprint_concave_contour(pts_xy, plan_diag, max_verts=56, grid_res=192):
    """
    Concave footprint via top-view occupancy of verts.
    Hollow facades → dilate to close gaps → exterior flood-fill → solid mass → contour.
    If result is a thin strip vs convex hull, return None (caller falls back to convex).
    """
    if len(pts_xy) < 3:
        return None

    convex = footprint_convex_ring(pts_xy, plan_diag, max_verts=max_verts)
    if convex is None:
        return None
    convex_aabb = _ring_aabb_area(convex)
    convex_area = max(polygon_area_xy(convex), 1e-9)

    xs = [p[0] for p in pts_xy]
    ys = [p[1] for p in pts_xy]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    pad = 0.04 * max(span_x, span_y)
    min_x -= pad
    max_x += pad
    min_y -= pad
    max_y += pad
    span_x = max_x - min_x
    span_y = max_y - min_y

    if span_x >= span_y:
        w = grid_res
        h = max(8, int(round(grid_res * span_y / span_x)))
    else:
        h = grid_res
        w = max(8, int(round(grid_res * span_x / span_y)))

    grid = [[0] * w for _ in range(h)]
    for x, y in pts_xy:
        ix = int((x - min_x) / span_x * (w - 1))
        iy = int((y - min_y) / span_y * (h - 1))
        ix = max(0, min(w - 1, ix))
        iy = max(0, min(h - 1, iy))
        grid[iy][ix] = 1

    # Close gaps between facade verts (~0.5–1.5 m in world)
    cell = max(span_x / max(w - 1, 1), span_y / max(h - 1, 1))
    dilate_m = max(0.8, min(span_x, span_y) * 0.03)
    dilate_rounds = max(2, min(10, int(math.ceil(dilate_m / max(cell, 1e-6)))))
    grid = _dilate_grid(grid, w, h, rounds=dilate_rounds)
    grid = _fill_solid_from_shell(grid, w, h)

    solid_cells = sum(1 for y in range(h) for x in range(w) if grid[y][x])
    # Also compare against filled convex cell count
    hull_grid = [[0] * w for _ in range(h)]
    _raster_fill_polygon(hull_grid, w, h, convex, min_x, min_y, span_x, span_y)
    hull_cells = max(1, sum(1 for y in range(h) for x in range(w) if hull_grid[y][x]))
    if solid_cells < 0.35 * hull_cells:
        print(
            f"LOD3 contour: reject sparse solid "
            f"({solid_cells}/{hull_cells} cells < 35% of hull)"
        )
        return None

    cells = _moore_boundary(grid, w, h)
    if len(cells) < 3:
        return None

    ring = []
    for ix, iy in cells:
        wx = min_x + (ix + 0.5) / w * span_x
        wy = min_y + (iy + 0.5) / h * span_y
        ring.append((wx, wy))

    cleaned = [ring[0]]
    for p in ring[1:]:
        if math.hypot(p[0] - cleaned[-1][0], p[1] - cleaned[-1][1]) > 1e-9:
            cleaned.append(p)
    if len(cleaned) < 3:
        return None

    simplified = simplify_closed_ring(cleaned, plan_diag, max_verts=max_verts)
    area = polygon_area_xy(simplified)
    aabb = _ring_aabb_area(simplified)
    # Thin-strip / partial-facade failure (Downtown Apartment)
    if aabb < 0.45 * convex_aabb or area < 0.35 * convex_area:
        print(
            f"LOD3 contour: reject thin footprint "
            f"(aabb {aabb:.1f}/{convex_aabb:.1f}, area {area:.1f}/{convex_area:.1f})"
        )
        return None
    return simplified


def footprint_convex_ring(pts_xy, plan_diag, max_verts=56):
    """Convex hull footprint → simplified ring [(x,y), ...]."""
    from mathutils import geometry
    import mathutils

    pts2 = [mathutils.Vector((p[0], p[1])) for p in pts_xy]
    hull_idx = geometry.convex_hull_2d(pts2)
    if len(hull_idx) < 3:
        return None
    ring_xy = [(float(pts2[i].x), float(pts2[i].y)) for i in hull_idx]
    return simplify_closed_ring(ring_xy, plan_diag, max_verts=max_verts)


def extrude_ring_prism(ring, z0, z1, cap_bottom=True, cap_top=True):
    """Build verts + faces for a prism from 2D ring (mathutils.Vector xy)."""
    n = len(ring)
    verts = []
    for p in ring:
        verts.append((p.x, p.y, z0))
    for p in ring:
        verts.append((p.x, p.y, z1))

    faces = []
    if cap_bottom:
        faces.append(tuple(range(n - 1, -1, -1)))  # bottom
    if cap_top:
        faces.append(tuple(range(n, 2 * n)))  # top (terrace / roof)
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))
    return verts, faces


def build_slice_stack_shell(
    bpy,
    source,
    padding_frac,
    slices=8,
    max_footprint_verts=56,
    contour_mode="concave",
):
    """
    Height-slice stack with adaptive A(z) bands + per-band footprints
    (concave contour by default, convex hull fallback).
    """
    import mathutils

    world_pts = collect_world_verts(source)
    if len(world_pts) < 3:
        raise RuntimeError("Not enough vertices for silhouette")

    bounds = band_boundaries_adaptive_area(world_pts, slices)
    k = len(bounds) - 1

    xs = [p[0] for p in world_pts]
    ys = [p[1] for p in world_pts]
    plan_diag = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) or 1.0
    z_extent = bounds[-1] - bounds[0]
    overlap = max(z_extent * 0.01, 1e-4)

    band_specs = []
    for bi in range(k):
        z_lo = bounds[bi]
        z_hi = bounds[bi + 1]
        if z_hi - z_lo < 1e-4:
            continue

        z_sel_lo = z_lo - (overlap if bi > 0 else 0.0)
        z_sel_hi = z_hi + (overlap if bi < k - 1 else 0.0)

        pts_xy = [
            (x, y)
            for x, y, z in world_pts
            if z_sel_lo <= z <= z_sel_hi
        ]
        if len(pts_xy) < 3:
            continue

        ring_xy = None
        mode_used = contour_mode
        if contour_mode == "concave":
            ring_xy = footprint_concave_contour(
                pts_xy, plan_diag, max_verts=max_footprint_verts
            )
        if ring_xy is None:
            ring_xy = footprint_convex_ring(
                pts_xy, plan_diag, max_verts=max_footprint_verts
            )
            mode_used = "convex"
        if ring_xy is None or len(ring_xy) < 3:
            continue

        ring = [mathutils.Vector((x, y)) for x, y in ring_xy]
        ring = expand_polygon(ring, padding_frac)
        band_specs.append((bi, z_lo, z_hi, ring, mode_used))

    band_objects = []
    n_bands = len(band_specs)
    for local_i, (bi, z_lo, z_hi, ring, mode_used) in enumerate(band_specs):
        cap_bottom = local_i == 0
        cap_top = True
        verts, faces = extrude_ring_prism(
            ring, z_lo, z_hi, cap_bottom=cap_bottom, cap_top=cap_top
        )
        mesh = bpy.data.meshes.new(f"Lod3Slice{bi}Mesh")
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(f"Lod3Slice{bi}", mesh)
        bpy.context.collection.objects.link(obj)
        band_objects.append(obj)
        print(
            f"LOD3 slice {bi}: z=[{z_lo:.3f},{z_hi:.3f}] "
            f"footprint={len(ring)} pts ({mode_used}) → {len(mesh.polygons)} faces "
            f"(cap_bot={cap_bottom}, bands={n_bands})"
        )

    if not band_objects:
        raise RuntimeError("Height-slice stack produced no bands")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in band_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = band_objects[0]
    if len(band_objects) > 1:
        bpy.ops.object.join()
    shell = bpy.context.view_layer.objects.active
    shell.name = "Lod3Silhouette"

    bpy.ops.object.select_all(action="DESELECT")
    shell.select_set(True)
    bpy.context.view_layer.objects.active = shell
    me = shell.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    me.uv_layers.active = me.uv_layers[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=1.151917,
        island_margin=0.02,
        area_weight=1.0,
        correct_aspect=True,
        scale_to_bounds=True,
    )
    bpy.ops.object.mode_set(mode="OBJECT")

    tris = sum(len(p.vertices) - 2 for p in shell.data.polygons)
    print(
        f"LOD3 slice-stack: {len(band_objects)} adaptive bands → {tris} tris, "
        f"plan_diag={plan_diag:.2f}, contour={contour_mode}"
    )
    return shell, len(band_objects)


def _uv_smart_project(bpy, shell):
    bpy.ops.object.select_all(action="DESELECT")
    shell.select_set(True)
    bpy.context.view_layer.objects.active = shell
    me = shell.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    me.uv_layers.active = me.uv_layers[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=1.151917,
        island_margin=0.02,
        area_weight=1.0,
        correct_aspect=True,
        scale_to_bounds=True,
    )
    bpy.ops.object.mode_set(mode="OBJECT")


def _silhouette_ring_2d(pts2, plan_diag, max_verts, contour_mode):
    """2D silhouette ring from projected points; concave preferred, convex fallback."""
    ring = None
    mode = contour_mode
    if contour_mode == "concave":
        ring = footprint_concave_contour(pts2, plan_diag, max_verts=max_verts)
    if ring is None:
        ring = footprint_convex_ring(pts2, plan_diag, max_verts=max_verts)
        mode = "convex"
    return ring, mode


def silhouette_side_profile(pts_uv, max_verts=48, n_bins=96):
    """
    Side-view envelope for multi-roof buildings.
    pts_uv = (horizontal, vertical) e.g. (x,z) or (y,z).
    Per u-column take vmin/vmax → step-function roof/ground silhouette.
    Convex hull would fill setbacks; this keeps them.
    """
    if len(pts_uv) < 3:
        return None
    us = [p[0] for p in pts_uv]
    vs = [p[1] for p in pts_uv]
    u0, u1 = min(us), max(us)
    v0, v1 = min(vs), max(vs)
    if u1 - u0 < 1e-6 or v1 - v0 < 1e-6:
        return None

    n_bins = max(8, min(n_bins, max_verts * 3))
    # Accumulate min/max v per bin
    vmin = [None] * n_bins
    vmax = [None] * n_bins
    span = u1 - u0
    for u, v in pts_uv:
        bi = int((u - u0) / span * (n_bins - 1e-9))
        bi = max(0, min(n_bins - 1, bi))
        if vmin[bi] is None:
            vmin[bi] = v
            vmax[bi] = v
        else:
            vmin[bi] = min(vmin[bi], v)
            vmax[bi] = max(vmax[bi], v)

    # Fill small gaps by propagating neighbors
    for i in range(1, n_bins):
        if vmin[i] is None and vmin[i - 1] is not None:
            vmin[i], vmax[i] = vmin[i - 1], vmax[i - 1]
    for i in range(n_bins - 2, -1, -1):
        if vmin[i] is None and vmin[i + 1] is not None:
            vmin[i], vmax[i] = vmin[i + 1], vmax[i + 1]

    bottom = []
    top = []
    for i in range(n_bins):
        if vmin[i] is None:
            continue
        uc = u0 + (i + 0.5) / n_bins * span
        bottom.append((uc, vmin[i]))
        top.append((uc, vmax[i]))
    if len(bottom) < 2:
        return None

    # Collapse runs of equal height on the roofline for fewer verts
    def collapse(poly, is_top):
        out = [poly[0]]
        for p in poly[1:]:
            prev = out[-1]
            if abs(p[1] - prev[1]) < (v1 - v0) * 0.002:
                # extend flat run
                out[-1] = (p[0], prev[1])
            else:
                # step: add corner at previous u with new height, then new point
                if is_top:
                    out.append((prev[0], p[1]))
                else:
                    out.append((prev[0], p[1]))
                out.append(p)
        return out

    bottom_c = collapse(bottom, False)
    top_c = collapse(top, True)
    ring = bottom_c + list(reversed(top_c))
    diag = math.hypot(span, v1 - v0) or 1.0
    return simplify_closed_ring(ring, diag, max_verts=max_verts)


def _make_extruded_volume(bpy, name, ring_uv, axis, u_min, u_max, v_min, v_max, depth0, depth1):
    """
    Extrude a 2D ring in (u,v) across [depth0, depth1] along axis ('X'|'Y'|'Z').
    ring_uv: list of (u, v) in the plane perpendicular to axis.
    """
    import mathutils

    n = len(ring_uv)
    verts = []
    for u, v in ring_uv:
        if axis == "Z":
            verts.append((u, v, depth0))
        elif axis == "Y":
            verts.append((u, depth0, v))
        else:  # X
            verts.append((depth0, u, v))
    for u, v in ring_uv:
        if axis == "Z":
            verts.append((u, v, depth1))
        elif axis == "Y":
            verts.append((u, depth1, v))
        else:
            verts.append((depth1, u, v))

    faces = []
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))

    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    # Ensure outward-ish normals
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    try:
        bpy.ops.mesh.normals_make_consistent(inside=False)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def _boolean_intersect(bpy, a, b):
    """Exact boolean INTERSECT a ∩= b; returns a, removes b."""
    bpy.ops.object.select_all(action="DESELECT")
    a.select_set(True)
    bpy.context.view_layer.objects.active = a
    mod = a.modifiers.new(name="Lod3VH", type="BOOLEAN")
    mod.operation = "INTERSECT"
    mod.object = b
    try:
        mod.solver = "EXACT"
    except Exception:
        pass
    try:
        if hasattr(mod, "use_self"):
            mod.use_self = True
    except Exception:
        pass
    try:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except Exception as e:
        # Fallback: FLOAT solver
        try:
            a.modifiers.remove(mod)
        except Exception:
            pass
        mod = a.modifiers.new(name="Lod3VHFloat", type="BOOLEAN")
        mod.operation = "INTERSECT"
        mod.object = b
        try:
            mod.solver = "FLOAT"
        except Exception:
            pass
        bpy.ops.object.modifier_apply(modifier=mod.name)
        print(f"LOD3 VH: Exact failed ({e}), used FLOAT")
    bpy.data.objects.remove(b, do_unlink=True)
    return a


def _decimate_if_needed(bpy, obj, max_tris=1200):
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tris <= max_tris:
        return tris
    ratio = max(0.05, min(0.95, max_tris / max(tris, 1)))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new(name="Lod3Decimate", type="DECIMATE")
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=mod.name)
    tris2 = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"LOD3 VH: decimate {tris} → {tris2} tris (ratio={ratio:.3f})")
    return tris2


def build_visual_hull_shell(
    bpy,
    source,
    padding_frac=0.0,
    max_footprint_verts=48,
    contour_mode="concave",
    n_views=5,
):
    """
    Visual hull lite: intersect extruded orthographic silhouettes.
    Top (XY) + side (XZ/YZ) captures multiple roof heights; optional diagonals.
    Returns (shell, view_count).
    """
    world_pts = collect_world_verts(source)
    if len(world_pts) < 3:
        raise RuntimeError("Not enough vertices for visual hull")

    xs = [p[0] for p in world_pts]
    ys = [p[1] for p in world_pts]
    zs = [p[2] for p in world_pts]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z, max_z = min(zs), max(zs)
    # Slight AABB pad so extrusions fully contain the source
    pad_x = max((max_x - min_x) * 0.01, 0.05)
    pad_y = max((max_y - min_y) * 0.01, 0.05)
    pad_z = max((max_z - min_z) * 0.01, 0.05)
    min_x -= pad_x
    max_x += pad_x
    min_y -= pad_y
    max_y += pad_y
    min_z -= pad_z
    max_z += pad_z

    plan_diag_xy = math.hypot(max_x - min_x, max_y - min_y) or 1.0
    plan_diag_xz = math.hypot(max_x - min_x, max_z - min_z) or 1.0
    plan_diag_yz = math.hypot(max_y - min_y, max_z - min_z) or 1.0

    # View specs: (name, axis, pts2 builder, diag, depth0, depth1)
    views = []

    # Top — XY extruded along Z (plan)
    pts_xy = [(p[0], p[1]) for p in world_pts]
    views.append(("topZ", "Z", pts_xy, plan_diag_xy, min_z, max_z))

    # Sides — capture roof steps
    pts_xz = [(p[0], p[2]) for p in world_pts]
    pts_yz = [(p[1], p[2]) for p in world_pts]
    views.append(("sideY", "Y", pts_xz, plan_diag_xz, min_y, max_y))
    views.append(("sideX", "X", pts_yz, plan_diag_yz, min_x, max_x))

    if n_views >= 5:
        # Opposite sides use same projected points (silhouette identical for opaque hull)
        # Extra constraint from a second extrusion direction helps carving — use
        # slightly inset depths via the same rings (still useful with concave rings).
        pass  # 3 orthographic axes already cover ± via full-depth extrusion

    if n_views >= 9:
        # Diagonal plan views: rotate XY 45° then extrude Z — weak; skip for lite.
        # Instead add diagonal side: project onto (x+y, z) and (x-y, z) planes.
        s2 = math.sqrt(2.0)
        pts_d1 = [((p[0] + p[1]) / s2, p[2]) for p in world_pts]
        pts_d2 = [((p[0] - p[1]) / s2, p[2]) for p in world_pts]
        # Extrude diagonally in XY — approximate by extruding along X and Y with
        # diagonal silhouette is non-axis; skip complex frame change for lite.
        # Keep axis-aligned 3-view hull; diagonals deferred.
        _ = (pts_d1, pts_d2)

    volumes = []
    for name, axis, pts2, diag, d0, d1 in views:
        # Side views: height-profile (keeps multiple roofs). Top: concave/convex plan.
        if axis in ("X", "Y"):
            ring = silhouette_side_profile(pts2, max_verts=max_footprint_verts)
            mode = "profile"
            if ring is None:
                ring, mode = _silhouette_ring_2d(
                    pts2, diag, max_footprint_verts, contour_mode
                )
        else:
            ring, mode = _silhouette_ring_2d(
                pts2, diag, max_footprint_verts, contour_mode
            )
        if ring is None or len(ring) < 3:
            print(f"LOD3 VH: skip view {name} — no ring")
            continue
        import mathutils

        ring_v = [mathutils.Vector((u, v)) for u, v in ring]
        if axis == "Z":
            ring_v = expand_polygon(ring_v, padding_frac)
        ring = [(float(p.x), float(p.y)) for p in ring_v]
        obj = _make_extruded_volume(
            bpy, f"Lod3VH_{name}", ring, axis, 0, 0, 0, 0, d0, d1
        )
        volumes.append(obj)
        print(
            f"LOD3 VH view {name}: axis={axis} ring={len(ring)} ({mode}) "
            f"depth=[{d0:.2f},{d1:.2f}]"
        )

    if len(volumes) < 2:
        raise RuntimeError("Visual hull needs ≥2 silhouette volumes")

    shell = volumes[0]
    for other in volumes[1:]:
        print(f"LOD3 VH: intersect {shell.name} ∩ {other.name}")
        shell = _boolean_intersect(bpy, shell, other)

    shell.name = "Lod3Silhouette"
    # Cleanup + voxel remesh → manifold shell Cycles can bake onto
    bpy.ops.object.select_all(action="DESELECT")
    shell.select_set(True)
    bpy.context.view_layer.objects.active = shell
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    try:
        bpy.ops.mesh.remove_doubles(threshold=1e-4)
    except Exception:
        pass
    try:
        bpy.ops.mesh.dissolve_degenerate(threshold=1e-5)
    except Exception:
        pass
    try:
        bpy.ops.mesh.normals_make_consistent(inside=False)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode="OBJECT")

    try:
        extent = max(max_x - min_x, max_y - min_y, max_z - min_z, 1.0)
        voxel = max(extent / 48.0, 0.15)
        shell.data.remesh_voxel_size = voxel
        shell.data.remesh_voxel_adaptivity = 0.0
        bpy.ops.object.voxel_remesh()
        print(f"LOD3 VH: voxel remesh size={voxel:.3f}")
    except Exception as e:
        print(f"LOD3 VH: voxel remesh skipped ({e})")

    tris = _decimate_if_needed(bpy, shell, max_tris=1200)
    if tris < 4:
        raise RuntimeError("Visual hull degenerate after boolean/decimate")

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    try:
        bpy.ops.mesh.normals_make_consistent(inside=False)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode="OBJECT")

    _uv_smart_project(bpy, shell)
    print(f"LOD3 visual-hull: {len(volumes)} views → {tris} tris")
    return shell, len(volumes)


def ensure_cycles(bpy):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = "GPU"
        print("Cycles GPU enabled")
    except Exception as e:
        print(f"Cycles GPU setup skipped: {e}")
        scene.cycles.device = "CPU"


def ensure_basecolor_for_bake(bpy, obj):
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None:
            continue
        try:
            mat.use_nodes = True
        except Exception:
            pass
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        base = bsdf.inputs.get("Base Color")
        if base is None or base.is_linked:
            continue
        rgb = nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = tuple(base.default_value)
        rgb.location = (bsdf.location.x - 300, bsdf.location.y + 100)
        links.new(rgb.outputs[0], base)


def route_basecolor_to_emit(bpy, obj):
    """Temporarily Base Color → Emission for reliable color bake."""
    backups = []
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not mat.node_tree:
            continue
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None)
        if not bsdf or not out:
            continue
        surf_links = list(out.inputs["Surface"].links)
        surface_from = surf_links[0].from_socket if surf_links else None
        base = bsdf.inputs["Base Color"]
        emit = nodes.new("ShaderNodeEmission")
        emit.location = (bsdf.location.x + 200, bsdf.location.y)
        if base.is_linked:
            links.new(base.links[0].from_socket, emit.inputs["Color"])
        else:
            emit.inputs["Color"].default_value = tuple(base.default_value)
        emit.inputs["Strength"].default_value = 1.0
        for l in list(out.inputs["Surface"].links):
            links.remove(l)
        links.new(emit.outputs["Emission"], out.inputs["Surface"])
        backups.append((mat, out, surface_from, emit))
    return backups


def route_white_emit(bpy, obj):
    """Temporarily pure white Emission for coverage bake."""
    backups = []
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or not mat.node_tree:
            continue
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None)
        if not out:
            continue
        surf_links = list(out.inputs["Surface"].links)
        surface_from = surf_links[0].from_socket if surf_links else None
        emit = nodes.new("ShaderNodeEmission")
        emit.location = (0, 0)
        emit.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        emit.inputs["Strength"].default_value = 1.0
        for l in list(out.inputs["Surface"].links):
            links.remove(l)
        links.new(emit.outputs["Emission"], out.inputs["Surface"])
        backups.append((mat, out, surface_from, emit))
    return backups


def restore_emit_route(backups):
    for mat, out, surface_from, emit in backups:
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        for l in list(out.inputs["Surface"].links):
            links.remove(l)
        if surface_from:
            links.new(surface_from, out.inputs["Surface"])
        nodes.remove(emit)


def save_image(img, path):
    path = os.path.abspath(path).replace("\\", "/")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    img.filepath_raw = path
    img.file_format = "PNG"
    try:
        img.save()
    except Exception as e:
        print(f"WARN: img.save failed ({e}), trying save_render")
        img.save_render(filepath=path)
    try:
        img.pack()
        img.reload()
    except Exception:
        pass
    size = os.path.getsize(path) if os.path.isfile(path) else 0
    print(f"Saved {path} ({size} B)")


def prepare_shell_for_bake(bpy, shell, source):
    """
    Inflate shell so it encloses the source; outward normals + long rays
    (selected→active casts along normals toward nearby high-poly).
    """
    bpy.ops.object.select_all(action="DESELECT")
    shell.select_set(True)
    bpy.context.view_layer.objects.active = shell
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    smin, smax = world_bounds(source)
    center = (smin + smax) * 0.5
    scale = 1.03
    me = shell.data
    inv = shell.matrix_world.inverted()
    for v in me.vertices:
        w = shell.matrix_world @ v.co
        w = center + (w - center) * scale
        v.co = inv @ w
    me.update()

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    # Same as slice-stack: outward normals. Cycles selected→active casts
    # opposite to normals (into the hull) toward the high-poly.
    try:
        bpy.ops.mesh.normals_make_consistent(inside=False)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"LOD3 bake prep: inflated shell ×{scale:.3f}, outward normals")


def ensure_bake_target_image(bpy, shell, image):
    """
    Blender 5: voxel remesh clears materials; bake needs an ACTIVE Image Texture node.
    Rebuild a clean 1-slot material every bake pass.
    """
    while shell.data.materials:
        shell.data.materials.pop(index=0)
    mat = bpy.data.materials.new("Lod3BakeTarget")
    try:
        mat.use_nodes = True
    except Exception:
        pass
    shell.data.materials.append(mat)
    shell.active_material_index = 0

    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.location = (-300, 0)
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    for n in nodes:
        n.select = False
    tex.select = True
    nodes.active = tex
    return tex


def bake_selected_to_active(bpy, source, shell, image):
    ensure_bake_target_image(bpy, shell, image)

    bpy.ops.object.select_all(action="DESELECT")
    source.select_set(True)
    shell.select_set(True)
    bpy.context.view_layer.objects.active = shell
    shell.active_material_index = 0

    scene = bpy.context.scene
    scene.cycles.bake_type = "EMIT"
    bake_settings = scene.render.bake
    bake_settings.margin = 16
    bake_settings.use_selected_to_active = True
    bake_settings.use_cage = False
    bake_settings.use_clear = True

    extent = max((world_bounds(source)[1] - world_bounds(source)[0]).length, 1.0)
    bake_settings.max_ray_distance = max(16.0, extent * 0.75)
    bake_settings.cage_extrusion = max(0.5, extent * 0.05)

    print(
        f"Baking EMIT selected→active (ray={bake_settings.max_ray_distance:.2f})..."
    )
    bpy.ops.object.bake(
        type="EMIT",
        margin=16,
        use_clear=True,
        use_selected_to_active=True,
        use_cage=False,
        cage_extrusion=0.0,
        max_ray_distance=bake_settings.max_ray_distance,
    )
    print("Bake EMIT done")


def dilate_alpha_with_bleed(pixels, width, height, radius=3, threshold=0.5):
    """
    Dilate opaque alpha and bleed RGB from nearest opaque texel.
    Prevents black holes after coverage dilate (alpha=1 but RGB still miss-black).
    """
    if radius <= 0:
        return
    n = width * height
    mask = [0] * n
    for i in range(n):
        if pixels[i * 4 + 3] >= threshold:
            mask[i] = 1

    # (r,g,b,a) updates for newly filled texels
    fills = {}
    for y in range(height):
        for x in range(width):
            i = y * width + x
            if mask[i]:
                continue
            best_d2 = None
            best_rgb = None
            for dy in range(-radius, radius + 1):
                yy = y + dy
                if yy < 0 or yy >= height:
                    continue
                for dx in range(-radius, radius + 1):
                    xx = x + dx
                    if xx < 0 or xx >= width:
                        continue
                    j = yy * width + xx
                    if not mask[j]:
                        continue
                    d2 = dx * dx + dy * dy
                    if best_d2 is None or d2 < best_d2:
                        best_d2 = d2
                        o = j * 4
                        best_rgb = (pixels[o], pixels[o + 1], pixels[o + 2])
            if best_rgb is not None:
                fills[i] = best_rgb

    for i, rgb in fills.items():
        o = i * 4
        pixels[o] = rgb[0]
        pixels[o + 1] = rgb[1]
        pixels[o + 2] = rgb[2]
        pixels[o + 3] = 1.0


def compose_rgba_with_coverage(color_img, coverage_img, threshold=0.05, dilate_px=3):
    """RGB from color bake, A from coverage; dilate+bleed to kill black corner holes."""
    w, h = color_img.size
    if coverage_img.size[0] != w or coverage_img.size[1] != h:
        raise RuntimeError("Coverage image size mismatch")

    color_img.pixels[:]  # ensure loaded
    cov = list(coverage_img.pixels)
    col = list(color_img.pixels)
    n = w * h
    for i in range(n):
        o = i * 4
        lum = 0.2126 * cov[o] + 0.7152 * cov[o + 1] + 0.0722 * cov[o + 2]
        # Also accept color bake hits (non-black) even if coverage is soft
        color_lum = 0.2126 * col[o] + 0.7152 * col[o + 1] + 0.0722 * col[o + 2]
        a = 1.0 if (lum >= threshold or color_lum >= threshold) else 0.0
        if a < 0.5:
            col[o] = 0.0
            col[o + 1] = 0.0
            col[o + 2] = 0.0
        col[o + 3] = a

    dilate_alpha_with_bleed(col, w, h, radius=dilate_px, threshold=0.5)
    color_img.pixels = col
    try:
        color_img.update()
    except Exception:
        pass
    opaque = sum(1 for i in range(n) if col[i * 4 + 3] >= 0.5)
    print(f"LOD3 alpha: {opaque}/{n} opaque texels after bleed-dilate={dilate_px}px")


def assign_shell_material(bpy, shell, albedo):
    shell.data.materials.clear()
    mat = bpy.data.materials.new("Lod3SilhouetteMaterial")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = albedo
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    elif "Specular" in bsdf.inputs:
        bsdf.inputs["Specular"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.85

    # MASK contract: CLIP / HASHED — never OPAQUE
    try:
        mat.blend_method = "CLIP"
    except Exception:
        try:
            mat.blend_method = "HASHED"
        except Exception:
            pass
    try:
        mat.alpha_threshold = 0.5
    except Exception:
        pass
    try:
        # Blender 4.2+ EEVEE
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "DITHERED"
    except Exception:
        pass

    shell.data.materials.append(mat)


def main():
    args = parse_args(sys.argv)
    import bpy

    clear_scene(bpy)
    bpy.ops.import_scene.gltf(filepath=args.input)
    source = join_all_meshes(bpy, "Lod3Source")
    ensure_basecolor_for_bake(bpy, source)

    slices = max(1, int(args.slices))
    method = str(args.method)
    meta_count = 0
    shell = None

    if method == "visual-hull":
        try:
            shell, meta_count = build_visual_hull_shell(
                bpy,
                source,
                padding_frac=float(args.padding),
                max_footprint_verts=int(args.max_footprint_verts),
                contour_mode=str(args.contour),
                n_views=int(args.vh_views),
            )
        except Exception as e:
            print(f"LOD3 visual-hull FAILED ({e}) — falling back to slices")
            # Remove any leftover VH temps
            for obj in list(bpy.data.objects):
                if obj != source and obj.name.startswith("Lod3VH"):
                    bpy.data.objects.remove(obj, do_unlink=True)
            method = "slices"

    if shell is None:
        shell, meta_count = build_slice_stack_shell(
            bpy,
            source,
            float(args.padding),
            slices=slices,
            max_footprint_verts=int(args.max_footprint_verts),
            contour_mode=str(args.contour),
        )
        method = "slices"

    prepare_shell_for_bake(bpy, shell, source)
    ensure_cycles(bpy)

    os.makedirs(args.faces_dir, exist_ok=True)
    res = int(args.resolution)
    albedo = bpy.data.images.new("Lod3Albedo", width=res, height=res, alpha=True)
    coverage = bpy.data.images.new("Lod3Coverage", width=res, height=res, alpha=True)

    # 1) Color bake
    backups = route_basecolor_to_emit(bpy, source)
    try:
        bake_selected_to_active(bpy, source, shell, albedo)
    finally:
        restore_emit_route(backups)

    # 2) Coverage bake (white emit → hit = opaque)
    cov_backups = route_white_emit(bpy, source)
    try:
        bake_selected_to_active(bpy, source, shell, coverage)
    finally:
        restore_emit_route(cov_backups)

    dilate_px = 4 if res >= 2048 else 3
    compose_rgba_with_coverage(albedo, coverage, threshold=0.04, dilate_px=dilate_px)

    albedo_path = os.path.join(args.faces_dir, "albedo.png")
    save_image(albedo, albedo_path)
    albedo.filepath = albedo_path

    # Flip normals back outward for correct realtime shading
    bpy.ops.object.select_all(action="DESELECT")
    shell.select_set(True)
    bpy.context.view_layer.objects.active = shell
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    try:
        bpy.ops.mesh.normals_make_consistent(inside=False)
    except Exception:
        pass
    bpy.ops.object.mode_set(mode="OBJECT")

    assign_shell_material(bpy, shell, albedo)

    # Keep only shell
    for obj in list(bpy.data.objects):
        if obj != shell:
            bpy.data.objects.remove(obj, do_unlink=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
    )

    tris = sum(len(p.vertices) - 2 for p in shell.data.polygons)
    print(
        f"Exported LOD3 silhouette: {args.output} "
        f"({tris} tris, method={method}, meta={meta_count}, MASK alpha)"
    )


if __name__ == "__main__":
    main()
