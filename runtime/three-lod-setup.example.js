/**
 * Example: wire lod0.glb + impostor.glb in Three.js.
 * Impostor.glb IS the game object (textured AABB box, ~8–12 tris).
 * The engine only switches which mesh is visible by distance.
 *
 * Usage (ESM / R3F / vanilla):
 *   import { setupBuildingLod } from './three-lod-setup.example.js';
 *   const lod = await setupBuildingLod(loader, {
 *     lod0Url: './output/building/lod0.glb',
 *     impostorUrl: './output/building/impostor.glb',
 *     switchDistance: 80,
 *   });
 *   scene.add(lod);
 */

import { LOD } from 'three';

/**
 * @param {{ loadAsync: (url: string) => Promise<{ scene: import('three').Object3D }> }} loader GLTFLoader instance
 * @param {{ lod0Url: string, impostorUrl: string, switchDistance?: number }} urls
 * @returns {Promise<import('three').LOD>}
 */
export async function setupBuildingLod(loader, urls) {
  const switchDistance = urls.switchDistance ?? 80;

  const [near, far] = await Promise.all([
    loader.loadAsync(urls.lod0Url),
    loader.loadAsync(urls.impostorUrl),
  ]);

  const lod = new LOD();
  lod.name = 'BuildingLOD';

  // Level 0 = closest (shown when camera distance <= switchDistance)
  lod.addLevel(near.scene, 0);
  // Level 1 = far (shown when distance > switchDistance)
  lod.addLevel(far.scene, switchDistance);

  // Optional: read pipeline metadata if you loaded pack.glb extras instead
  lod.userData.hpPipeline = {
    near: urls.lod0Url,
    far: urls.impostorUrl,
    switchDistance,
  };

  return lod;
}

/**
 * Pure data hint for custom engines (Unity/Unreal/Godot):
 * load these two files and swap by camera distance — no runtime baking needed.
 */
export function getLodManifest(assetDir = '.') {
  return {
    near: `${assetDir}/lod0.glb`,
    far: `${assetDir}/impostor.glb`,
    // Suggested starting distance in world units (tune per scene scale)
    switchDistance: 80,
    note: 'impostor.glb is already a renderable mesh (box + baked face textures).',
  };
}
