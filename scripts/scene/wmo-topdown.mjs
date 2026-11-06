// Rasterizes a map's placed WMOs top-down onto a pixel buffer with a depth
// buffer, one pixel per world unit, in the same projection as the terrain
// bake (row = maxX - x, col = maxY - y). The client's outdoor minimap is the
// engine rendering the 3D world straight down with depth; this reproduces it
// offline: the topmost surface wins every pixel, so a roof occludes the floor
// beneath. Unlit: each pixel is the material's diffuse texture (the client's
// minimap is a lit render; a light pass is a later refinement).
//
// Group geometry comes from loadWmo (the 3D scene's loader), placement
// transforms match export-scene's (position + rotated local space), and
// screen/depth conventions match the terrain bake.

import { findChunk, readChunks, readFloats } from './chunks.mjs';
import { rotateByQuaternion } from './placement.mjs';
import { decodeBlp } from './textures.mjs';
import { groupFileName, loadWmo, WMO_MATERIAL_FLAG_CLAMP_S, WMO_MATERIAL_FLAG_CLAMP_T, WMO_MATERIAL_FLAG_UNCULLED } from './wmo.mjs';

// A face wins a pixel a hair below the recorded surface: at equal height the
// later writer keeps the pixel (a building's floor drawn on the terrain).
const DEPTH_EPSILON = 0.01;
const NO_TEXTURE_COLOUR = 127;
const WMO_BLEND_OPAQUE = 0;
const WMO_BLEND_ALPHA_KEY = 1;
const WMO_BLEND_ALPHA = 2;

// A WMO root's combined extent (its MOHD group count plus each group file's
// MOGP bounding box), in the root's local space — for the bake's bounds
// without a full geometry load.
export function readWmoBounds(readFile, rootName) {
  const buffer = readFile(rootName);
  if (!buffer) throw new Error(`Missing WMO root ${rootName}`);
  const mohd = findChunk(readChunks(buffer), 'MOHD');
  if (!mohd) throw new Error(`WMO root ${rootName} is missing its MOHD.`);
  const groupCount = mohd.readUInt32LE(0x04);
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let index = 0; index < groupCount; index += 1) {
    const groupBuffer = readFile(groupFileName(rootName, index));
    const mogp = groupBuffer ? findChunk(readChunks(groupBuffer), 'MOGP') : null;
    if (!mogp || mogp.length < 0x18) continue;
    const [minX, minY, minZ, maxX, maxY, maxZ] = readFloats(mogp, 0x0c, 6);
    bounds.minX = Math.min(bounds.minX, minX); bounds.maxX = Math.max(bounds.maxX, maxX);
    bounds.minY = Math.min(bounds.minY, minY); bounds.maxY = Math.max(bounds.maxY, maxY);
    bounds.minZ = Math.min(bounds.minZ, minZ); bounds.maxZ = Math.max(bounds.maxZ, maxZ);
  }
  return bounds;
}

// `readWmoBounds` through one placement's transform, in world coordinates.
export function wmoPlacementBounds(readFile, placement) {
  const { minX, minY, minZ, maxX, maxY, maxZ } = readWmoBounds(readFile, placement.name);
  if (!Number.isFinite(minX)) return null;
  const scale = placement.scale ?? 1;
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) {
        const [wx, wy, wz] = rotateByQuaternion([x * scale, y * scale, z * scale], placement.rotation);
        const world = [wx + placement.position[0], wy + placement.position[1], wz + placement.position[2]];
        bounds.minX = Math.min(bounds.minX, world[0]); bounds.maxX = Math.max(bounds.maxX, world[0]);
        bounds.minY = Math.min(bounds.minY, world[1]); bounds.maxY = Math.max(bounds.maxY, world[1]);
        bounds.minZ = Math.min(bounds.minZ, world[2]); bounds.maxZ = Math.max(bounds.maxZ, world[2]);
      }
    }
  }
  return bounds;
}

// The material a triangle's first vertex indexes into, per batch (a group's
// indices run batch by batch).
function triangleMaterials(group) {
  if (group._triangleMaterials) return group._triangleMaterials;
  const count = group.indices.length / 3;
  const materials = new Uint16Array(count);
  group.batches.forEach((batch) => {
    const first = Math.floor(batch.indexStart / 3);
    const last = Math.ceil((batch.indexStart + batch.indexCount) / 3);
    for (let index = first; index < last && index < count; index += 1) materials[index] = batch.materialIndex;
  });
  group._triangleMaterials = materials;
  return materials;
}

// Transforms a group's vertices into world space for one placement (the same
// transform the 3D scene applies: local point rotated, then translated), and
// rasterizes its up-facing triangles over the pixels they cover, keeping the
// topmost surface per pixel.
function renderGroup({ group, wmo, placement, textures, image, depth, bounds, stats, placementStats }) {
  const vertexCount = group.positions.length / 3;
  const triangleCount = group.indices.length / 3;
  if (!triangleCount) return;
  const [px, py, pz] = placement.position;
  const scale = placement.scale ?? 1;
  const [qx, qy, qz, qw] = placement.rotation;
  const world = new Float32Array(vertexCount * 3);
  const local = group.positions;
  for (let index = 0; index < vertexCount; index += 1) {
    const x = local[index * 3] * scale;
    const y = local[index * 3 + 1] * scale;
    const z = local[index * 3 + 2] * scale;
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    world[index * 3] = x + qw * tx + qy * tz - qz * ty + px;
    world[index * 3 + 1] = y + qw * ty + qz * tx - qx * tz + py;
    world[index * 3 + 2] = z + qw * tz + qx * ty - qy * tx + pz;
  }

  const uvs = group.uvs;
  const hasUv = uvs.length >= vertexCount * 2;
  const colors = group.colors; // BGRA, only with baked vertex lighting.
  const materials = triangleMaterials(group);
  const { width, height, pixels } = image;
  const maxRow = height - 1;
  const maxCol = width - 1;
  const indices = group.indices;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const ia = indices[triangle * 3] * 3;
    const ib = indices[triangle * 3 + 1] * 3;
    const ic = indices[triangle * 3 + 2] * 3;
    const ax = world[ia]; const ay = world[ia + 1]; const az = world[ia + 2];
    const bx = world[ib]; const by = world[ib + 1]; const bz = world[ib + 2];
    const cx = world[ic]; const cy = world[ic + 1]; const cz = world[ic + 2];

    // The camera looks straight down: only faces turned towards it (and the
    // double-sided ones) can be the topmost surface.
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const material = wmo.materials[materials[triangle]];
    const unculled = material.flags & WMO_MATERIAL_FLAG_UNCULLED;
    if (nz <= 0 && !unculled) {
      stats.culled += 1;
      if (placementStats) placementStats.culled += 1;
      continue;
    }

    // World point to image pixel (the terrain bake's projection).
    const r0 = bounds.maxX - ax; const c0 = bounds.maxY - ay;
    const r1 = bounds.maxX - bx; const c1 = bounds.maxY - by;
    const r2 = bounds.maxX - cx; const c2 = bounds.maxY - cy;
    let minRow = r0 < r1 ? (r0 < r2 ? r0 : r2) : (r1 < r2 ? r1 : r2);
    let maxRowT = r0 > r1 ? (r0 > r2 ? r0 : r2) : (r1 > r2 ? r1 : r2);
    let minCol = c0 < c1 ? (c0 < c2 ? c0 : c2) : (c1 < c2 ? c1 : c2);
    let maxColT = c0 > c1 ? (c0 > c2 ? c0 : c2) : (c1 > c2 ? c1 : c2);
    if (minRow > maxRowT || minCol > maxColT) continue;
    const rowTop = Math.max(0, Math.floor(minRow));
    const rowBottom = Math.min(maxRow, Math.ceil(maxRowT));
    const colLeft = Math.max(0, Math.floor(minCol));
    const colRight = Math.min(maxCol, Math.ceil(maxColT));

    // Barycentric basis for the point-in-triangle test and the attribute
    // interpolation, vertex-relative (a is the origin) in image space
    // (X = column, Y = row). denom is the signed double-area of the triangle;
    // a zero means it is vertical and projects to no top-down extent.
    const v0x = c1 - c0, v0y = r1 - r0; // b - a
    const v1x = c2 - c0, v1y = r2 - r0; // c - a
    const denom = v0x * v1y - v1x * v0y;
    if (denom === 0) continue;
    const invDenom = 1 / denom;
    const u0 = hasUv ? uvs[indices[triangle * 3] * 2] : 0;
    const v0 = hasUv ? uvs[indices[triangle * 3] * 2 + 1] : 0;
    const u1 = hasUv ? uvs[indices[triangle * 3 + 1] * 2] : 0;
    const v1 = hasUv ? uvs[indices[triangle * 3 + 1] * 2 + 1] : 0;
    const u2 = hasUv ? uvs[indices[triangle * 3 + 2] * 2] : 0;
    const v2 = hasUv ? uvs[indices[triangle * 3 + 2] * 2 + 1] : 0;

    const texture = material.texture ? textures.get(material.texture) : null;
    const clampS = Boolean(material.flags & WMO_MATERIAL_FLAG_CLAMP_S);
    const clampT = Boolean(material.flags & WMO_MATERIAL_FLAG_CLAMP_T);
    const blend = material.blendMode;
    const writeDepth = blend === WMO_BLEND_OPAQUE || blend === WMO_BLEND_ALPHA_KEY;
    const alphaKey = blend === WMO_BLEND_ALPHA_KEY;
    const blendAlpha = blend === WMO_BLEND_ALPHA;
    if (blend > WMO_BLEND_ALPHA) continue; // add/mod: light effects, out of scope.

    for (let row = rowTop; row <= rowBottom; row += 1) {
      const pr = row + 0.5;
      for (let col = colLeft; col <= colRight; col += 1) {
        const pc = col + 0.5;
        const v2x = pc - c0, v2y = pr - r0; // P - a
        const wB = (v2x * v1y - v1x * v2y) * invDenom; // weight of b
        const wC = (v0x * v2y - v2x * v0y) * invDenom; // weight of c
        const wA = 1 - wB - wC;                          // weight of a
        if (wA < 0 || wB < 0 || wC < 0) continue;
        const depthIndex = row * width + col;
        const z = wA * az + wB * bz + wC * cz;
        if (z + DEPTH_EPSILON <= depth[depthIndex]) continue;

        let r;
        let g;
        let b;
        let alpha = 255;
        if (texture) {
          let tu = hasUv ? wA * u0 + wB * u1 + wC * u2 : 0;
          let tv = hasUv ? wA * v0 + wB * v1 + wC * v2 : 0;
          if (clampS) tu = Math.max(0, Math.min(1, tu));
          else tu -= Math.floor(tu);
          if (clampT) tv = Math.max(0, Math.min(1, tv));
          else tv -= Math.floor(tv);
          const texCol = Math.min(texture.width - 1, (tu * texture.width) | 0);
          const texRow = Math.min(texture.height - 1, (tv * texture.height) | 0);
          const at = ((texRow * texture.width + texCol) | 0) * 4;
          r = texture.rgba[at];
          g = texture.rgba[at + 1];
          b = texture.rgba[at + 2];
          if (alphaKey || blendAlpha) alpha = texture.rgba[at + 3];
        } else if (colors) {
          const va = indices[triangle * 3];
          const vb = indices[triangle * 3 + 1];
          const vc = indices[triangle * 3 + 2];
          // BGRA, doubled as the client lights its vertex-coloured floors.
          r = Math.min(255, (colors[va * 4 + 2] * wA + colors[vb * 4 + 2] * wB + colors[vc * 4 + 2] * wC) * 2);
          g = Math.min(255, (colors[va * 4 + 1] * wA + colors[vb * 4 + 1] * wB + colors[vc * 4 + 1] * wC) * 2);
          b = Math.min(255, (colors[va * 4 + 0] * wA + colors[vb * 4 + 0] * wB + colors[vc * 4 + 0] * wC) * 2);
        } else {
          r = g = b = NO_TEXTURE_COLOUR;
        }
        if (alphaKey && alpha <= 127) continue;

        const dest = depthIndex * 4;
        if (blendAlpha && alpha < 255) {
          const mix = alpha / 255;
          pixels[dest] += (r - pixels[dest]) * mix;
          pixels[dest + 1] += (g - pixels[dest + 1]) * mix;
          pixels[dest + 2] += (b - pixels[dest + 2]) * mix;
        } else {
          pixels[dest] = r;
          pixels[dest + 1] = g;
          pixels[dest + 2] = b;
        }
        if (writeDepth) depth[depthIndex] = z;
        stats.pixels += 1;
        if (placementStats) placementStats.pixels += 1;
      }
    }
    stats.rasterized += 1;
    if (placementStats) placementStats.rasterized += 1;
  }
}

// Rasterizes every placement's groups over the terrain baked into `image`/
// `depth` (one entry per pixel: the top surface's world Z), keeping whatever
// sits higher. `placements` are the map's deduplicated WMO placements (their
// positions in server world coordinates); WMOs that fail to load are skipped
// and counted, as the 3D scene export does.
export function renderWmoTopDown({ placements, readFile, image, depth, bounds, textureMax = 512, perPlacement = false }) {
  const stats = { wmos: 0, failed: 0, groups: 0, triangles: 0, culled: 0, rasterized: 0, pixels: 0 };
  const perPlacementStats = new Map();
  const textures = new Map();
  const getTexture = (name) => {
    if (!textures.has(name)) {
      const buffer = readFile(name);
      textures.set(name, buffer ? decodeBlp(buffer, textureMax) : null);
    }
    return textures.get(name);
  };

  // One load per unique root, rendered for every placement of it.
  const byRoot = new Map();
  for (const placement of placements) {
    if (!byRoot.has(placement.name)) byRoot.set(placement.name, []);
    byRoot.get(placement.name).push(placement);
  }
  for (const [rootName, groupPlacements] of byRoot) {
    let wmo;
    try {
      wmo = loadWmo(rootName, readFile);
    } catch (error) {
      stats.failed += 1;
      console.warn(`  ! WMO ${rootName} does not load: ${error.message}`);
      continue;
    }
    stats.wmos += 1;
    wmo.materials.forEach((material) => {
      if (material.texture) getTexture(material.texture);
    });
    for (const group of wmo.groups) {
      stats.triangles += group.indices.length / 3;
      stats.groups += 1;
      for (const placement of groupPlacements) {
        if (perPlacement && !perPlacementStats.has(placement.uniqueId)) {
          perPlacementStats.set(placement.uniqueId, { name: placement.name, culled: 0, rasterized: 0, pixels: 0 });
        }
        renderGroup({ group, wmo, placement, textures, image, depth, bounds, stats,
          placementStats: perPlacement ? perPlacementStats.get(placement.uniqueId) : undefined });
      }
    }
  }
  if (perPlacement) stats.perPlacement = [...perPlacementStats.values()];
  return stats;
}
