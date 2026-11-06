// Builds a GLB for a WMO building model (a game object display: the Isle of
// Conquest gates and gunships): its groups' textured geometry, in the effect
// model's conventions (each texture as a `texture<i>` material, the blend and
// its texture named in the batch material's extras), so the renderer's effect
// loader can draw it where the server puts it. Everything stays in raw WMO
// local space (Z up, origin at the placement), like the effect's M2 models;
// the placement's axes are applied by the renderer. Vertex colours are not
// exported: they are the client's baked lighting multiplier (near black for
// these models), and the textures alone carry their appearance here.

import path from 'node:path';

import { Document } from '@gltf-transform/core';

import { loadWmo } from './wmo.mjs';
import { encodeTexture } from './textures.mjs';
import { writeGlb } from './unit-model.mjs';

// A WMO material's blend mode, by its MOMT index.
const WMO_BLEND = ['opaque', 'alphaKey', 'alpha', 'add', 'mod', 'mod2x'];
// Texture cap, as the effect models use.
const WMO_TEXTURE_MAX = 256;

// The GLB for a WMO model file, or null if it has no geometry to draw.
export async function buildWmoGlb(readFile, wmoName, textureMax = WMO_TEXTURE_MAX) {
  const wmo = loadWmo(wmoName, readFile);
  const base = path.win32.basename(wmoName).replace(/\.wmo$/i, '');
  const groups = wmo.groups.filter((group) => group.batches.length);
  if (!groups.length) return null;

  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (type, array) => document.createAccessor().setType(type).setArray(array).setBuffer(buffer);

  // Every WMO texture once, as a material named after its material's index, so
  // the renderer's effect loader (which collects the materials it names
  // texture<i>) can find it; a batch's extras point at that name.
  const encoded = new Map();
  const textureNames = wmo.materials.map((material, index) => {
    if (!material.texture) return null;
    const key = material.texture.toLowerCase();
    if (!encoded.has(key)) {
      try {
        encoded.set(key, encodeTexture(readFile(material.texture), textureMax));
      } catch (error) {
        console.warn(`Could not decode ${material.texture}: ${error instanceof Error ? error.message : error}`);
        encoded.set(key, null);
      }
    }
    const image = encoded.get(key);
    if (!image) return null;
    document.createMaterial(`texture${index}`).setBaseColorTexture(
      document.createTexture(path.win32.basename(material.texture)).setImage(image.data).setMimeType(image.mimeType));
    return `texture${index}`;
  });

  // One material per WMO material, with its blend and texture, shared by every
  // batch that uses it.
  const materials = new Map();
  const materialFor = (index) => {
    if (!materials.has(index)) {
      const source = wmo.materials[index] ?? {};
      materials.set(index, document.createMaterial(`${base}#${index}`)
        .setDoubleSided(true)
        .setExtras({ wowBlend: WMO_BLEND[source.blendMode] ?? 'opaque', wowTexture: textureNames[index] ?? null }));
    }
    return materials.get(index);
  };

  const root = document.createNode(base);
  for (const group of groups) {
    const name = `${base}_g${group.index}`;
    const mesh = document.createMesh(name);
    const position = accessor('VEC3', group.positions);
    const normal = accessor('VEC3', group.normals);
    const uv = accessor('VEC2', group.uvs);
    for (const batch of group.batches) {
      const slice = group.indices.subarray(batch.indexStart, batch.indexStart + batch.indexCount);
      let max = 0;
      for (let i = 0; i < slice.length; i += 1) if (slice[i] > max) max = slice[i];
      mesh.addPrimitive(document.createPrimitive()
        .setAttribute('POSITION', position)
        .setAttribute('NORMAL', normal)
        .setAttribute('TEXCOORD_0', uv)
        .setIndices(accessor('SCALAR', max > 0xFFFF ? Uint32Array.from(slice) : Uint16Array.from(slice)))
        .setMaterial(materialFor(batch.materialIndex)));
    }
    root.addChild(document.createNode(name).setMesh(mesh));
  }
  document.createScene(base).addChild(root);
  return writeGlb(document);
}
