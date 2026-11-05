import type {
  MapBattlegroundState,
  MapInstanceDeath,
  MapInstanceState,
  MapPlayerPosition,
  MapSessionEvent,
  MapTransportPosition,
} from './types/api';

const TELEMETRY_FIELDS_V1 = 15;
const TELEMETRY_FIELDS_V2 = 29;
const TELEMETRY_FIELDS_V3 = 31;
const TELEMETRY_FIELDS_V4 = 32;
const TELEMETRY_FIELDS_V6 = 34;
const TELEMETRY_FIELDS_V7 = 34;
// entry|name|mapId|instanceId|x|y|z|orientation|pathProgress|displayId.
const TRANSPORT_FIELDS = 11;
const BATTLEGROUND_FIELDS = 17;
const OBJECTIVE_FIELDS = 5;
const INSTANCE_FIELDS = 4;
const BOSS_FIELDS = 6;
const DEATH_FIELDS = 10;
const EVENT_FIELDS = 14;

export interface LiveMapTelemetrySnapshot {
  players: MapPlayerPosition[];
  transports: MapTransportPosition[];
  battlegrounds: MapBattlegroundState[];
  instances: MapInstanceState[];
  deaths: MapInstanceDeath[];
  events: MapSessionEvent[];
}

export function buildLiveMapTelemetryCommand(mapId?: number, instanceId?: number): string {
  const filters: number[] = [];
  if (Number.isInteger(mapId)) filters.push(mapId as number);
  if (filters.length > 0 && Number.isInteger(instanceId)) filters.push(instanceId as number);
  return `wowmin telemetry${filters.length > 0 ? ` ${filters.join(' ')}` : ''}`;
}

function finiteNumber(value: string): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decodeTelemetryField(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseLiveMapTelemetrySnapshot(message: string): LiveMapTelemetrySnapshot | null {
  const lines = message.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  const versionLines = lines.filter((line) => line.startsWith('WMAP_VERSION|'));
  const protocolVersion = versionLines.length > 0
    ? finiteNumber(versionLines[0].slice('WMAP_VERSION|'.length))
    : 1;
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(protocolVersion ?? 0)
    || versionLines.some((line) => finiteNumber(line.slice('WMAP_VERSION|'.length)) !== protocolVersion)) {
    return null;
  }

  const players: MapPlayerPosition[] = [];
  const transports: MapTransportPosition[] = [];
  const battlegrounds: MapBattlegroundState[] = [];
  const instances: MapInstanceState[] = [];
  const deaths: MapInstanceDeath[] = [];
  const events: MapSessionEvent[] = [];
  const battlegroundsByKey = new Map<string, MapBattlegroundState>();
  const instancesByKey = new Map<string, MapInstanceState>();
  let declaredPlayerCount: number | null = null;
  let declaredTransportCount = 0;
  let declaredBattlegroundCount = 0;
  let declaredObjectiveCount = 0;
  let declaredInstanceCount = 0;
  let declaredBossCount = 0;
  let declaredDeathCount = 0;
  let declaredEventCount = 0;
  let parsedObjectiveCount = 0;
  let parsedBossCount = 0;

  for (const line of lines) {
    if (line.startsWith('WMAP_VERSION|')) continue;
    if (line.startsWith('WMAP_END|')) {
      const counts = line.split('|').slice(1).map(finiteNumber);
      if (counts.some((value) => value === null)) return null;
      if (protocolVersion === 8 && counts.length !== 8) return null;
      if ((protocolVersion === 5 || protocolVersion === 6 || protocolVersion === 7) && counts.length !== 7) return null;
      if (protocolVersion === 4 && counts.length !== 6) return null;
      if (protocolVersion === 3 && counts.length !== 3) return null;
      if ((protocolVersion ?? 0) < 3 && counts.length !== 1) return null;
      // v8 inserts the transport count after the player count; older versions
      // have no slot for it.
      if (protocolVersion === 8) {
        [
          declaredPlayerCount,
          declaredTransportCount,
          declaredBattlegroundCount = 0,
          declaredObjectiveCount = 0,
          declaredInstanceCount = 0,
          declaredBossCount = 0,
          declaredDeathCount = 0,
          declaredEventCount = 0,
        ] = counts as number[];
      } else {
        [
          declaredPlayerCount,
          declaredBattlegroundCount = 0,
          declaredObjectiveCount = 0,
          declaredInstanceCount = 0,
          declaredBossCount = 0,
          declaredDeathCount = 0,
          declaredEventCount = 0,
        ] = counts as number[];
      }
      continue;
    }
    if (line.startsWith('WBG|')) {
      if ((protocolVersion ?? 0) < 3) return null;
      const fields = line.split('|');
      if (fields.length !== BATTLEGROUND_FIELDS) return null;
      const values = fields.slice(1).map(finiteNumber);
      if (values.some((value) => value === null)) return null;
      const [mapId, instanceId, battlegroundTypeId, status, elapsedMs, remainingMs, winner,
        allianceScore, hordeScore, alliancePlayers, hordePlayers, allianceAlive, hordeAlive,
        nextResurrectMs, allianceStrategy, hordeStrategy] = values as number[];
      const battleground: MapBattlegroundState = {
        mapId,
        instanceId,
        battlegroundTypeId,
        status,
        elapsedMs,
        remainingMs,
        winner,
        allianceScore,
        hordeScore,
        alliancePlayers,
        hordePlayers,
        allianceAlive,
        hordeAlive,
        nextResurrectMs,
        allianceStrategy,
        hordeStrategy,
        worldStates: [],
      };
      battlegrounds.push(battleground);
      battlegroundsByKey.set(`${mapId}:${instanceId}`, battleground);
      continue;
    }
    if (line.startsWith('WOBJ|')) {
      if ((protocolVersion ?? 0) < 3) return null;
      const fields = line.split('|');
      if (fields.length !== OBJECTIVE_FIELDS) return null;
      const values = fields.slice(1).map(finiteNumber);
      if (values.some((value) => value === null)) return null;
      const [mapId, instanceId, id, value] = values as number[];
      const battleground = battlegroundsByKey.get(`${mapId}:${instanceId}`);
      if (!battleground) return null;
      battleground.worldStates.push({ id, value });
      parsedObjectiveCount += 1;
      continue;
    }
    if (line.startsWith('WINS|')) {
      if ((protocolVersion ?? 0) < 4) return null;
      const fields = line.split('|');
      if (fields.length !== INSTANCE_FIELDS) return null;
      const values = fields.slice(1).map(finiteNumber);
      if (values.some((value) => value === null)) return null;
      const [mapId, instanceId, completedEncounterMask] = values as number[];
      const instance: MapInstanceState = { mapId, instanceId, completedEncounterMask, bosses: [] };
      instances.push(instance);
      instancesByKey.set(`${mapId}:${instanceId}`, instance);
      continue;
    }
    if (line.startsWith('WBOSS|')) {
      if ((protocolVersion ?? 0) < 4) return null;
      const fields = line.split('|');
      if (fields.length !== BOSS_FIELDS) return null;
      const values = fields.slice(1, 5).map(finiteNumber);
      const name = decodeTelemetryField(fields[5]);
      if (name === null || values.some((value) => value === null)) return null;
      const [mapId, instanceId, id, state] = values as number[];
      const instance = instancesByKey.get(`${mapId}:${instanceId}`);
      if (!instance) return null;
      instance.bosses.push({ id, state, name });
      parsedBossCount += 1;
      continue;
    }
    if (line.startsWith('WDEATH|')) {
      if ((protocolVersion ?? 0) < 4) return null;
      const fields = line.split('|');
      if (fields.length !== DEATH_FIELDS) return null;
      const values = [...fields.slice(1, 6), ...fields.slice(7, 9)].map(finiteNumber);
      const victimName = decodeTelemetryField(fields[6]);
      const killerName = decodeTelemetryField(fields[9]);
      if (victimName === null || killerName === null || values.some((value) => value === null)) return null;
      const [mapId, instanceId, eventId, occurredAt, victimGuid, killerGuid, killerType] = values as number[];
      deaths.push({
        mapId,
        instanceId,
        eventId,
        occurredAt,
        victimGuid,
        victimName,
        killerGuid,
        killerType,
        killerName,
      });
      continue;
    }
    if (line.startsWith('WEVENT|')) {
      if ((protocolVersion ?? 0) < 5) return null;
      const fields = line.split('|');
      if (fields.length !== EVENT_FIELDS) return null;
      const values = [...fields.slice(1, 5), fields[6], fields[8], fields[9], fields[11], fields[13]].map(finiteNumber);
      const type = decodeTelemetryField(fields[5]);
      const actorName = decodeTelemetryField(fields[7]);
      const targetName = decodeTelemetryField(fields[10]);
      const valueName = decodeTelemetryField(fields[12]);
      if (type === null || actorName === null || targetName === null || valueName === null
        || values.some((value) => value === null)) return null;
      const [mapId, instanceId, eventId, occurredAt, actorGuid, targetGuid, targetType, valueId, amount] = values as number[];
      events.push({ mapId, instanceId, eventId, occurredAt, type, actorGuid, actorName, targetGuid,
        targetType, targetName, valueId, valueName, amount });
      continue;
    }
    if (line.startsWith('WTRN|')) {
      if (protocolVersion !== 8) return null;
      const fields = line.split('|');
      if (fields.length !== TRANSPORT_FIELDS) return null;
      const name = decodeTelemetryField(fields[2]);
      const values = [...fields.slice(1, 2), ...fields.slice(3, 9), ...fields.slice(9, 11)].map(finiteNumber);
      if (name === null || values.some((value) => value === null)) return null;
      const [entry, map, instanceId, position_x, position_y, position_z, orientation, pathProgress, displayId] =
        values as number[];
      transports.push({ entry, name, map, instanceId, position_x, position_y, position_z, orientation,
        pathProgress, displayId });
      continue;
    }
    if (!line.startsWith('WMAP|')) continue;

    const fields = line.split('|');
    const expectedFields = protocolVersion === 7 || protocolVersion === 8
      ? TELEMETRY_FIELDS_V7
      : protocolVersion === 6
        ? TELEMETRY_FIELDS_V6
        : (protocolVersion ?? 0) >= 4
          ? TELEMETRY_FIELDS_V4
          : protocolVersion === 3
            ? TELEMETRY_FIELDS_V3
            : protocolVersion === 2 ? TELEMETRY_FIELDS_V2 : TELEMETRY_FIELDS_V1;
    if (fields.length !== expectedFields) return null;
    const name = (protocolVersion ?? 0) >= 2 ? decodeTelemetryField(fields[1]) : fields[1];
    const baseValues = fields.slice(2, TELEMETRY_FIELDS_V1).map(finiteNumber);
    if (!name || baseValues.some((value) => value === null)) return null;

    const [map, instanceId, position_x, position_y, position_z, orientation, level, race, playerClass,
      accountId, isBot, alive, inCombat] = baseValues as number[];
    const player: MapPlayerPosition = {
      name,
      map,
      instanceId,
      position_x,
      position_y,
      position_z,
      orientation,
      level,
      race,
      class: playerClass,
      account: isBot ? `RNDBOT:${accountId}` : String(accountId),
      accountId,
      isBot: isBot !== 0,
      alive: alive !== 0,
      inCombat: inCombat !== 0,
    };

    if ((protocolVersion ?? 0) >= 2) {
      const extensionValues = [...fields.slice(TELEMETRY_FIELDS_V1, 27), fields[28]].map(finiteNumber);
      const targetName = decodeTelemetryField(fields[27]);
      if (targetName === null || extensionValues.some((value) => value === null)) return null;
      const [mapType, difficulty, sessionStartedAt, groupId, isRaidGroup, subgroup, teamId,
        healthPct, powerType, powerPct, targetGuid, targetType, roleMask] = extensionValues as number[];
      Object.assign(player, {
        mapType,
        difficulty,
        sessionStartedAt,
        groupId,
        isRaidGroup: isRaidGroup !== 0,
        subgroup,
        teamId,
        healthPct,
        powerType,
        powerPct,
        targetGuid,
        targetType,
        targetName,
        roleMask,
      });
    }

    if ((protocolVersion ?? 0) >= 3) {
      const waitingForResurrect = finiteNumber(fields[29]);
      const battlegroundRole = finiteNumber(fields[30]);
      if (waitingForResurrect === null || battlegroundRole === null) return null;
      player.waitingForResurrect = waitingForResurrect !== 0;
      player.battlegroundRole = battlegroundRole;
    }

    if ((protocolVersion ?? 0) >= 4) {
      const wmoGroupId = finiteNumber(fields[31]);
      if (wmoGroupId === null) return null;
      player.wmoGroupId = wmoGroupId;
    }

    if (protocolVersion === 6 || protocolVersion === 7) {
      const gender = finiteNumber(fields[32]);
      const stateFlags = finiteNumber(fields[33]);
      if (gender === null || stateFlags === null) return null;
      player.gender = gender;
      player.onTaxi = (stateFlags & 1) !== 0;
      player.mounted = (stateFlags & 2) !== 0;
      player.sapped = (stateFlags & 4) !== 0;
      player.stunned = (stateFlags & 8) !== 0;
      player.spiritForm = (stateFlags & 16) !== 0;
      if (protocolVersion === 7) player.flagCarrier = (stateFlags & 32) !== 0;
    }

    players.push(player);
  }

  if (declaredPlayerCount !== players.length
    || declaredTransportCount !== transports.length
    || declaredBattlegroundCount !== battlegrounds.length
    || declaredObjectiveCount !== parsedObjectiveCount
    || declaredInstanceCount !== instances.length
    || declaredBossCount !== parsedBossCount
    || declaredDeathCount !== deaths.length
    || declaredEventCount !== events.length) {
    return null;
  }
  return { players, transports, battlegrounds, instances, deaths, events };
}

export function parseLiveMapTelemetry(message: string): MapPlayerPosition[] | null {
  return parseLiveMapTelemetrySnapshot(message)?.players ?? null;
}
