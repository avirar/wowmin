import type { CreatureInfo, MapBattlegroundState, MapPlayerPosition, StreamCreatureSample } from '../../../src/types/api';
import { getMapName } from './helpers';

export interface ActiveInstanceSession {
  key: string;
  mapId: number;
  instanceId: number;
  label: string;
  players: MapPlayerPosition[];
}

export interface InstanceCoordinateBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface InstanceMapProfile {
  mapId: number;
  bounds: InstanceCoordinateBounds;
  aspectRatio: number;
  source: string;
}

export interface InstanceProjectionViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InstanceViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

// A DungeonMap.dbc floor: the flat view's floor maps and the 3D scene's
// floors both carry one, under the same id.
export interface DungeonFloor {
  id: number;
  floorIndex: number;
  bounds: InstanceCoordinateBounds;
  chunks: Array<{ wmoGroupId: number; minZ: number }>;
}

export interface DungeonMapFloor extends DungeonFloor {
  image: string;
  width: number;
  height: number;
}

export interface MinimapTileProjection {
  minTileX: number;
  minTileY: number;
  maxTileX: number;
  maxTileY: number;
  gridSize: number;
  worldUnitsPerTile: number;
}

// WorldMapArea.dbc row 443. The client map transform swaps world X/Y;
// therefore the rendered width is the world-Y span and height is world-X.
const INSTANCE_MAP_PROFILES = new Map<number, InstanceMapProfile>([
  [489, {
    mapId: 489,
    bounds: { minX: 862.4999389648438, maxX: 1627.083251953125, minY: 895.8333129882812, maxY: 2041.6666259765625 },
    aspectRatio: (2041.6666259765625 - 895.8333129882812) / (1627.083251953125 - 862.4999389648438),
    source: 'WorldMapArea.dbc:443',
  }],
  // The Deeprun Tram's artwork extent (assets/instances/369.json, from the
  // client's WMO minimap quads), so the view keeps the whole line in frame
  // even before the artwork loads or with no players aboard.
  [369, {
    mapId: 369,
    bounds: { minX: -323.11760239664716, maxX: 196.25371260579414, minY: -77.2214956766766, maxY: 2566.708073567708 },
    aspectRatio: (2566.708073567708 - -77.2214956766766) / (196.25371260579414 - -323.11760239664716),
    source: 'WMO minimap quads (369.json)',
  }],
]);

// Public (instanceId 0) non-continent maps Instance Watch shows as their own
// sessions: the 2D Live Map covers the continents, these maps do not belong
// anywhere else. A map qualifies when the view can draw it by extracted
// client artwork.
const PUBLIC_INSTANCE_WATCH_MAPS = new Set<number>([369, 609]);
// Public watch maps listed even with zero players aboard.
const ALWAYS_ON_PUBLIC_WATCH_MAPS = [369];

export function getInstanceFactionColor(teamId: number | undefined): string | null {
  if (teamId === 0) return '#3b82f6';
  if (teamId === 1) return '#ef4444';
  return null;
}

// Isle of Conquest's six gates: the server's spawn positions (BattlegroundIC.h)
// and the worldstate of each side of the gate: its open id carries 1 while
// the gate is breached (destroyed), its closed id while it stands.
export interface IcGate {
  entry: number;
  x: number;
  y: number;
  z: number;
  // The keep the gate defends: 0 Alliance, 1 Horde.
  faction: 0 | 1;
  openWorldState: number;
  closedWorldState: number;
}

export const IC_GATES: IcGate[] = [
  { entry: 195699, x: 351.615, y: -762.75, z: 48.9162, faction: 0, openWorldState: 4324, closedWorldState: 4327 },
  { entry: 195698, x: 351.024, y: -903.326, z: 48.9247, faction: 0, openWorldState: 4325, closedWorldState: 4326 },
  { entry: 195700, x: 413.479, y: -833.95, z: 48.5238, faction: 0, openWorldState: 4323, closedWorldState: 4328 },
  { entry: 195494, x: 1150.9, y: -762.606, z: 47.5077, faction: 1, openWorldState: 4322, closedWorldState: 4317 },
  { entry: 195496, x: 1218.74, y: -851.155, z: 48.2533, faction: 1, openWorldState: 4320, closedWorldState: 4319 },
  { entry: 195495, x: 1217.9, y: -676.948, z: 47.6341, faction: 1, openWorldState: 4321, closedWorldState: 4318 },
];

// The faction of a map's transport by its entry, for the markers the flat
// view draws in its place of the 3D models: Isle of Conquest's gunships.
export function getTransportFaction(mapId: number, entry: number): 0 | 1 | null {
  if (mapId === 628) {
    if (entry === 195121) return 0; // GO_ALLIANCE_GUNSHIP
    if (entry === 195276) return 1; // GO_HORDE_GUNSHIP
  }
  return null;
}

export function getBattlegroundStatusLabel(status: number): string {
  return ['Inactive', 'Queued', 'Preparing', 'In progress', 'Complete'][status] ?? `Status ${status}`;
}

export function getBattlegroundStrategyLabel(battlegroundTypeId: number, strategy: number): string | null {
  if (strategy < 0) return null;
  if (battlegroundTypeId === 7) {
    return ['Balanced', 'Front focus', 'Back focus', 'Flag focus'][strategy] ?? `Strategy ${strategy}`;
  }
  if ([1, 2, 3].includes(battlegroundTypeId)) {
    return ['Balanced', 'Offensive', 'Defensive'][strategy] ?? `Strategy ${strategy}`;
  }
  return null;
}

export function getBattlegroundObjectiveLabels(battleground: MapBattlegroundState): string[] {
  const states = new Map(battleground.worldStates.map((state) => [state.id, state.value]));
  const value = (id: number): number | undefined => states.get(id);
  const labels: string[] = [];

  switch (battleground.mapId) {
    case 489: {
      const flagState = (state?: number): string => ['Unknown', 'At base', 'Carried', 'Dropped'][state ?? 0] ?? `State ${state}`;
      labels.push(`Alliance flag: ${flagState(value(2339))}`);
      labels.push(`Horde flag: ${flagState(value(2338))}`);
      break;
    }
    case 529:
      labels.push(`Alliance bases: ${value(1779) ?? 0}`);
      labels.push(`Horde bases: ${value(1778) ?? 0}`);
      break;
    case 566:
      labels.push(`Alliance bases: ${value(2752) ?? 0}`);
      labels.push(`Horde bases: ${value(2753) ?? 0}`);
      if ((value(2769) ?? 0) === 2) labels.push('Flag carried by Alliance');
      else if ((value(2770) ?? 0) === 2) labels.push('Flag carried by Horde');
      else labels.push('Flag available');
      break;
    case 30:
      labels.push(`Alliance reinforcements: ${value(3127) ?? battleground.allianceScore}`);
      labels.push(`Horde reinforcements: ${value(3128) ?? battleground.hordeScore}`);
      break;
    case 628: {
      labels.push(`Alliance reinforcements: ${value(4226) ?? 0}`);
      labels.push(`Horde reinforcements: ${value(4227) ?? 0}`);
      const controlledStates: Array<[number, string]> = [
        [4229, 'Workshop · Alliance'], [4230, 'Workshop · Horde'],
        [4298, 'Hangar · Horde'], [4299, 'Hangar · Alliance'],
        [4303, 'Docks · Horde'], [4304, 'Docks · Alliance'],
        [4308, 'Quarry · Horde'], [4309, 'Quarry · Alliance'],
        [4313, 'Refinery · Horde'], [4314, 'Refinery · Alliance'],
      ];
      for (const [id, label] of controlledStates) if (value(id)) labels.push(label);
      const breachedGates: Array<[number, string]> = [
        [4320, 'Horde east gate breached'], [4321, 'Horde west gate breached'],
        [4322, 'Horde front gate breached'], [4323, 'Alliance front gate breached'],
        [4324, 'Alliance west gate breached'], [4325, 'Alliance east gate breached'],
      ];
      for (const [id, label] of breachedGates) if (value(id)) labels.push(label);
      break;
    }
    case 607: {
      const gateStates: Array<[number, string]> = [
        [3614, 'Purple gate'], [3617, 'Red gate'], [3620, 'Blue gate'], [3623, 'Green gate'],
        [3638, 'Yellow gate'], [3849, 'Ancient gate'],
      ];
      const gateStatus = (state: number): string => ['Unknown', 'Intact', 'Damaged', 'Destroyed'][state]
        ?? `State ${state}`;
      for (const [id, label] of gateStates) {
        const state = value(id);
        if (state !== undefined) labels.push(`${label}: ${gateStatus(state)}`);
      }
      break;
    }
    default:
      break;
  }

  return labels;
}

export function getInstanceMapProfile(mapId: number): InstanceMapProfile | null {
  return INSTANCE_MAP_PROFILES.get(mapId) ?? null;
}

export function applyInstanceViewTransform(
  viewport: InstanceProjectionViewport,
  transform: InstanceViewTransform,
): InstanceProjectionViewport {
  const width = viewport.width * transform.zoom;
  const height = viewport.height * transform.zoom;
  return {
    x: viewport.x + (viewport.width - width) / 2 + transform.panX,
    y: viewport.y + (viewport.height - height) / 2 + transform.panY,
    width,
    height,
  };
}

// The flat map's closest zoom; the 3D view may allow closer.
export const INSTANCE_MAX_ZOOM = 6;

export function zoomInstanceViewAt(
  transform: InstanceViewTransform,
  viewport: InstanceProjectionViewport,
  anchorX: number,
  anchorY: number,
  zoom: number,
  maxZoom = INSTANCE_MAX_ZOOM,
): InstanceViewTransform {
  const nextZoom = Math.min(Math.max(INSTANCE_MAX_ZOOM, maxZoom), Math.max(1, zoom));
  if (nextZoom === 1) return { zoom: 1, panX: 0, panY: 0 };

  const current = applyInstanceViewTransform(viewport, transform);
  const relativeX = current.width ? (anchorX - current.x) / current.width : 0.5;
  const relativeY = current.height ? (anchorY - current.y) / current.height : 0.5;
  const nextWidth = viewport.width * nextZoom;
  const nextHeight = viewport.height * nextZoom;
  return {
    zoom: nextZoom,
    panX: anchorX - viewport.x - (viewport.width - nextWidth) / 2 - relativeX * nextWidth,
    panY: anchorY - viewport.y - (viewport.height - nextHeight) / 2 - relativeY * nextHeight,
  };
}

export function getInstanceProjectionViewport(
  width: number,
  height: number,
  aspectRatio: number,
): InstanceProjectionViewport {
  if (width / height > aspectRatio) {
    const viewportWidth = height * aspectRatio;
    return { x: (width - viewportWidth) / 2, y: 0, width: viewportWidth, height };
  }
  const viewportHeight = width / aspectRatio;
  return { x: 0, y: (height - viewportHeight) / 2, width, height: viewportHeight };
}

// A key's instanceId of 0 marks a public (non-instance) watch map session.
export function parseInstanceSessionKey(key: string | null): { mapId: number; instanceId: number } | null {
  if (!key) return null;
  const match = key.match(/^(\d+):(\d+)$/);
  if (!match) return null;
  const mapId = Number(match[1]);
  const instanceId = Number(match[2]);
  if (!Number.isInteger(mapId) || mapId < 0 || !Number.isInteger(instanceId) || instanceId < 0) return null;
  return { mapId, instanceId };
}

export function groupActiveInstanceSessions(players: MapPlayerPosition[]): ActiveInstanceSession[] {
  const grouped = new Map<string, ActiveInstanceSession>();
  for (const player of players) {
    if (!Number.isInteger(player.instanceId) || player.instanceId < 0) continue;
    // Public maps group only when the view can draw them; the continents
    // belong to the 2D Live Map, not here.
    if (player.instanceId === 0 && !PUBLIC_INSTANCE_WATCH_MAPS.has(player.map)) continue;
    const key = `${player.map}:${player.instanceId}`;
    let session = grouped.get(key);
    if (!session) {
      session = {
        key,
        mapId: player.map,
        instanceId: player.instanceId,
        // A public watch map is the map itself, no runtime instance number.
        label: player.instanceId === 0
          ? getMapName(player.map)
          : `${getMapName(player.map)} · #${player.instanceId}`,
        players: [],
      };
      grouped.set(key, session);
    }
    session.players.push(player);
  }

  return [...grouped.values()].sort((left, right) =>
    right.players.length - left.players.length || left.label.localeCompare(right.label));
}

// The dropdown's list: the always-on public watch maps (with the other
// public maps while players are aboard), then the runtime instances and
// battlegrounds. The public sessions lead so an emptied session falls back
// to a map the view can always draw.
export function buildActiveInstanceSessions(players: MapPlayerPosition[]): ActiveInstanceSession[] {
  const publicSessions: ActiveInstanceSession[] = [];
  const instanceSessions: ActiveInstanceSession[] = [];
  for (const session of groupActiveInstanceSessions(players)) {
    (session.instanceId === 0 ? publicSessions : instanceSessions).push(session);
  }
  for (const mapId of ALWAYS_ON_PUBLIC_WATCH_MAPS) {
    if (!publicSessions.some((session) => session.mapId === mapId)) {
      publicSessions.push({ key: `${mapId}:0`, mapId, instanceId: 0, label: getMapName(mapId), players: [] });
    }
  }
  publicSessions.sort((left, right) => left.mapId - right.mapId);
  return [...publicSessions, ...instanceSessions];
}

export function getInstanceCoordinateBounds(players: MapPlayerPosition[]): InstanceCoordinateBounds {
  if (!players.length) return { minX: -100, maxX: 100, minY: -100, maxY: 100 };
  const xValues = players.map((player) => player.position_x);
  const yValues = players.map((player) => player.position_y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const spanX = Math.max(200, maxX - minX);
  const spanY = Math.max(200, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    minX: centerX - spanX * 0.65,
    maxX: centerX + spanX * 0.65,
    minY: centerY - spanY * 0.65,
    maxY: centerY + spanY * 0.65,
  };
}

export function getParticipantDungeonFloor<Floor extends DungeonFloor>(
  player: Pick<MapPlayerPosition, 'position_x' | 'position_y' | 'position_z' | 'wmoGroupId'>,
  floors: Floor[],
): Floor | null {
  if (player.wmoGroupId !== undefined && player.wmoGroupId >= 0) {
    const matchingChunks = floors.flatMap((floor) => floor.chunks
      .filter((chunk) => chunk.wmoGroupId === player.wmoGroupId)
      .map((chunk) => ({ floor, minZ: chunk.minZ })));
    if (matchingChunks.length > 0) {
      const belowPlayer = matchingChunks
        .filter((candidate) => candidate.minZ <= player.position_z)
        .sort((left, right) => right.minZ - left.minZ);
      return (belowPlayer[0] ?? matchingChunks.sort((left, right) => left.minZ - right.minZ)[0]).floor;
    }
  }

  return floors.find((floor) =>
    player.position_x >= floor.bounds.minX
    && player.position_x <= floor.bounds.maxX
    && player.position_y >= floor.bounds.minY
    && player.position_y <= floor.bounds.maxY) ?? null;
}

export function projectMinimapTilePosition(
  position: Pick<MapPlayerPosition, 'position_x' | 'position_y'>,
  projection: MinimapTileProjection,
  width: number,
  height: number,
): { x: number; y: number } {
  const tileColumns = projection.maxTileX - projection.minTileX + 1;
  const tileRows = projection.maxTileY - projection.minTileY + 1;
  const fullTileX = projection.gridSize / 2 - position.position_y / projection.worldUnitsPerTile;
  const fullTileY = projection.gridSize / 2 - position.position_x / projection.worldUnitsPerTile;
  return {
    x: (fullTileX - projection.minTileX) / tileColumns * width,
    y: (fullTileY - projection.minTileY) / tileRows * height,
  };
}

export function projectInstancePosition(
  position: Pick<MapPlayerPosition, 'position_x' | 'position_y'>,
  bounds: InstanceCoordinateBounds,
  width: number,
  height: number,
): { x: number; y: number } {
  const x = ((bounds.maxY - position.position_y) / (bounds.maxY - bounds.minY)) * width;
  const y = ((bounds.maxX - position.position_x) / (bounds.maxX - bounds.minX)) * height;
  return { x, y };
}

// creature_template unit_flags and flags_extra bits.
const UNIT_FLAG_NON_ATTACKABLE = 0x2;
const UNIT_FLAG_IMMUNE_TO_PC = 0x100;
const UNIT_FLAG_NOT_SELECTABLE = 0x2000000;
const CREATURE_FLAG_EXTRA_TRIGGER = 0x80;
// Creature types a player's summon has when it is an object rather than a
// pet: not specified (healing flowers and the like), totem, non-combat pet.
const SUMMONED_OBJECT_TYPES = new Set([10, 11, 12]);

// Whether a creature is scenery or a summoned object, drawn without a name,
// nameplate, ring, facing, or path: units players can't select (Arathi
// Basin's workers) or that are script triggers; units that can't be
// attacked and offer nothing to talk to, unless they're fighting; and
// players' summoned objects. The module says so from the unit's live flags;
// creature_template's flags cover older modules. Bosses never are.
export function isSceneryCreature(
  creature: Pick<StreamCreatureSample, 'inCombat' | 'playerControlled' | 'scenery'>,
  info: Pick<CreatureInfo, 'unitFlags' | 'flagsExtra' | 'npcFlags' | 'creatureType'> | null | undefined,
  boss: boolean,
): boolean {
  if (boss) return false;
  if (creature.scenery) return true;
  if (!info) return false;
  const unitFlags = info.unitFlags ?? 0;
  if (unitFlags & UNIT_FLAG_NOT_SELECTABLE || (info.flagsExtra ?? 0) & CREATURE_FLAG_EXTRA_TRIGGER) return true;
  if (!creature.inCombat && unitFlags & (UNIT_FLAG_NON_ATTACKABLE | UNIT_FLAG_IMMUNE_TO_PC) && !info.npcFlags) return true;
  return creature.playerControlled && SUMMONED_OBJECT_TYPES.has(info.creatureType ?? 0);
}
