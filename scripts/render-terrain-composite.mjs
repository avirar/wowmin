#!/usr/bin/env node
// Composes a map's minimap artwork the way the client's outdoor minimap
// shows it: the 3D world rendered top-down. This repack carries neither the
// client's zoom tiles nor MinimapArea.dbc, so the world is rasterized
// offline, at 1 pixel per world unit, in three layers:
//   1. the terrain, baked straight from the ADTs: the tileset textures
//      projected top-down onto the heightmap, with the 3D scene's texture
//      and splat conventions (scripts/scene/terrain.mjs and the renderer's
//      terrain-material.ts);
//   2. the buildings: every placed WMO rasterized top-down with a depth
//      buffer, so the topmost surface wins each pixel (scripts/scene/
//      wmo-topdown.mjs);
//   3. the client's pre-baked WMO minimap quads, pasted over the render
//      where they exist (see scripts/scene/quad-minimap.mjs for the client
//      maths).
// Where no tile exists, a pixel is a hole, or the terrain lies below the
// water level, the ocean colour from the map's Light.dbc is used.
//
// The image covers the WDT tiles' extent plus the placed WMOs' extents,
// which becomes the map's world map bounds. The baked image becomes the
// map's primary artwork; its previous artwork (the M-key paper) is kept as
// the paper alternate, and any quads-only alternate is replaced.
//
//   node scripts/render-terrain-composite.mjs --source /path/to/client --map 628 [--assets-dir dir] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { locateDataDir, openClientData } from './client-archives.mjs';
import { buildMapCatalog } from './map-catalog.mjs';
import { readDbc } from './scene/dbc.mjs';
import { decodeBlp, encodeRgba } from './scene/textures.mjs';
import { dedupeByUniqueId, readAdtPlacements, readWdt } from './scene/placement.mjs';
import { isPlaceholderArea, isPlaceholderChunk, loadMapArea, WDT_FLAG_BIG_ALPHA } from './scene/terrain.mjs';
import { mapLiquidColours } from './scene/liquids.mjs';
import { pasteQuad, quadImageRect } from './scene/quad-minimap.mjs';
import { collectMinimapQuads, parseMd5TranslateTable } from './render-quad-minimap.mjs';
import { renderWmoTopDown, shadeFromNormal, wmoPlacementBounds } from './scene/wmo-topdown.mjs';

const SCALE = 1; // 1 image px per world unit.
const WMO_TEXTURE_MAX = 512;
const TILE_SIZE = 1600 / 3;
const CHUNK_SIZE = TILE_SIZE / 16;
// Ground textures repeat 8 times across a chunk (terrain-material.ts).
const TEXTURE_REPEAT = CHUNK_SIZE / 8;
const SPLAT_SIZE = 64;
const TERRAIN_TEXTURE_MAX = 256;
const COMPOSITE_SOURCE = 'engine terrain + WMO render + minimap quads';

function fail(message, stack) {
  console.error(`render-terrain-composite: ${message}`);
  if (stack) console.error(stack);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { map: null, source: null, assetsDir: null, dryRun: false, waterLevel: 0, perPlacement: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source' || arg === '-s') options.source = argv[++index];
    else if (arg === '--map') options.map = Number(argv[++index]);
    else if (arg === '--assets-dir' || arg === '-a') options.assetsDir = argv[++index];
    else if (arg === '--water-level') options.waterLevel = Number(argv[++index]);
    else if (arg === '--per-placement') options.perPlacement = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n').replace(/^\/\/ ?/gm, ''));
      process.exit(0);
    } else fail(`Unknown argument ${arg}.`);
  }
  return options;
}

// A WDT tile's world span: the tile's north-west corner is
// ((32 - y) * TILE, (32 - x) * TILE) and the tile runs -TILE on both axes
// from it (verified against chunk 0 positions in the ADTs).
function tileBounds(tile) {
  return {
    minX: (31 - tile.y) * TILE_SIZE,
    maxX: (32 - tile.y) * TILE_SIZE,
    minY: (31 - tile.x) * TILE_SIZE,
    maxY: (32 - tile.x) * TILE_SIZE,
  };
}

// Neighbouring chunks each store their shared boundary data twice (the 9 x 9
// outer height grid duplicates the edge, the 16-bit hole mask the edge
// cells), and the World Editor does not keep the copies equal. The bake
// assigns every pixel to a single chunk, so a disagreement shows up as a
// 1-2 px line on the chunk grid (a water/land flip or a depth step). This
// makes the copies consistent: each shared height vertex is averaged into
// one world-Z value, and where the two copies of a shared edge cell's hole
// bit disagree, the bit the bake reads for the boundary pixel — the chunk on
// the -x / -y side of the edge owns that pixel — is copied to the neighbour.
// `chunks` maps the chunk's grid index "ix,iy" (position / CHUNK_SIZE) to
// its loaded data.
export function reconcileChunkBoundaries(chunks) {
  for (const [key, chunk] of chunks) {
    const [ix, iy] = key.split(',').map(Number);
    const north = chunks.get(`${ix + 1},${iy}`); // its row 8 / this row 0
    const east = chunks.get(`${ix},${iy + 1}`); // its col 8 / this col 0
    const northeast = chunks.get(`${ix + 1},${iy + 1}`);
    const worldZ = (other, index) => other.position[2] + other.vertexHeights[index];
    // The corner (up to four copies) first, then the edge interiors (i 1-7),
    // so every average is taken over the original values.
    if (north || east) {
      const copies = [worldZ(chunk, 0)];
      if (north) copies.push(worldZ(north, 8 * 17));
      if (east) copies.push(worldZ(east, 8));
      if (northeast) copies.push(worldZ(northeast, 8 * 17 + 8));
      const mean = copies.reduce((sum, value) => sum + value, 0) / copies.length;
      chunk.vertexHeights[0] = mean - chunk.position[2];
      if (north) north.vertexHeights[8 * 17] = mean - north.position[2];
      if (east) east.vertexHeights[8] = mean - east.position[2];
      if (northeast) northeast.vertexHeights[8 * 17 + 8] = mean - northeast.position[2];
    }
    if (north) {
      for (let i = 1; i <= 7; i += 1) {
        // The shared edge: this chunk's row 0, column i == the north
        // neighbour's row 8, column i (both at x = chunk.x).
        const mean = (worldZ(chunk, i) + worldZ(north, 8 * 17 + i)) / 2;
        chunk.vertexHeights[i] = mean - chunk.position[2];
        north.vertexHeights[8 * 17 + i] = mean - north.position[2];
      }
      // The chunk's boundary cells (quad row 0, bits 0-3) vs the north's
      // (its quad row 7, bits 12-15); this chunk owns the boundary pixels.
      for (let j = 0; j < 4; j += 1) {
        const bit = (chunk.holes >> j) & 1;
        north.holes = (north.holes & ~(1 << (12 + j))) | (bit << (12 + j));
      }
    }
    if (east) {
      for (let i = 1; i <= 7; i += 1) {
        const mean = (worldZ(chunk, i * 17) + worldZ(east, i * 17 + 8)) / 2;
        chunk.vertexHeights[i * 17] = mean - chunk.position[2];
        east.vertexHeights[i * 17 + 8] = mean - east.position[2];
      }
      // The chunk's boundary cells (quad col 0, bits 0, 4, 8, 12) vs the
      // east's (its quad col 7, bits 3, 7, 11, 15); this chunk owns the
      // boundary pixels.
      for (let r = 0; r < 4; r += 1) {
        const bit = (chunk.holes >> (r * 4)) & 1;
        east.holes = (east.holes & ~(1 << (r * 4 + 3))) | (bit << (r * 4 + 3));
      }
    }
  }
}

// Bakes the map's terrain top-down into `image` (pre-filled with the ocean
// colour), one pixel per world unit, within `union`. The texture and splat
// conventions match the 3D scene: layer 0 is the base colour and layers
// 1-3 mix over it by their 64 x 64 per-chunk alpha (splat row 0 at the
// chunk's north edge, column 0 at its west); the layer textures repeat
// TEXTURE_REPEAT world units, u with world X and v with world Y. Every
// baked pixel also records its surface height in `depth` (the topmost
// world Z per pixel), the water level wherever terrain lies underwater:
// the WMO render tests against it.
export function bakeTerrain({ readFile, mapPath, wdt, union, image, depth, waterLevel }) {
  const bigAlpha = Boolean(wdt.flags & WDT_FLAG_BIG_ALPHA);
  const { width, height, pixels } = image;
  const fract = (value) => ((value % 1) + 1) % 1;

  // Every live chunk, keyed by its grid index (position / CHUNK_SIZE): the
  // shared boundary data is reconciled between neighbours before any pixel
  // is written (see reconcileChunkBoundaries).
  const chunks = new Map();
  let skipped = 0;
  for (const tile of wdt.tiles) {
    const bounds = tileBounds(tile);
    if (bounds.minX > union.maxX || bounds.maxX < union.minX || bounds.minY > union.maxY || bounds.maxY < union.minY) continue;
    const adt = readFile(`${mapPath}_${tile.x}_${tile.y}.adt`);
    if (!adt) continue;
    const area = loadMapArea(adt, bigAlpha);
    if (isPlaceholderArea(area)) continue;
    for (const chunk of area.chunks) {
      if (!chunk.vertexHeights || isPlaceholderChunk(chunk)) {
        skipped += 1;
        continue;
      }
      chunks.set(`${Math.round(chunk.position[0] / CHUNK_SIZE)},${Math.round(chunk.position[1] / CHUNK_SIZE)}`, chunk);
    }
  }
  reconcileChunkBoundaries(chunks);

  // A pixel's place within its chunk depends only on the global chunk
  // grid, not on which chunk it is: precomputed per image row (world X)
  // and column (world Y) — the outer-vertex grid (heights, holes), the
  // splat grid, and the texture coordinate.
  const rowVertex = new Int8Array(height);
  const rowVertexF = new Float32Array(height);
  const rowHole = new Int8Array(height);
  const rowSplat = new Int8Array(height);
  const rowSplatF = new Float32Array(height);
  const rowTex = new Float32Array(height);
  const colVertex = new Int8Array(width);
  const colVertexF = new Float32Array(width);
  const colHole = new Int8Array(width);
  const colSplat = new Int8Array(width);
  const colSplatF = new Float32Array(width);
  const colTex = new Float32Array(width);
  // Each pixel is sampled at its centre: the pixel top edge (maxX - row)
  // crosses a chunk boundary on the one pixel row straddling it, and a
  // boundary-external sample wraps the chunk-local fraction around to the
  // chunk's opposite edge (a 1-px band of far-away heights on the chunk
  // grid). The centre is always inside the owning chunk.
  for (let row = 0; row < height; row += 1) {
    const v = fract(-(union.maxX - row - 0.5) / CHUNK_SIZE); // fraction south of the chunk's north edge
    const vertex = v * 8;
    const splat = v * SPLAT_SIZE;
    rowVertex[row] = Math.min(7, vertex | 0);
    rowVertexF[row] = vertex - rowVertex[row];
    // The chunk's 16 hole bits cover 2 x 2 cell quads, row by row
    // (terrain.mjs isHole): bit = (row >> 1) * 4 + (col >> 1).
    rowHole[row] = (rowVertex[row] >> 1) * 4;
    rowSplat[row] = Math.min(63, splat | 0);
    rowSplatF[row] = splat - rowSplat[row];
    rowTex[row] = fract((union.maxX - row - 0.5) / TEXTURE_REPEAT);
  }
  for (let col = 0; col < width; col += 1) {
    const u = fract(-(union.maxY - col - 0.5) / CHUNK_SIZE); // fraction east of the chunk's west edge
    const vertex = u * 8;
    const splat = u * SPLAT_SIZE;
    colVertex[col] = Math.min(7, vertex | 0);
    colVertexF[col] = vertex - colVertex[col];
    colHole[col] = colVertex[col] >> 1;
    colSplat[col] = Math.min(63, splat | 0);
    colSplatF[col] = splat - colSplat[col];
    colTex[col] = fract((union.maxY - col - 0.5) / TEXTURE_REPEAT);
  }

  const textures = new Map();
  const getTexture = (name) => {
    if (!textures.has(name)) {
      const buffer = readFile(name);
      textures.set(name, buffer ? decodeBlp(buffer, TERRAIN_TEXTURE_MAX) : null);
    }
    return textures.get(name);
  };

  let baked = 0;
  let landPixels = 0;
  for (const chunk of chunks.values()) {
    const layers = [0, 1, 2, 3].map((layer) => (chunk.layers[layer] ? getTexture(chunk.layers[layer].texture) : null));
    if (!layers[0] && !layers[1] && !layers[2] && !layers[3]) {
      skipped += 1;
      continue;
    }
    const splats = [1, 2, 3].map((layer) => chunk.layers[layer]?.splat ?? null);
    const left = Math.max(0, Math.round((union.maxY - chunk.position[1]) * SCALE));
    const right = Math.min(width, Math.round((union.maxY - (chunk.position[1] - CHUNK_SIZE)) * SCALE));
    const top = Math.max(0, Math.round((union.maxX - chunk.position[0]) * SCALE));
    const bottom = Math.min(height, Math.round((union.maxX - (chunk.position[0] - CHUNK_SIZE)) * SCALE));
    if (right <= left || bottom <= top) continue;
    const heights = chunk.vertexHeights;
    const holes = chunk.holes ?? 0;
    const zBase = chunk.position[2];
    baked += 1;
    for (let row = top; row < bottom; row += 1) {
      const vertexRow0 = rowVertex[row] * 17;
      const vertexRow1 = vertexRow0 + 17;
      const vertexF = rowVertexF[row];
      const holeRow = rowHole[row];
      const splatRow = rowSplat[row];
      const splatRow1 = Math.min(63, splatRow + 1);
      const splatF = rowSplatF[row];
      const texRow = rowTex[row];
      for (let col = left; col < right; col += 1) {
        if (holes & (1 << (holeRow + colHole[col]))) continue;
        const vertexCol = colVertex[col];
        const vertexFCol = colVertexF[col];
        // The surface the MMap (and thus the in-game FloorZ and the
        // minimap's render) is built from: every 4.17 x 4.17 sub-quad is
        // four triangles fanned round its centre vertex, so the pixel's
        // height is the barycentric blend of that centre and the two
        // corners on its side (a plain outer-grid bilinear sits up to
        // ~0.2 off the fan on the shores, enough to flip water/land).
        // vertexF runs north -> south, vertexFCol east -> west.
        const h00 = heights[vertexRow0 + vertexCol];
        const h01 = heights[vertexRow0 + vertexCol + 1];
        const h10 = heights[vertexRow1 + vertexCol];
        const h11 = heights[vertexRow1 + vertexCol + 1];
        const hC = heights[vertexRow0 + 9 + vertexCol];
        let terrainHeight;
        if (vertexF <= vertexFCol && vertexF <= 1 - vertexFCol)
          terrainHeight = (1 - vertexF - vertexFCol) * h00 + (vertexFCol - vertexF) * h01 + 2 * vertexF * hC;
        else if (vertexF >= vertexFCol && vertexF >= 1 - vertexFCol)
          terrainHeight = (vertexF - vertexFCol) * h10 + (vertexF + vertexFCol - 1) * h11 + 2 * (1 - vertexF) * hC;
        else if (vertexFCol >= vertexF && vertexFCol >= 1 - vertexF)
          terrainHeight = (vertexFCol - vertexF) * h01 + (vertexF + vertexFCol - 1) * h11 + 2 * (1 - vertexFCol) * hC;
        else
          terrainHeight = (1 - vertexF - vertexFCol) * h00 + (vertexF - vertexFCol) * h10 + 2 * vertexFCol * hC;
        if (zBase + terrainHeight < waterLevel) continue;
        const texCol = colTex[col];
        const base = layers[0];
        let r;
        let g;
        let b;
        if (base) {
          const at = ((texCol * base.height) | 0) * base.width + ((texRow * base.width) | 0);
          const pixel = at * 4;
          r = base.rgba[pixel];
          g = base.rgba[pixel + 1];
          b = base.rgba[pixel + 2];
        } else {
          r = g = b = 127;
        }
        const splatCol = colSplat[col];
        const splatCol1 = Math.min(63, splatCol + 1);
        const splatFCol = colSplatF[col];
        for (let layer = 1; layer < 4; layer += 1) {
          const texture = layers[layer];
          const splat = splats[layer - 1];
          if (!texture || !splat) continue;
          const alpha = (splat[splatRow * SPLAT_SIZE + splatCol] * (1 - splatF) + splat[splatRow * SPLAT_SIZE + splatCol1] * splatF) * (1 - splatFCol)
            + (splat[splatRow1 * SPLAT_SIZE + splatCol] * (1 - splatF) + splat[splatRow1 * SPLAT_SIZE + splatCol1] * splatF) * splatFCol;
          if (alpha <= 0) continue;
          const mix = alpha / 255;
          const at = ((texCol * texture.height) | 0) * texture.width + ((texRow * texture.width) | 0);
          const pixel = at * 4;
          r += (texture.rgba[pixel] - r) * mix;
          g += (texture.rgba[pixel + 1] - g) * mix;
          b += (texture.rgba[pixel + 2] - b) * mix;
        }
        const dest = (row * width + col) * 4;
        pixels[dest] = r;
        pixels[dest + 1] = g;
        pixels[dest + 2] = b;
        depth[row * width + col] = zBase + terrainHeight;
        landPixels += 1;
      }
    }
  }
  return { chunks: baked, skipped, landPixels };
}

// Lambert-shades the baked terrain under the same fixed light as the WMO
// pass: the surface normal comes from the baked height's two-unit central
// differences, so cliffs and the 1-px coastline jaggies darken the way the
// in-game minimap's shaded render does (a flat surface stays near full
// brightness). Water pixels sit at the water level in `depth` and keep the
// flat ocean colour.
function shadeTerrainBake({ width, height, pixels, depth, waterLevel }) {
  let shaded = 0;
  for (let row = 0; row < height; row += 1) {
    const base = row * width;
    for (let col = 0; col < width; col += 1) {
      const p = base + col;
      const h = depth[p];
      if (!(h > waterLevel)) continue;
      // One row down is one world unit south (x - 1); one column right is
      // one unit west (y - 1).
      const hNorth = row > 0 ? depth[p - width] : h;
      const hSouth = row < height - 1 ? depth[p + width] : h;
      const hEast = col > 0 ? depth[p - 1] : h;
      const hWest = col < width - 1 ? depth[p + 1] : h;
      const dx = (hNorth - hSouth) * 0.5; // dh/dx
      const dy = (hEast - hWest) * 0.5;   // dh/dy
      shaded += 1;
      const at = p * 4;
      const shade = shadeFromNormal(-dx, -dy, 1);
      pixels[at] = pixels[at] * shade;
      pixels[at + 1] = pixels[at + 1] * shade;
      pixels[at + 2] = pixels[at + 2] * shade;
    }
  }
  return shaded;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.source) throw new Error('Missing required --source argument.');
  if (!Number.isInteger(options.map)) throw new Error('Missing or invalid --map argument.');
  const dataDir = locateDataDir(options.source);
  if (!dataDir) throw new Error(`No Data directory in ${options.source}`);
  const readFile = openClientData(dataDir);
  const assetsDir = options.assetsDir
    ? path.resolve(options.assetsDir)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'instances');

  const catalog = await buildMapCatalog(readFile, { mapIds: [options.map] });
  const entry = catalog.find((item) => item.mapId === options.map);
  if (!entry) throw new Error(`Map ${options.map} is not in the client's Map.dbc`);
  const mapPath = `World\\maps\\${entry.internalName}\\${entry.internalName}`;
  const wdtBuffer = readFile(`${mapPath}.wdt`);
  if (!wdtBuffer) throw new Error(`Missing ${mapPath}.wdt`);
  const wdt = readWdt(wdtBuffer);
  if (!wdt.tiles.length && !wdt.wmoOnly) throw new Error(`${entry.internalName} has no terrain tiles or a building`);

  // The map's WMO placements (one entry per unique placement: the ADT
  // tiles' buildings, or the map's own building for a building-only map).
  // The bake renders all of them — the client's minimap shows buildings
  // that carry no pre-baked quads as well.
  const placements = new Map();
  if (wdt.wmoOnly) {
    placements.set(wdt.wmo.uniqueId, wdt.wmo);
  } else {
    for (const tile of wdt.tiles) {
      const buffer = readFile(`${mapPath}_${tile.x}_${tile.y}.adt`);
      if (!buffer) continue;
      for (const wmo of dedupeByUniqueId(readAdtPlacements(buffer).wmos)) {
        if (!placements.has(wmo.uniqueId)) placements.set(wmo.uniqueId, wmo);
      }
    }
  }
  const allPlacements = [...placements.values()];

  // The image covers the WDT tiles' extent plus the placed WMOs' extents
  // (not the quads' union: quads cover only a fraction of most maps, and
  // the bounds double as the map's world map projection).
  const union = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const unionWith = (box) => {
    if (!box || !Number.isFinite(box.minX)) return;
    union.minX = Math.min(union.minX, box.minX); union.maxX = Math.max(union.maxX, box.maxX);
    union.minY = Math.min(union.minY, box.minY); union.maxY = Math.max(union.maxY, box.maxY);
  };
  if (!wdt.wmoOnly) for (const tile of wdt.tiles) unionWith(tileBounds(tile));
  let boundedWmos = 0;
  for (const placement of allPlacements) {
    try {
      const box = wmoPlacementBounds(readFile, placement);
      if (box) {
        unionWith(box);
        boundedWmos += 1;
      }
    } catch (error) {
      console.warn(`  ! ${placement.name} has no usable bounds (${error.message})`);
    }
  }
  if (!Number.isFinite(union.minX)) throw new Error(`${entry.internalName} has no terrain tiles and no bounded WMOs`);

  const trsBuffer = readFile('textures\\Minimap\\md5translate.trs');
  let quads = [];
  let baseNames = [];
  if (trsBuffer) {
    const table = parseMd5TranslateTable(trsBuffer);
    const collected = collectMinimapQuads({ readFile, table, placements: allPlacements });
    quads = collected.quads;
    baseNames = collected.baseNames;
  } else {
    console.warn('  ! md5translate.trs is missing: no minimap quads');
  }
  const width = Math.round((union.maxY - union.minY) * SCALE);
  const height = Math.round((union.maxX - union.minX) * SCALE);
  console.log(`  ${allPlacements.length} WMO placements (${boundedWmos} bounded), ${quads.length} quads for ${baseNames.length} WMOs; union x[${union.minX.toFixed(1)}, ${union.maxX.toFixed(1)}] y[${union.minY.toFixed(1)}, ${union.maxY.toFixed(1)}] -> ${width}x${height} px`);

  const pixels = new Uint8ClampedArray(width * height * 4);
  const lights = readFile('DBFilesClient\\Light.dbc');
  const bands = readFile('DBFilesClient\\LightIntBand.dbc');
  const colours = lights && bands ? mapLiquidColours(readDbc(lights), readDbc(bands).byId(), options.map) : null;
  const ocean = (colours?.ocean ?? [0.12, 0.36, 0.52]).map((value) => Math.round(value * 255));
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = ocean[0];
    pixels[index + 1] = ocean[1];
    pixels[index + 2] = ocean[2];
    pixels[index + 3] = 255;
  }

  const image = { width, height, pixels };
  // The topmost surface per pixel: the water level where no terrain lies
  // above it (or, for a building-only map, nothing at all).
  const depth = new Float32Array(width * height).fill(wdt.wmoOnly ? -Infinity : options.waterLevel);
  if (!wdt.wmoOnly) {
    const stats = bakeTerrain({ readFile, mapPath, wdt, union, image, depth, waterLevel: options.waterLevel });
    console.log(`  terrain: ${stats.chunks} chunks (${stats.skipped} placeholder/layerless skipped), ${(100 * stats.landPixels / (width * height)).toFixed(1)}% land`);
    const shaded = shadeTerrainBake({ width, height, pixels: image.pixels, depth, waterLevel: options.waterLevel });
    console.log(`  shaded ${shaded} land pixels (fixed directional light)`);
  }
  if (options.dryRun) return;

  const wmoStats = renderWmoTopDown({ placements: allPlacements, readFile, image, depth, bounds: union, textureMax: WMO_TEXTURE_MAX, perPlacement: options.perPlacement });
  console.log(`  WMOs: ${wmoStats.wmos} loaded (${wmoStats.failed} failed), ${wmoStats.rasterized} of ${wmoStats.triangles} triangles up-facing, ${wmoStats.pixels} px written`);
  if (options.perPlacement) {
    for (const entry of [...wmoStats.perPlacement].sort((a, b) => b.pixels - a.pixels).slice(0, 20)) {
      console.log(`    ${entry.name.split('\\').pop()}: ${entry.pixels} px (${entry.rasterized} up-facing tris, ${entry.culled} culled)`);
    }
  }

  const decoded = new Map();
  let pasted = 0;
  for (const quad of quads) {
    if (!quad.hash) continue;
    if (!decoded.has(quad.hash)) {
      const buffer = readFile(`textures\\Minimap\\${quad.hash}`);
      if (!buffer) {
        console.warn(`  ! ${quad.name} hashes to ${quad.hash}, which the client does not carry`);
        continue;
      }
      decoded.set(quad.hash, decodeBlp(buffer, TERRAIN_TEXTURE_MAX));
    }
    pasteQuad(image, decoded.get(quad.hash), quadImageRect(quad.world, union, SCALE));
    pasted += 1;
  }
  console.log(`  pasted ${pasted} quads over the bake`);

  const encoded = encodeRgba({ width, height, rgba: image.pixels });
  const extension = encoded.mimeType === 'image/png' ? 'png' : 'jpg';
  const imageFile = `${options.map}.${extension}`;
  const jsonPath = path.join(assetsDir, `${options.map}.json`);
  const old = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
  let paper = null;
  if (old && !(old.source?.includes('terrain') ?? false)) {
    // First composite pass: the map's current artwork (the M-key paper)
    // becomes the paper alternate, and the quads-only alternate is
    // replaced by the composite. The composite reuses the old image's
    // file name, so the paper is moved aside before it is overwritten.
    if (old.image && fs.existsSync(path.join(assetsDir, old.image))) {
      const paperFile = `${options.map}-paper${path.extname(old.image) || '.jpg'}`;
      fs.renameSync(path.join(assetsDir, old.image), path.join(assetsDir, paperFile));
      paper = {
        image: paperFile,
        width: old.width,
        height: old.height,
        worldMapBounds: old.worldMapBounds,
        projection: old.projection,
        source: 'WorldMap paper (M key)',
        minTileX: old.minTileX,
        minTileY: old.minTileY,
        maxTileX: old.maxTileX,
        maxTileY: old.maxTileY,
        gridSize: old.gridSize,
        worldUnitsPerTile: old.worldUnitsPerTile,
        tileWidth: old.tileWidth,
        tileHeight: old.tileHeight,
      };
    }
    for (const alternate of old.alternates ?? []) {
      if (alternate.source?.includes('quads') && fs.existsSync(path.join(assetsDir, alternate.image))) {
        fs.unlinkSync(path.join(assetsDir, alternate.image));
      }
    }
  } else {
    paper = (old?.alternates ?? []).find((alternate) => alternate.image.startsWith(`${options.map}-paper`)) ?? null;
  }
  const metadata = {
    schemaVersion: 1,
    mapId: options.map,
    label: entry.label,
    mapType: entry.mapType,
    mapTypeLabel: entry.mapTypeLabel,
    clientDirectory: entry.internalName,
    image: imageFile,
    width,
    height,
    worldMapBounds: {
      minX: union.minX,
      maxX: union.maxX,
      minY: union.minY,
      maxY: union.maxY,
    },
    projection: { type: 'worldMapArea' },
    source: COMPOSITE_SOURCE,
    alternates: paper ? [paper] : [],
  };
  fs.writeFileSync(path.join(assetsDir, imageFile), encoded.data);
  fs.writeFileSync(jsonPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`  Wrote ${imageFile} (${width}x${height}) and ${options.map}.json${paper ? ` (paper kept as ${paper.image})` : ''}`);
}

// A count of the distinct terrain textures decoded so far (diagnostic).
function texturesUsed() {
  return '';
}

// Runs only when executed directly, not when imported for bakeTerrain/renderWmoTopDown.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error.message, error.stack));
}
