// src/services/RedisService.ts
import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
  chunk_x: number;
  chunk_z: number;
  timestamp: number;
}

export interface ChunkZoneData {
  regionId: number | null;
  regionName: string | null;
  nodeId: number | null;
  nodeName: string | null;
  cityId: number | null;
  cityName: string | null;
}

export interface ZoneTransitionEvent {
  playerUuid: string;
  previousChunk: { x: number; z: number } | null;
  currentChunk: { x: number; z: number };
  previousZones: ChunkZoneData | null;
  currentZones: ChunkZoneData | null;
  timestamp: number;
}

export class RedisService {
  private client: RedisClientType | null = null;
  private keyspaceSubscriber: RedisClientType | null = null;
  private publisher: RedisClientType | null = null;
  
  private zoneCache = new Map<string, ChunkZoneData>();
  private readonly ZONE_CACHE_TTL = 3600;
  private readonly REDIS_CONNECTION_TIMEOUT = 10000;

  // ========== INITIALIZATION ==========
  
  async init(): Promise<void> {
    try {
      logger.info('🔧 Initializing Redis service...');
      
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error('REDIS_URL environment variable is required');
      }

      const redisConfig = {
        url: redisUrl,
        socket: { 
          reconnectStrategy: (retries: number) => {
            const delay = Math.min(retries * 50, 5000);
            logger.warn(`Redis reconnection attempt ${retries}, waiting ${delay}ms`);
            return delay;
          },
          connectTimeout: this.REDIS_CONNECTION_TIMEOUT
        }
      };

      // Client principal
      this.client = createClient(redisConfig);
      this.client.on('error', (err) => logger.error('❌ Redis main client error:', { error: err.message }));
      this.client.on('ready', () => logger.info('✅ Redis main client ready'));
      await this.client.connect();
      
      // Publisher
      this.publisher = createClient(redisConfig);
      this.publisher.on('error', (err) => logger.error('❌ Redis publisher error:', { error: err.message }));
      await this.publisher.connect();
      logger.info('✅ Redis publisher connected');
      
      // Subscriber
      this.keyspaceSubscriber = createClient(redisConfig);
      this.keyspaceSubscriber.on('error', (err) => logger.error('❌ Redis keyspace subscriber error:', { error: err.message }));
      await this.keyspaceSubscriber.connect();
      logger.info('✅ Redis keyspace subscriber connected');
      
      // Configuration keyspace notifications
      await this.setupKeyspaceNotifications();
      
      logger.info('🚀 Redis service fully initialized');
    } catch (error) {
      logger.error('❌ Failed to initialize Redis service', { error });
      throw error;
    }
  }

  private async setupKeyspaceNotifications(): Promise<void> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      await this.client.configSet('notify-keyspace-events', 'KEh');
      
      const config = await this.client.configGet('notify-keyspace-events');
      logger.info('✅ Redis keyspace notifications configured', { config });
      
    } catch (error) {
      logger.error('❌ Failed to setup keyspace notifications', { error });
      logger.warn('⚠️ Continuing without keyspace notifications - WebSocket may not work');
    }
  }

  // ========== PLAYER POSITION MANAGEMENT ==========
  
  async getPlayerPosition(uuid: string): Promise<PlayerPosition | null> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      const data = await this.client.hGetAll(`player:pos:${uuid}`);
      
      if (Object.keys(data).length === 0) {
        return null;
      }
      
      return {
        x: parseFloat(data.x),
        y: parseFloat(data.y),
        z: parseFloat(data.z),
        chunk_x: parseInt(data.chunk_x),
        chunk_z: parseInt(data.chunk_z),
        timestamp: parseInt(data.timestamp)
      };
    } catch (error) {
      logger.error('❌ Failed to get player position', { uuid, error });
      return null;
    }
  }

  async getPlayerChunk(uuid: string): Promise<{ chunk_x: number; chunk_z: number } | null> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      const data = await this.client.hGetAll(`player:chunk:${uuid}`);
      
      if (!data.chunk_x || !data.chunk_z) {
        return null;
      }
      
      return {
        chunk_x: parseInt(data.chunk_x),
        chunk_z: parseInt(data.chunk_z)
      };
    } catch (error) {
      logger.error('❌ Failed to get player chunk', { uuid, error });
      return null;
    }
  }

  // ========== ZONE MANAGEMENT ==========
  
  async getChunkZone(chunkX: number, chunkZ: number): Promise<ChunkZoneData | null> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      const cacheKey = `${chunkX}:${chunkZ}`;
      
      if (this.zoneCache.has(cacheKey)) {
        return this.zoneCache.get(cacheKey)!;
      }
      
      const data = await this.client.hGetAll(`chunk:zone:${chunkX}:${chunkZ}`);
      
      if (Object.keys(data).length === 0) {
        return null;
      }
      
      const zoneData: ChunkZoneData = {
        regionId: data.region_id && data.region_id !== '' ? parseInt(data.region_id) : null,
        regionName: data.region_name && data.region_name !== '' ? data.region_name : null,
        nodeId: data.node_id && data.node_id !== '' ? parseInt(data.node_id) : null,
        nodeName: data.node_name && data.node_name !== '' ? data.node_name : null,
        cityId: data.city_id && data.city_id !== '' ? parseInt(data.city_id) : null,
        cityName: data.city_name && data.city_name !== '' ? data.city_name : null
      };
      
      this.zoneCache.set(cacheKey, zoneData);
      
      return zoneData;
    } catch (error) {
      logger.error('❌ Failed to get chunk zone', { chunkX, chunkZ, error });
      return null;
    }
  }

  async setChunkZone(chunkX: number, chunkZ: number, zoneData: ChunkZoneData): Promise<void> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      const data: Record<string, string> = {
        region_id: zoneData.regionId?.toString() || '',
        region_name: zoneData.regionName || '',
        node_id: zoneData.nodeId?.toString() || '',
        node_name: zoneData.nodeName || '',
        city_id: zoneData.cityId?.toString() || '',
        city_name: zoneData.cityName || ''
      };

      await this.client.hSet(`chunk:zone:${chunkX}:${chunkZ}`, data);
      await this.client.expire(`chunk:zone:${chunkX}:${chunkZ}`, this.ZONE_CACHE_TTL);
      
      this.zoneCache.set(`${chunkX}:${chunkZ}`, zoneData);
      
    } catch (error) {
      logger.error('❌ Failed to set chunk zone', { chunkX, chunkZ, error });
      throw error;
    }
  }

  // ========== KEYSPACE NOTIFICATIONS ==========
  
  async subscribeToPlayerMovements(callback: (event: ZoneTransitionEvent) => void): Promise<void> {
    try {
      if (!this.keyspaceSubscriber) throw new Error('Keyspace subscriber not initialized');
      
      logger.info('🔧 Setting up player movement subscriptions...');
      
      await this.keyspaceSubscriber.pSubscribe('__keyspace@0__:player:chunk:*', async (message, channel) => {
        try {
          await this.handlePlayerKeyspaceEvent(message, channel, callback);
        } catch (error) {
          logger.error('❌ Error handling chunk keyspace event', { channel, message, error });
        }
      });

      await this.keyspaceSubscriber.pSubscribe('__keyspace@0__:player:pos:*', async (message, channel) => {
        try {
          await this.handlePlayerKeyspaceEvent(message, channel, callback);
        } catch (error) {
          logger.error('❌ Error handling position keyspace event', { channel, message, error });
        }
      });
      
      logger.info('✅ Player movement subscriptions active');
      
    } catch (error) {
      logger.error('❌ Failed to subscribe to player movements', { error });
      throw error;
    }
  }

  async setPlayerPreviousZones(uuid: string, zones: ChunkZoneData | null): Promise<void> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      const key = `player:prev_zones:${uuid}`;
      
      if (zones) {
        await this.client.setEx(key, 3600, JSON.stringify(zones));
      } else {
        await this.client.del(key);
      }
      
    } catch (error) {
      logger.error('❌ Failed to set player previous zones', { uuid, error });
    }
  }

  async getPlayerPreviousZones(uuid: string): Promise<ChunkZoneData | null> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      const data = await this.client.get(`player:prev_zones:${uuid}`);
      
      if (!data) return null;
      
      return JSON.parse(data);
      
    } catch (error) {
      logger.error('❌ Failed to get player previous zones', { uuid, error });
      return null;
    }
  }

  private async handlePlayerKeyspaceEvent(
    message: string, 
    channel: string, 
    callback: (event: ZoneTransitionEvent) => void
  ): Promise<void> {
    
    const match = channel.match(/__keyspace@0__:player:(pos|chunk):(.+)/);
    if (!match) return;
    
    const [, type, uuid] = match;
    
    if (message !== 'hset') return;
    
    logger.debug('🎯 Player movement detected', { 
      uuid: uuid.substring(0, 8) + '...',
      type, 
      operation: message 
    });
    
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const [currentChunk, currentPosition] = await Promise.all([
        this.getPlayerChunk(uuid),
        this.getPlayerPosition(uuid)
      ]);
      
      if (!currentChunk) {
        logger.debug('No current chunk found for player', { uuid: uuid.substring(0, 8) + '...' });
        return;
      }
      
      const previousZones = await this.getPlayerPreviousZones(uuid);
      const currentZones = await this.getChunkZone(currentChunk.chunk_x, currentChunk.chunk_z);
      
      const hasZoneChange = this.hasZoneChanged(previousZones, currentZones);
      
      if (!hasZoneChange) {
        logger.debug('No zone change detected', {
          uuid: uuid.substring(0, 8) + '...',
          chunk: `${currentChunk.chunk_x},${currentChunk.chunk_z}`
        });
        return;
      }
      
      const transitionEvent: ZoneTransitionEvent = {
        playerUuid: uuid,
        previousChunk: previousZones ? {
          x: Math.floor((currentPosition?.x || 0) / 16),
          z: Math.floor((currentPosition?.z || 0) / 16)
        } : null,
        currentChunk: { x: currentChunk.chunk_x, z: currentChunk.chunk_z },
        previousZones,
        currentZones,
        timestamp: Date.now()
      };
      
      logger.info('🎉 Zone transition detected', {
        uuid: uuid.substring(0, 8) + '...',
        transition: this.formatTransitionForLog(transitionEvent)
      });
      
      callback(transitionEvent);
      
      await this.setPlayerPreviousZones(uuid, currentZones);
      
    } catch (error) {
      logger.error('❌ Failed to process movement event', { 
        uuid: uuid.substring(0, 8) + '...',
        error 
      });
    }
  }

  private hasZoneChanged(previous: ChunkZoneData | null, current: ChunkZoneData | null): boolean {
    if ((previous === null) !== (current === null)) return true;
    if (!previous && !current) return false;
    
    return previous!.regionId !== current!.regionId ||
           previous!.nodeId !== current!.nodeId ||
           previous!.cityId !== current!.cityId;
  }

  private formatTransitionForLog(event: ZoneTransitionEvent): string {
    const prev = this.formatZonesForLog(event.previousZones);
    const curr = this.formatZonesForLog(event.currentZones);
    return `${prev} → ${curr} @ chunk(${event.currentChunk.x},${event.currentChunk.z})`;
  }

  private formatZonesForLog(zones: ChunkZoneData | null): string {
    if (!zones) return 'wilderness';
    
    const parts: string[] = [];
    if (zones.regionId) parts.push(`R${zones.regionId}(${zones.regionName})`);
    if (zones.nodeId) parts.push(`N${zones.nodeId}(${zones.nodeName})`);
    if (zones.cityId) parts.push(`C${zones.cityId}(${zones.cityName})`);
    
    return parts.length > 0 ? parts.join(',') : 'wilderness';
  }

  // ========== BATCH OPERATIONS ==========
  
  async getAllPlayerPositions(): Promise<Map<string, PlayerPosition>> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      const positions = new Map<string, PlayerPosition>();
      const keys = await this.client.keys('player:pos:*');
      
      if (keys.length === 0) {
        return positions;
      }
      
      const batchSize = 50;
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (key) => {
          const uuid = key.replace('player:pos:', '');
          const position = await this.getPlayerPosition(uuid);
          return { uuid, position };
        });
        
        const results = await Promise.allSettled(batchPromises);
        
        results.forEach((result) => {
          if (result.status === 'fulfilled' && result.value.position) {
            positions.set(result.value.uuid, result.value.position);
          }
        });
      }
      
      logger.info('📋 Loaded player positions from Redis', { count: positions.size });
      return positions;
      
    } catch (error) {
      logger.error('❌ Failed to get all player positions', { error });
      return new Map();
    }
  }

  // ========== BASIC REDIS OPERATIONS ==========

  async keys(pattern: string): Promise<string[]> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      return await this.client.keys(pattern);
    } catch (error) {
      logger.error('❌ KEYS failed', { pattern, error });
      throw new Error(`Unable to get keys with pattern ${pattern}`);
    }
  }

  async del(key: string | string[]): Promise<number> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      return await this.client.del(key);
    } catch (error) {
      logger.error('❌ DEL failed', { key, error });
      throw new Error('Unable to delete key(s)');
    }
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      return await this.client.hGetAll(key);
    } catch (error) {
      logger.error('❌ HGETALL failed', { key, error });
      throw new Error(`Unable to get hash for key ${key}`);
    }
  }

  async hSet(key: string, field: string | Record<string, string>, value?: string): Promise<number> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      if (typeof field === 'string' && value !== undefined) {
        return await this.client.hSet(key, field, value);
      } else if (typeof field === 'object' && field !== null) {
        return await this.client.hSet(key, field);
      } else {
        throw new Error('Invalid hSet parameters');
      }
    } catch (error) {
      logger.error('❌ HSET failed', { key, field, error });
      throw new Error(`Unable to set hash field for key ${key}`);
    }
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      return await this.client.expire(key, seconds);
    } catch (error) {
      logger.error('❌ EXPIRE failed', { key, seconds, error });
      throw new Error(`Unable to set expiration for key ${key}`);
    }
  }

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      await this.client.setEx(key, seconds, value);
    } catch (error) {
      logger.error('❌ SETEX failed', { key, seconds, error });
      throw new Error(`Unable to set key ${key} with expiration`);
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      return await this.client.get(key);
    } catch (error) {
      logger.error('❌ GET failed', { key, error });
      throw new Error(`Unable to get key ${key}`);
    }
  }

  // ========== UTILITIES ==========
  
  async ping(): Promise<boolean> {
    try {
      if (!this.client) return false;
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  async getStats(): Promise<{
    connectedClients: boolean;
    cachedPositions: number;
    cachedZones: number;
    localZoneCache: number;
  }> {
    try {
      const [positionKeys, zoneKeys] = await Promise.all([
        this.keys('player:pos:*').catch(() => []),
        this.keys('chunk:zone:*').catch(() => [])
      ]);
      
      return {
        connectedClients: await this.ping(),
        cachedPositions: positionKeys.length,
        cachedZones: zoneKeys.length,
        localZoneCache: this.zoneCache.size
      };
    } catch (error) {
      logger.error('❌ Failed to get Redis stats', { error });
      return {
        connectedClients: false,
        cachedPositions: 0,
        cachedZones: 0,
        localZoneCache: this.zoneCache.size
      };
    }
  }

  // ========== CLEANUP ==========
  
  async destroy(): Promise<void> {
    try {
      logger.info('🛑 Shutting down Redis service...');
      
      const promises: Promise<void>[] = [];
      
      if (this.client) {
        promises.push(this.client.quit().then(() => { this.client = null; }));
      }
      if (this.publisher) {
        promises.push(this.publisher.quit().then(() => { this.publisher = null; }));
      }
      if (this.keyspaceSubscriber) {
        promises.push(this.keyspaceSubscriber.quit().then(() => { this.keyspaceSubscriber = null; }));
      }
      
      await Promise.allSettled(promises);
      
      this.zoneCache.clear();
      
      logger.info('✅ Redis service shutdown completed');
    } catch (error) {
      logger.error('❌ Error during Redis shutdown', { error });
    }
  }
}