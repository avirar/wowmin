const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const output = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../renderer/scripts/utils/instance-watch.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;
const context = { module: { exports: {} } };
context.exports = context.module.exports;
vm.runInNewContext(output, context);
const {
  applyInstanceViewTransform,
  buildActiveInstanceSessions,
  getBattlegroundObjectiveLabels,
  getBattlegroundStatusLabel,
  getBattlegroundStrategyLabel,
  getInstanceCoordinateBounds,
  getInstanceFactionColor,
  getInstanceMapProfile,
  getInstanceProjectionViewport,
  getParticipantDungeonFloor,
  getTramSchematic,
  groupActiveInstanceSessions,
  isSceneryCreature,
  parseInstanceSessionKey,
  projectInstancePosition,
  projectMinimapTilePosition,
  zoomInstanceViewAt,
} = context.module.exports;

function player(name, map, instanceId, x, y) {
  return { name, map, instanceId, position_x: x, position_y: y };
}

test('uses core TeamId colors consistently', () => {
  assert.equal(getInstanceFactionColor(0), '#3b82f6');
  assert.equal(getInstanceFactionColor(1), '#ef4444');
  assert.equal(getInstanceFactionColor(2), null);
});

test('parses an active runtime session key into telemetry filters', () => {
  const parsed = parseInstanceSessionKey('489:12');
  assert.equal(parsed.mapId, 489);
  assert.equal(parsed.instanceId, 12);
  assert.equal(parseInstanceSessionKey('489'), null);
  // A 0 instanceId is a public (non-instance) watch map session.
  const publicKey = parseInstanceSessionKey('369:0');
  assert.equal(publicKey.mapId, 369);
  assert.equal(publicKey.instanceId, 0);
});

test('decodes common battleground status, strategy, and objective states', () => {
  assert.equal(getBattlegroundStatusLabel(3), 'In progress');
  assert.equal(getBattlegroundStrategyLabel(2, 1), 'Offensive');
  const labels = getBattlegroundObjectiveLabels({
    mapId: 489,
    allianceScore: 1,
    hordeScore: 2,
    worldStates: [{ id: 2339, value: 2 }, { id: 2338, value: 1 }],
  });
  assert.equal(labels[0], 'Alliance flag: Carried');
  assert.equal(labels[1], 'Horde flag: At base');
});

test('groups only active runtime instances', () => {
  const sessions = groupActiveInstanceSessions([
    player('Outside', 0, 0, 0, 0),
    player('Alpha', 489, 12, 100, 200),
    player('Bravo', 489, 12, 110, 210),
    player('Charlie', 33, 99, -10, 20),
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].key, '489:12');
  assert.equal(sessions[0].players.length, 2);
});

test('groups players aboard public watch maps as map sessions', () => {
  const sessions = groupActiveInstanceSessions([
    player('TramRider', 369, 0, 4.5, 1000),
    player('DK', 609, 0, 2355, -5664),
    // A continent player is not a public watch map session.
    player('Farmer', 0, 0, 100, 100),
    // An unwatched public map is not one either.
    player('Stranger', 126, 0, 0, 0),
  ]);
  // One player each: the runtime sort is by label, so Ebon Hold leads.
  assert.deepEqual(
    sessions.map((session) => session.key).join(','),
    '609:0,369:0',
  );
  const tram = sessions.find((session) => session.key === '369:0');
  const ebonHold = sessions.find((session) => session.key === '609:0');
  assert.equal(tram.label, 'Deeprun Tram');
  assert.equal(ebonHold.label, 'Acherus: The Ebon Hold');
  assert.equal(tram.players.length, 1);
});

test('keeps the always-on public watch maps listed without players', () => {
  const sessions = buildActiveInstanceSessions([
    player('DK', 609, 0, 2355, -5664),
    player('Alpha', 489, 12, 100, 200),
  ]);
  // The public sessions lead, ordered by mapId, ahead of the runtime ones.
  assert.equal(
    sessions.map((session) => session.key).join(','),
    '369:0,609:0,489:12',
  );
  assert.equal(sessions[0].players.length, 0);
  // Nobody anywhere: the tram is still listed.
  const empty = buildActiveInstanceSessions([]);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].key, '369:0');
});

test('labels map 628 as Isle of Conquest', () => {
  const [session] = groupActiveInstanceSessions([
    player('Alpha', 628, 12, 100, 200),
  ]);
  assert.equal(session.label, 'Isle of Conquest · #12');
});

test('selects dungeon floors independently from WMO group and coordinate bounds', () => {
  const floors = [
    { id: 10, floorIndex: 1, bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 }, chunks: [{ wmoGroupId: 50, minZ: 0 }] },
    { id: 11, floorIndex: 2, bounds: { minX: 100, maxX: 200, minY: 100, maxY: 200 }, chunks: [{ wmoGroupId: 51, minZ: 25 }] },
  ];
  assert.equal(getParticipantDungeonFloor({ position_x: 10, position_y: 10, position_z: 30, wmoGroupId: 51 }, floors).id, 11);
  assert.equal(getParticipantDungeonFloor({ position_x: 20, position_y: 20, position_z: 0, wmoGroupId: -1 }, floors).id, 10);
});

test('patched Shadowfang Keep chunks switch a shared WMO group at its Z threshold', () => {
  // M patch: group 1380 maps to DungeonMap 144 below Z=127 and 145 above it.
  const bounds = { minX: -194, maxX: -91, minY: 2103, maxY: 2257 };
  const floors = [
    { id: 144, floorIndex: 3, bounds, chunks: [{ wmoGroupId: 1380, minZ: -10000 }] },
    { id: 145, floorIndex: 4, bounds, chunks: [{ wmoGroupId: 1380, minZ: 127 }] },
  ];
  const position = { position_x: -150, position_y: 2200, wmoGroupId: 1380 };
  assert.equal(getParticipantDungeonFloor({ ...position, position_z: 126 }, floors).id, 144);
  assert.equal(getParticipantDungeonFloor({ ...position, position_z: 127 }, floors).id, 145);
});

test('auto-fit projection keeps a single-player session visible', () => {
  const players = [player('Solo', 33, 4, 500, -200)];
  const bounds = getInstanceCoordinateBounds(players);
  const point = projectInstancePosition(players[0], bounds, 800, 600);
  assert.equal(point.x, 400);
  assert.equal(point.y, 300);
});

test('Warsong Gulch uses fixed client-calibrated bounds and swapped axes', () => {
  const profile = getInstanceMapProfile(489);
  assert.ok(profile);
  assert.equal(profile.source, 'WorldMapArea.dbc:443');
  const topLeft = projectInstancePosition({
    position_x: profile.bounds.maxX,
    position_y: profile.bounds.maxY,
  }, profile.bounds, 1200, 800);
  const bottomRight = projectInstancePosition({
    position_x: profile.bounds.minX,
    position_y: profile.bounds.minY,
  }, profile.bounds, 1200, 800);
  assert.equal(topLeft.x, 0);
  assert.equal(topLeft.y, 0);
  assert.equal(bottomRight.x, 1200);
  assert.equal(bottomRight.y, 800);
});

test('keeps the whole Deeprun Tram in frame from its static schematic', () => {
  const profile = getInstanceMapProfile(369);
  assert.ok(profile);
  assert.notEqual(profile.source, 'WorldMapArea.dbc:443');
  const schematic = getTramSchematic(369);
  assert.equal(schematic.mapId, 369);
  assert.equal(schematic.tracks.length, 2);
  for (const track of schematic.tracks) {
    assert.ok(track.x >= schematic.bounds.minX && track.x <= schematic.bounds.maxX);
    assert.equal(track.minY, schematic.bounds.minY);
    assert.equal(track.maxY, schematic.bounds.maxY);
  }
  // The station platforms sit at the line's two ends, inside the bounds.
  assert.equal(schematic.stations.map((station) => station.label).join(','), 'Orgrimmar,Undercity');
  for (const station of schematic.stations) {
    assert.ok(station.y > schematic.bounds.minY && station.y < schematic.bounds.maxY);
  }
  // A mid-tunnel car projects near the strip's centre; the tram has no art,
  // so no other map carries a schematic.
  const middle = projectInstancePosition(
    { position_x: schematic.tracks[0].x, position_y: (schematic.bounds.minY + schematic.bounds.maxY) / 2 },
    profile.bounds, 800, 60);
  assert.ok(Math.abs(middle.x - 400) < 1);
  assert.equal(getTramSchematic(609), null);
});

test('pan and anchored zoom preserve the selected map point', () => {
  const viewport = { x: 10, y: 20, width: 800, height: 600 };
  const transform = { zoom: 1.5, panX: 30, panY: -20 };
  const anchor = { x: 300, y: 250 };
  const before = applyInstanceViewTransform(viewport, transform);
  const relative = { x: (anchor.x - before.x) / before.width, y: (anchor.y - before.y) / before.height };
  const zoomed = zoomInstanceViewAt(transform, viewport, anchor.x, anchor.y, 2.5);
  const after = applyInstanceViewTransform(viewport, zoomed);
  assert.ok(Math.abs(after.x + relative.x * after.width - anchor.x) < 0.001);
  assert.ok(Math.abs(after.y + relative.y * after.height - anchor.y) < 0.001);
});

test('returning to normal zoom recenters the map', () => {
  const reset = zoomInstanceViewAt(
    { zoom: 2, panX: 180, panY: -90 },
    { x: 10, y: 20, width: 800, height: 600 },
    250,
    300,
    1,
  );
  assert.equal(reset.zoom, 1);
  assert.equal(reset.panX, 0);
  assert.equal(reset.panY, 0);
});

test('client map aspect is letterboxed instead of stretched', () => {
  const viewport = getInstanceProjectionViewport(1600, 900, 1.5);
  assert.equal(viewport.x, 125);
  assert.equal(viewport.y, 0);
  assert.equal(viewport.width, 1350);
  assert.equal(viewport.height, 900);
});

test('minimap tile projection aligns world coordinates with a cropped tile image', () => {
  const units = 533.3333333333334;
  const projection = {
    gridSize: 64,
    worldUnitsPerTile: units,
    minTileX: 25,
    maxTileX: 29,
    minTileY: 30,
    maxTileY: 34,
  };
  const topLeft = projectMinimapTilePosition({
    position_x: (32 - projection.minTileY) * units,
    position_y: (32 - projection.minTileX) * units,
  }, projection, 1280, 1280);
  assert.equal(topLeft.x, 0);
  assert.equal(topLeft.y, 0);
});

test('zoom stops at the flat map limit unless a closer one is allowed', () => {
  const viewport = { x: 0, y: 0, width: 800, height: 600 };
  assert.equal(zoomInstanceViewAt({ zoom: 5, panX: 0, panY: 0 }, viewport, 400, 300, 20).zoom, 6);
  assert.equal(zoomInstanceViewAt({ zoom: 5, panX: 0, panY: 0 }, viewport, 400, 300, 20, 30).zoom, 20);
  assert.equal(zoomInstanceViewAt({ zoom: 5, panX: 0, panY: 0 }, viewport, 400, 300, 40, 30).zoom, 30);
  // A limit below the flat map's never makes zooming stop sooner.
  assert.equal(zoomInstanceViewAt({ zoom: 5, panX: 0, panY: 0 }, viewport, 400, 300, 6, 2).zoom, 6);
});

test('leaves scenery and summoned objects without names or plates', () => {
  const info = (fields) => ({ unitFlags: 0, flagsExtra: 0, npcFlags: 0, creatureType: 7, ...fields });
  const idle = { inCombat: false, playerControlled: false };
  // Arathi Basin's workers: not selectable.
  assert.equal(isSceneryCreature(idle, info({ unitFlags: 0x2000300 }), false), true);
  // Script triggers.
  assert.equal(isSceneryCreature(idle, info({ flagsExtra: 0x82 }), false), true);
  // Can't be attacked and nothing to talk to: scenery, unless fighting.
  assert.equal(isSceneryCreature(idle, info({ unitFlags: 0x302 }), false), true);
  assert.equal(isSceneryCreature({ ...idle, inCombat: true }, info({ unitFlags: 0x302 }), false), false);
  assert.equal(isSceneryCreature(idle, info({ unitFlags: 0x300, npcFlags: 1 }), false), false);
  // Players' summoned objects, but not their pets.
  const summon = { inCombat: false, playerControlled: true };
  for (const creatureType of [10, 11, 12]) assert.equal(isSceneryCreature(summon, info({ creatureType }), false), true);
  assert.equal(isSceneryCreature(summon, info({ creatureType: 1 }), false), false);
  assert.equal(isSceneryCreature(idle, info({ creatureType: 10 }), false), false);
  // Ordinary mobs, bosses, and unknown creatures keep theirs.
  assert.equal(isSceneryCreature(idle, info({}), false), false);
  assert.equal(isSceneryCreature(idle, info({ unitFlags: 0x2000000 }), true), false);
  assert.equal(isSceneryCreature(idle, null, false), false);
  // The module's live flag, even before creature details load.
  assert.equal(isSceneryCreature({ ...idle, scenery: true }, null, false), true);
  assert.equal(isSceneryCreature({ ...idle, scenery: true }, null, true), false);
});
