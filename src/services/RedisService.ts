import { RedisClientType } from 'redis';
import { RedisConfig } from '../config/redis';
import { ChunkZoneData, ZoneEvent } from '../models/Zone';
import { PlayerPosition, PlayerZones } from '../models/Player';
import { SecurityUtils } from '../utils/security';
import { logger } from '../utils/logger';

export class RedisService {
  private client: RedisClientType | null = null;
  private publisher: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;

  async init(): Promise<void> {
    try {
      this.client = await RedisConfig.getClient();
      this.publisher = await RedisConfig.getPublisher();
      this.subscriber = await RedisConfig.getSubscriber();
      
      // ✅ Activer les keyspace notifications pour les positions
      await this.client.configSet('notify-keyspace-events', 'Kh');
      logger.info('✅ Redis keyspace notifications enabled - Real-time position tracking ON');
      
      logger.info('Redis service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Redis service', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private getClient(): RedisClientType {
    if (!this.client) throw new Error('Redis client not initialized');
    return this.client;
  }

  private getPublisher(): RedisClientType {
    if (!this.publisher) throw new Error('Redis publisher not initialized');
    return this.publisher;
  }

  private getSubscriber(): RedisClientType {
    if (!this.subscriber) throw new Error('Redis subscriber not initialized');
    return this.subscriber;
  }

  // ========== GESTION CHUNKS ==========
  async setChunkZone(chunkX: number, chunkZ: number, zoneData: ChunkZoneData): Promise<void> {
    if (!SecurityUtils.isValidChunkCoordinate(chunkX) || !SecurityUtils.isValidChunkCoordinate(chunkZ)) {
      throw new Error('Invalid chunk coordinates');
    }

    const key = `chunk:zone:${chunkX}:${chunkZ}`;
    const client = this.getClient();
    
    try {
      const data: Record<string, string> = {
        region_id: zoneData.regionId?.toString() || '',
        region_name: zoneData.regionName || '',
        node_id: zoneData.nodeId?.toString() || '',
        node_name: zoneData.nodeName || '',
        city_id: zoneData.cityId?.toString() || '',
        city_name: zoneData.cityName || ''
      };

      await client.hSet(key, data);
      await client.expire(key, parseInt(process.env.CACHE_TTL_CHUNKS || '86400'));
    } catch (error) {
      logger.error('Failed to set chunk zone', { 
        chunkX, 
        chunkZ, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to save chunk zone');
    }
  }

  async getChunkZone(chunkX: number, chunkZ: number): Promise<ChunkZoneData | null> {
    const key = `chunk:zone:${chunkX}:${chunkZ}`;
    const client = this.getClient();
    
    try {
      const data = await client.hGetAll(key);
      
      if (Object.keys(data).length === 0) {
        return null;
      }
      
      return {
        regionId: data.region_id && data.region_id !== '' ? parseInt(data.region_id) : null,
        regionName: data.region_name && data.region_name !== '' ? data.region_name : null,
        nodeId: data.node_id && data.node_id !== '' ? parseInt(data.node_id) : null,
        nodeName: data.node_name && data.node_name !== '' ? data.node_name : null,
        cityId: data.city_id && data.city_id !== '' ? parseInt(data.city_id) : null,
        cityName: data.city_name && data.city_name !== '' ? data.city_name : null
      };
    } catch (error) {
      logger.error('Failed to get chunk zone', { 
        chunkX, 
        chunkZ, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch chunk zone');
    }
  }

  async deleteChunkZone(chunkX: number, chunkZ: number): Promise<void> {
    const key = `chunk:zone:${chunkX}:${chunkZ}`;
    const client = this.getClient();
    
    try {
      await client.del(key);
    } catch (error) {
      logger.error('Failed to delete chunk zone', { 
        chunkX, 
        chunkZ, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to delete chunk zone');
    }
  }

  async deleteChunkZonesByPattern(pattern: string): Promise<number> {
    if (!SecurityUtils.isValidRedisPattern(pattern)) {
      throw new Error('Invalid Redis pattern');
    }

    const client = this.getClient();
    
    try {
      const keys = await client.keys(pattern);
      if (keys.length === 0) return 0;
      
      // Process in batches to avoid overloading Redis
      const batchSize = 1000;
      let deletedCount = 0;
      
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        await client.del(batch);
        deletedCount += batch.length;
      }
      
      logger.info('Chunk zones deleted by pattern', { pattern, deletedCount });
      return deletedCount;
    } catch (error) {
      logger.error('Failed to delete chunk zones by pattern', { 
        pattern, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to delete zones by pattern');
    }
  }

  // ========== REDIS KEYS (ajout pour keyspace notifications) ==========
  async keys(pattern: string): Promise<string[]> {
    const client = this.getClient();
    
    try {
      return await client.keys(pattern);
    } catch (error) {
      logger.error('Failed to get Redis keys', { 
        pattern, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to get Redis keys');
    }
  }

  // ========== POSITIONS JOUEURS ==========
  async setPlayerPosition(uuid: string, position: PlayerPosition): Promise<void> {
    if (!SecurityUtils.isValidUUID(uuid)) {
      throw new Error('Invalid player UUID');
    }

    const key = `player:pos:${uuid}`;
    const client = this.getClient();
    
    try {
      const data: Record<string, string> = {
        x: position.x.toString(),
        y: position.y.toString(),
        z: position.z.toString(),
        chunk_x: position.chunk_x.toString(),
        chunk_z: position.chunk_z.toString(),
        timestamp: position.timestamp.toString()
      };

      await client.hSet(key, data);
      await client.expire(key, parseInt(process.env.CACHE_TTL_CHUNKS || '86400'));
    } catch (error) {
      logger.error('Failed to set player position', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to save player position');
    }
  }

  async setPlayerChunk(uuid: string, chunkX: number, chunkZ: number): Promise<void> {
    if (!SecurityUtils.isValidUUID(uuid)) {
      throw new Error('Invalid player UUID');
    }

    if (!SecurityUtils.isValidChunkCoordinate(chunkX) || !SecurityUtils.isValidChunkCoordinate(chunkZ)) {
      throw new Error('Invalid chunk coordinates');
    }

    const key = `player:chunk:${uuid}`;
    const client = this.getClient();
    
    try {
      const data: Record<string, string> = {
        chunk_x: chunkX.toString(),
        chunk_z: chunkZ.toString(),
        timestamp: Date.now().toString()
      };

      await client.hSet(key, data);
      await client.expire(key, parseInt(process.env.CACHE_TTL_CHUNKS || '86400'));
    } catch (error) {
      logger.error('Failed to set player chunk', { 
        uuid, 
        chunkX, 
        chunkZ, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to save player chunk');
    }
  }

  async getPlayerPosition(uuid: string): Promise<PlayerPosition | null> {
    const key = `player:pos:${uuid}`;
    const client = this.getClient();
    
    try {
      const data = await client.hGetAll(key);
      
      if (Object.keys(data).length === 0) {
        return null;
      }
      
      const x = data.x;
      const y = data.y;
      const z = data.z;
      const chunkX = data.chunk_x;
      const chunkZ = data.chunk_z;
      const timestamp = data.timestamp;

      if (!x || !y || !z || !chunkX || !chunkZ || !timestamp) {
        return null;
      }
      
      return {
        x: parseFloat(x),
        y: parseFloat(y),
        z: parseFloat(z),
        chunk_x: parseInt(chunkX),
        chunk_z: parseInt(chunkZ),
        timestamp: parseInt(timestamp)
      };
    } catch (error) {
      logger.error('Failed to get player position', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch player position');
    }
  }

  async getPlayerChunk(uuid: string): Promise<{ chunk_x: number; chunk_z: number; timestamp: number } | null> {
    const key = `player:chunk:${uuid}`;
    const client = this.getClient();
    
    try {
      const data = await client.hGetAll(key);
      
      if (Object.keys(data).length === 0) {
        return null;
      }

      const chunkX = data.chunk_x;
      const chunkZ = data.chunk_z;
      const timestamp = data.timestamp;

      if (!chunkX || !chunkZ || !timestamp) {
        return null;
      }
      
      return {
        chunk_x: parseInt(chunkX),
        chunk_z: parseInt(chunkZ),
        timestamp: parseInt(timestamp)
      };
    } catch (error) {
      logger.error('Failed to get player chunk', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch player chunk');
    }
  }

  async setPlayerZones(uuid: string, zones: PlayerZones): Promise<void> {
    const key = `player:zones:${uuid}`;
    const client = this.getClient();
    
    try {
      const data: Record<string, string> = {
        last_update: zones.last_update.toString()
      };

      if (zones.region_id !== undefined) data.region_id = zones.region_id.toString();
      if (zones.node_id !== undefined) data.node_id = zones.node_id.toString();
      if (zones.city_id !== undefined) data.city_id = zones.city_id.toString();

      await client.hSet(key, data);
      await client.expire(key, parseInt(process.env.CACHE_TTL_CHUNKS || '86400'));
    } catch (error) {
      logger.error('Failed to set player zones', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to save player zones');
    }
  }

  async getPlayerZones(uuid: string): Promise<PlayerZones | null> {
    const key = `player:zones:${uuid}`;
    const client = this.getClient();
    
    try {
      const data = await client.hGetAll(key);
      
      if (Object.keys(data).length === 0) {
        return null;
      }

      const lastUpdate = data.last_update;
      if (!lastUpdate) {
        return null;
      }
      
      return {
        region_id: data.region_id && data.region_id !== '' ? parseInt(data.region_id) : undefined,
        node_id: data.node_id && data.node_id !== '' ? parseInt(data.node_id) : undefined,
        city_id: data.city_id && data.city_id !== '' ? parseInt(data.city_id) : undefined,
        last_update: parseInt(lastUpdate)
      };
    } catch (error) {
      logger.error('Failed to get player zones', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch player zones');
    }
  }

  // ========== KEYSPACE NOTIFICATIONS LISTENER ==========
  async subscribeToKeyspaceEvents(callback: (uuid: string, operation: string) => void): Promise<void> {
    const subscriber = this.getSubscriber();
    
    try {
      // S'abonner aux notifications sur les positions et chunks
      await subscriber.pSubscribe('__keyspace@0__:player:pos:*', (message, channel) => {
        const uuid = channel.replace('__keyspace@0__:player:pos:', '');
        callback(uuid, 'position_update');
      });
      
      await subscriber.pSubscribe('__keyspace@0__:player:chunk:*', (message, channel) => {
        const uuid = channel.replace('__keyspace@0__:player:chunk:', '');
        callback(uuid, 'chunk_update');
      });
      
      logger.info('🔥 Redis keyspace notifications subscribed - REAL-TIME ACTIVATED');
    } catch (error) {
      logger.error('Failed to subscribe to keyspace events', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to subscribe to keyspace events');
    }
  }

  // ========== LISTES JOUEURS PAR ZONE ==========
  async addPlayerToZone(zoneType: 'region' | 'node' | 'city', zoneId: number, uuid: string): Promise<void> {
    const key = `zone:${zoneType}:${zoneId}:players`;
    const client = this.getClient();
    
    try {
      await client.sAdd(key, uuid);
      await client.expire(key, parseInt(process.env.CACHE_TTL_ZONES || '3600'));
    } catch (error) {
      logger.error('Failed to add player to zone', { 
        zoneType, 
        zoneId, 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to add player to zone');
    }
  }

  async removePlayerFromZone(zoneType: 'region' | 'node' | 'city', zoneId: number, uuid: string): Promise<void> {
    const key = `zone:${zoneType}:${zoneId}:players`;
    const client = this.getClient();
    
    try {
      await client.sRem(key, uuid);
    } catch (error) {
      logger.error('Failed to remove player from zone', { 
        zoneType, 
        zoneId, 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to remove player from zone');
    }
  }

  async getPlayersInZone(zoneType: 'region' | 'node' | 'city', zoneId: number): Promise<string[]> {
    const key = `zone:${zoneType}:${zoneId}:players`;
    const client = this.getClient();
    
    try {
      return await client.sMembers(key);
    } catch (error) {
      logger.error('Failed to get players in zone', { 
        zoneType, 
        zoneId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch players in zone');
    }
  }

  // ========== CACHE MÉTADONNÉES ZONES ==========
  async cacheZoneMetadata(zoneType: 'region' | 'node' | 'city', id: number, data: Record<string, any>): Promise<void> {
    const key = `zone:${zoneType}:${id}`;
    const client = this.getClient();
    
    try {
      const stringData: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        stringData[k] = v?.toString() || '';
      }

      await client.hSet(key, stringData);
      await client.expire(key, parseInt(process.env.CACHE_TTL_ZONES || '3600'));
    } catch (error) {
      logger.error('Failed to cache zone metadata', { 
        zoneType, 
        id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to cache zone metadata');
    }
  }

  async getZoneMetadata(zoneType: 'region' | 'node' | 'city', id: number): Promise<Record<string, string> | null> {
    const key = `zone:${zoneType}:${id}`;
    const client = this.getClient();
    
    try {
      const data = await client.hGetAll(key);
      return Object.keys(data).length > 0 ? data : null;
    } catch (error) {
      logger.error('Failed to get zone metadata', { 
        zoneType, 
        id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch zone metadata');
    }
  }

  async invalidateZoneCache(zoneType: 'region' | 'node' | 'city', id: number): Promise<void> {
    const client = this.getClient();
    
    try {
      const keys = [
        `zone:${zoneType}:${id}`,
        `zone:${zoneType}:${id}:players`
      ];
      
      await client.del(keys);
    } catch (error) {
      logger.error('Failed to invalidate zone cache', { 
        zoneType, 
        id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to invalidate zone cache');
    }
  }

  // ========== PUB/SUB ÉVÉNEMENTS ==========
  async publishZoneEvent(event: ZoneEvent): Promise<void> {
    const channel = `zone.${event.zoneType}.${event.eventType}`;
    const publisher = this.getPublisher();
    
    try {
      await publisher.publish(channel, JSON.stringify(event));
      await this.addEventToStream(event);
    } catch (error) {
      logger.error('Failed to publish zone event', { 
        event, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to publish zone event');
    }
  }

  async subscribeToZoneEvents(callback: (channel: string, message: string) => void): Promise<void> {
    const subscriber = this.getSubscriber();
    
    const channels = [
      'zone.region.enter', 'zone.region.leave',
      'zone.node.enter', 'zone.node.leave',
      'zone.city.enter', 'zone.city.leave'
    ];

    try {
      for (const channel of channels) {
        await subscriber.subscribe(channel, callback);
      }
      logger.info('Subscribed to zone events', { channelCount: channels.length });
    } catch (error) {
      logger.error('Failed to subscribe to zone events', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to subscribe to zone events');
    }
  }

  private async addEventToStream(event: ZoneEvent): Promise<void> {
    const client = this.getClient();
    
    try {
      await client.xAdd('events:zone', '*', {
        player_uuid: event.playerUuid,
        zone_type: event.zoneType,
        zone_id: event.zoneId.toString(),
        zone_name: event.zoneName,
        event_type: event.eventType,
        timestamp: event.timestamp.toString()
      });

      await client.xTrim('events:zone', 'MAXLEN', 10000, {
        strategyModifier: '~'
      });
    } catch (error) {
      logger.error('Failed to add event to stream', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      // Don't throw - stream failure shouldn't break event publishing
    }
  }

  // ========== BIDIRECTIONAL SYNC ==========
  async syncPlayersFromDatabase(players: Array<{
    player_uuid: string;
    x: number;
    y: number;
    z: number;
    chunk_x: number;
    chunk_z: number;
    last_updated: Date;
    region_id?: number;
    node_id?: number;
    city_id?: number;
  }>): Promise<number> {
    let syncedCount = 0;
    const batchSize = 100;
    
    try {
      for (let i = 0; i < players.length; i += batchSize) {
        const batch = players.slice(i, i + batchSize);
        const promises = batch.map(async (player) => {
          try {
            // Sync position
            await this.setPlayerPosition(player.player_uuid, {
              x: player.x,
              y: player.y,
              z: player.z,
              chunk_x: player.chunk_x,
              chunk_z: player.chunk_z,
              timestamp: player.last_updated.getTime()
            });

            // Sync zones if they exist
            if (player.region_id || player.node_id || player.city_id) {
              await this.setPlayerZones(player.player_uuid, {
                region_id: player.region_id,
                node_id: player.node_id,
                city_id: player.city_id,
                last_update: player.last_updated.getTime()
              });
            }

            syncedCount++;
          } catch (error) {
            logger.error('Failed to sync individual player', { 
              playerUuid: player.player_uuid, 
              error: error instanceof Error ? error.message : 'Unknown error' 
            });
          }
        });

        await Promise.allSettled(promises);
      }

      logger.info('Database to Redis sync completed', { 
        totalPlayers: players.length, 
        syncedCount 
      });
      
      return syncedCount;
    } catch (error) {
      logger.error('Failed to sync players from database', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to sync players from database');
    }
  }

  // ========== STATISTIQUES ==========
  async getStats(): Promise<{
    activePlayers: number;
    cachedChunks: number;
    memoryUsage: string;
    connectionStatus: string;
  }> {
    const client = this.getClient();
    
    try {
      const [playerKeys, chunkKeys, memoryInfo] = await Promise.all([
        client.keys('player:pos:*'),
        client.keys('chunk:zone:*'),
        client.info('memory')
      ]);

      return {
        activePlayers: playerKeys.length,
        cachedChunks: chunkKeys.length,
        memoryUsage: this.parseMemoryInfo(memoryInfo),
        connectionStatus: 'connected'
      };
    } catch (error) {
      logger.error('Failed to get Redis stats', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return {
        activePlayers: 0,
        cachedChunks: 0,
        memoryUsage: 'Unknown',
        connectionStatus: 'error'
      };
    }
  }

  private parseMemoryInfo(info: string): string {
    try {
      const lines = info.split('\r\n');
      const memoryLine = lines.find(line => line.startsWith('used_memory_human:'));
      return memoryLine ? memoryLine.split(':')[1] : 'Unknown';
    } catch (error) {
      return 'Unknown';
    }
  }

  // ========== NETTOYAGE ==========
  async cleanupExpiredData(): Promise<{
    deletedPlayers: number;
    deletedChunks: number;
  }> {
    const client = this.getClient();
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    
    let deletedPlayers = 0;
    let deletedZones = 0;
    
    try {
      // Clean expired player positions
      const playerKeys = await client.keys('player:pos:*');
      
      for (const key of playerKeys) {
        try {
          const timestamp = await client.hGet(key, 'timestamp');
          if (timestamp && (now - parseInt(timestamp)) > maxAge) {
            await client.del(key);
            deletedPlayers++;
          }
        } catch (error) {
          logger.debug('Error cleaning key', { key, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      }

      // Clean expired player zones
      const zoneKeys = await client.keys('player:zones:*');
      
      for (const key of zoneKeys) {
        try {
          const lastUpdate = await client.hGet(key, 'last_update');
          if (lastUpdate && (now - parseInt(lastUpdate)) > maxAge) {
            await client.del(key);
            deletedZones++;
          }
        } catch (error) {
          logger.debug('Error cleaning key', { key, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      }

      logger.info('Redis cleanup completed', { deletedPlayers, deletedZones });
      
      return {
        deletedPlayers,
        deletedChunks: deletedZones
      };
    } catch (error) {
      logger.error('Failed to cleanup expired data', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to cleanup expired data');
    }
  }

  // ========== SANTÉ ET MONITORING ==========
  async ping(): Promise<boolean> {
    try {
      const client = this.getClient();
      const result = await client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Redis ping failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // ========== NETTOYAGE À LA FERMETURE ==========
  async destroy(): Promise<void> {
    logger.info('Shutting down Redis service');
    
    try {
      if (this.client) {
        await this.client.quit();
        this.client = null;
      }
      if (this.publisher) {
        await this.publisher.quit();
        this.publisher = null;
      }
      if (this.subscriber) {
        await this.subscriber.quit();
        this.subscriber = null;
      }
      logger.info('Redis service shut down successfully');
    } catch (error) {
      logger.error('Error shutting down Redis service', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }
}