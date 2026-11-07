// Client icons as PNG for wowmin's overlay: a spell's icon (Spell.dbc →
// SpellIcon.dbc → Interface\Icons), each side's PvP crest (the target
// frame's), and the raid markers (1 star .. 8 skull), the last two cropped to
// what's visible; plus a spell chain's texture (SpellChainEffects). Built on request from the viewer's own
// client data, like the unit models; never committed.

import { PNG } from 'pngjs';

import { decodeBlp } from './textures.mjs';

const FACTION_ICONS = {
  alliance: 'Interface\\TargetingFrame\\UI-PVP-Alliance.blp',
  horde: 'Interface\\TargetingFrame\\UI-PVP-Horde.blp',
};
// The client's minimap vehicle blips (MinimapFrame's s_vehicleTextures,
// nose up in the texture): the faction air ships, the ground vehicles, and
// the generic air vehicles, the occupied and unoccupied variants. The flat
// view draws them at the vehicle's position, rotated by its heading.
const VEHICLE_ICONS = {
  alliance: 'Interface\\Minimap\\Vehicle-Air-Alliance.blp',
  horde: 'Interface\\Minimap\\Vehicle-Air-Horde.blp',
  ground: 'Interface\\Minimap\\Vehicle-Ground-Unoccupied.blp',
  'ground-occupied': 'Interface\\Minimap\\Vehicle-Ground-Occupied.blp',
  air: 'Interface\\Minimap\\Vehicle-Air-Unoccupied.blp',
  'air-occupied': 'Interface\\Minimap\\Vehicle-Air-Occupied.blp',
};
const SPELL_ICON_FIELD = 133;
const ICON_PATH_FIELD = 1;
const ICON_MAX_SIZE = 64;
const CHAIN_TEXTURE_MAX_SIZE = 256;
// Alpha below this counts as empty padding when cropping.
const VISIBLE_ALPHA = 20;

// The icon's BLP path, whether to crop its padding, and its largest edge,
// for a request's params ({ faction }, { vehicle }, { marker }, { chain },
// { poi }, or { spellId }); null if there is none.
export function iconSource(params, tables) {
  if (params.chain) {
    const file = tables.chainTexture(Number(params.chain));
    return file ? { path: file, crop: false, maxSize: CHAIN_TEXTURE_MAX_SIZE } : null;
  }
  // The battleground map's POI atlas (keeps, towers, walls), served whole at
  // its native size: the viewer crops cells from it.
  if (params.poi) return { path: 'Interface\\Minimap\\POIIcons.blp', crop: false, maxSize: 256 };
  if (params.vehicle) {
    const file = VEHICLE_ICONS[params.vehicle];
    return file ? { path: file, crop: true, maxSize: 64 } : null;
  }
  if (params.faction) return FACTION_ICONS[params.faction] ? { path: FACTION_ICONS[params.faction], crop: true } : null;
  if (params.marker) {
    const marker = Number(params.marker);
    return marker >= 1 && marker <= 8 ? { path: `Interface\\TargetingFrame\\UI-RaidTargetingIcon_${marker}.blp`, crop: true } : null;
  }
  const spell = tables.table('Spell').get(Number(params.spellId));
  const icon = spell ? tables.table('SpellIcon').get(spell.uint(SPELL_ICON_FIELD)) : null;
  const name = icon?.string(ICON_PATH_FIELD);
  return name ? { path: `${name}.blp`, crop: false } : null;
}

// The smallest rectangle holding every pixel at least VISIBLE_ALPHA opaque,
// or the whole image if none is.
export function cropToVisible({ width, height, rgba }) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] < VISIBLE_ALPHA) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { width, height, rgba };
  const croppedWidth = maxX - minX + 1;
  const croppedHeight = maxY - minY + 1;
  const cropped = new Uint8Array(croppedWidth * croppedHeight * 4);
  for (let y = 0; y < croppedHeight; y += 1) {
    const from = ((minY + y) * width + minX) * 4;
    cropped.set(rgba.subarray(from, from + croppedWidth * 4), y * croppedWidth * 4);
  }
  return { width: croppedWidth, height: croppedHeight, rgba: cropped };
}

// The icon as PNG, or null if the client doesn't have it.
export function buildIconPng(readFile, params, tables) {
  const source = iconSource(params, tables);
  const blp = source && readFile(source.path);
  if (!blp) return null;
  const decoded = decodeBlp(blp, source.maxSize ?? ICON_MAX_SIZE);
  const image = source.crop ? cropToVisible(decoded) : decoded;
  return PNG.sync.write({ width: image.width, height: image.height, data: Buffer.from(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength) });
}
