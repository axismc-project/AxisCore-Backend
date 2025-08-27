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
  
  // Cache des zones pour optimisation
  private zoneCache = new Map<string, ChunkZoneData>();
  private readonly ZONE_CACHE_TTL = 3600; // 1 heure

  // ========== INITIALIZATION ==========
  
  async init(): Promise<void> {
    try {
      logger.info('🔧 Initializing Redis service...');
      
      // Client principal
      this.client = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 1000) }
      });
      await this.client.connect();
      logger.info('✅ Redis main client connected');
      
      // Publisher pour WebSocket
      this.publisher = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 1000) }
      });
      await this.publisher.connect();
      logger.info('✅ Redis publisher connected');
      
      // Subscriber pour keyspace notifications
      this.keyspaceSubscriber = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: (retries) => Math.min(retries * 50, 1000) }
      });
      await this.keyspaceSubscriber.connect();
      logger.info('✅ Redis keyspace subscriber connected');
      
      // Configuration keyspace notifications optimisée
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
    
    // ✅ FIX: Configuration correcte pour capturer HSET (hash commands)
    await this.client.configSet('notify-keyspace-events', 'KEh');
    // K = keyspace events, E = keyevent events, h = hash commands
    
    const config = await this.client.configGet('notify-keyspace-events');
    logger.info('✅ Redis keyspace notifications configured', { config });
    
  } catch (error) {
    logger.error('❌ Failed to setup keyspace notifications', { error });
    throw error;
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
      
      // Vérifier le cache local d'abord
      if (this.zoneCache.has(cacheKey)) {
        return this.zoneCache.get(cacheKey)!;
      }
      
      // Chercher dans Redis
      const data = await this.client.hGetAll(`chunk:zone:${chunkX}:${chunkZ}`);
      
      if (Object.keys(data).length === 0) {
        return null; // Wilderness
      }
      
      const zoneData: ChunkZoneData = {
        regionId: data.region_id ? parseInt(data.region_id) : null,
        regionName: data.region_name || null,
        nodeId: data.node_id ? parseInt(data.node_id) : null,
        nodeName: data.node_name || null,
        cityId: data.city_id ? parseInt(data.city_id) : null,
        cityName: data.city_name || null
      };
      
      // Cache local
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
      
      // Cache local
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
    
    // ✅ FIX: Pattern correct pour capturer les événements chunk
    await this.keyspaceSubscriber.pSubscribe('__keyspace@0__:player:chunk:*', async (message, channel) => {
      try {
        await this.handlePlayerKeyspaceEvent(message, channel, callback);
      } catch (error) {
        logger.error('❌ Error handling keyspace event', { channel, message, error });
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
      await this.client.setEx(key, 3600, JSON.stringify(zones)); // 1 heure TTL
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

// Remplacer la méthode handlePlayerKeyspaceEvent dans RedisService.ts

private async handlePlayerKeyspaceEvent(
  message: string, 
  channel: string, 
  callback: (event: ZoneTransitionEvent) => void
): Promise<void> {
  
  // Extraire UUID du channel
  const match = channel.match(/__keyspace@0__:player:(pos|chunk):(.+)/);
  if (!match) return;
  
  const [, type, uuid] = match;
  
  // Traiter les événements chunk et pos
  if (type !== 'chunk' && type !== 'pos') return;
  
  logger.debug('🎯 Player movement detected', { 
    uuid: uuid.substring(0, 8) + '...',
    type, 
    operation: message 
  });
  
  try {
    // Délai pour s'assurer que les données sont écrites
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const [currentChunk, currentPosition] = await Promise.all([
      this.getPlayerChunk(uuid),
      this.getPlayerPosition(uuid)
    ]);
    
    if (!currentChunk) return;
    
    // Récupérer les zones précédentes
    const previousZones = await this.getPlayerPreviousZones(uuid);
    
    // Récupérer les zones actuelles
    const currentZones = await this.getChunkZone(currentChunk.chunk_x, currentChunk.chunk_z);
    
    // Créer l'événement de transition
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
    
    // Appeler le callback
    callback(transitionEvent);
    
    // Sauvegarder les zones actuelles comme précédentes
    await this.setPlayerPreviousZones(uuid, currentZones);
    
  } catch (error) {
    logger.error('❌ Failed to process movement event', { 
      uuid: uuid.substring(0, 8) + '...',
     error 
   });
 }
}

  // ========== WEBSOCKET EVENTS ==========
  
  async publishZoneEvent(event: {
    playerUuid: string;
    action: 'enter' | 'leave';
    zoneType: 'region' | 'node' | 'city';
    zoneId: number;
    zoneName: string;
    timestamp: number;
  }): Promise<void> {
    try {
      if (!this.publisher) throw new Error('Publisher not initialized');
      
      const message = JSON.stringify(event);
      await this.publisher.publish('zone_events', message);
      
      logger.info('📡 Zone event published', {
        playerUuid: event.playerUuid.substring(0, 8) + '...',
        action: event.action,
        zone: `${event.zoneType}:${event.zoneId}`
      });
      
    } catch (error) {
      logger.error('❌ Failed to publish zone event', { event, error });
    }
  }

  async subscribeToZoneEvents(callback: (event: any) => void): Promise<void> {
    try {
      if (!this.keyspaceSubscriber) throw new Error('Keyspace subscriber not initialized');
      
      await this.keyspaceSubscriber.subscribe('zone_events', (message) => {
        try {
          const event = JSON.parse(message);
          callback(event);
        } catch (error) {
          logger.error('❌ Invalid zone event message', { message, error });
        }
      });
      
      logger.info('✅ Subscribed to zone events');
      
    } catch (error) {
      logger.error('❌ Failed to subscribe to zone events', { error });
      throw error;
    }
  }

  // ========== BATCH OPERATIONS ==========
  
  async getAllPlayerPositions(): Promise<Map<string, PlayerPosition>> {
    try {
      if (!this.client) throw new Error('Redis client not initialized');
      
      const positions = new Map<string, PlayerPosition>();
      const keys = await this.client.keys('player:pos:*');
      
      for (const key of keys) {
        const uuid = key.replace('player:pos:', '');
        const position = await this.getPlayerPosition(uuid);
        if (position) {
          positions.set(uuid, position);
        }
      }
      
      logger.info('📋 Loaded player positions from Redis', { count: positions.size });
      return positions;
      
    } catch (error) {
      logger.error('❌ Failed to get all player positions', { error });
      return new Map();
    }
  }

  // src/services/RedisService.ts - AJOUTER ces méthodes à la fin de la classe

// ========== MÉTHODES MANQUANTES POUR ZONELOADERSERVICE ==========

async keys(pattern: string): Promise<string[]> {
  try {
    if (!this.client) throw new Error('Redis client not initialized');
    
    const result = await this.client.keys(pattern);
    logger.debug('✅ KEYS successful', { pattern, count: result.length });
    return result;
  } catch (error) {
    logger.error('❌ KEYS failed', { pattern, error });
    throw new Error(`Unable to get keys with pattern ${pattern}`);
  }
}

async del(key: string | string[]): Promise<number> {
  try {
    if (!this.client) throw new Error('Redis client not initialized');
    
    const result = await this.client.del(key);
    logger.debug('✅ DEL successful', { 
      key: Array.isArray(key) ? `${key.length} keys` : key, 
      deleted: result 
    });
    return result;
  } catch (error) {
    logger.error('❌ DEL failed', { key, error });
    throw new Error('Unable to delete key(s)');
  }
}

async hGetAll(key: string): Promise<Record<string, string>> {
  try {
    if (!this.client) throw new Error('Redis client not initialized');
    
    const result = await this.client.hGetAll(key);
    logger.debug('✅ HGETALL successful', { 
      key, 
      fieldCount: Object.keys(result).length 
    });
    return result;
  } catch (error) {
    logger.error('❌ HGETALL failed', { key, error });
    throw new Error(`Unable to get hash for key ${key}`);
  }
}

async hSet(key: string, field: string | Record<string, string>, value?: string): Promise<number> {
  try {
    if (!this.client) throw new Error('Redis client not initialized');
    
    let result: number;
    
    if (typeof field === 'string' && value !== undefined) {
      result = await this.client.hSet(key, field, value);
    } else if (typeof field === 'object' && field !== null) {
      result = await this.client.hSet(key, field);
    } else {
      throw new Error('Invalid hSet parameters');
    }
    
    logger.debug('✅ HSET successful', { 
      key, 
      fieldCount: typeof field === 'object' ? Object.keys(field).length : 1,
      result 
    });
    
    return result;
  } catch (error) {
    logger.error('❌ HSET failed', { key, field, error });
    throw new Error(`Unable to set hash field for key ${key}`);
  }
}

async expire(key: string, seconds: number): Promise<boolean> {
  try {
    if (!this.client) throw new Error('Redis client not initialized');
    
    const result = await this.client.expire(key, seconds);
    logger.debug('✅ EXPIRE successful', { key, seconds, result });
    return result;
  } catch (error) {
    logger.error('❌ EXPIRE failed', { key, seconds, error });
    throw new Error(`Unable to set expiration for key ${key}`);
  }
}

async setEx(key: string, seconds: number, value: string): Promise<void> {
  try {
    if (!this.client) throw new Error('Redis client not initialized');
    
    await this.client.setEx(key, seconds, value);
    logger.debug('✅ SETEX successful', { key, seconds });
  } catch (error) {
    logger.error('❌ SETEX failed', { key, seconds, error });
    throw new Error(`Unable to set key ${key} with expiration`);
  }
}

async get(key: string): Promise<string | null> {
  try {
    if (!this.client) throw new Error('Redis client not initialized');
    
    const result = await this.client.get(key);
    logger.debug('✅ GET successful', { key, hasValue: !!result });
    return result;
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
      if (!this.client) throw new Error('Redis client not initialized');
      
      const [positionKeys, zoneKeys] = await Promise.all([
        this.client.keys('player:pos:*'),
        this.client.keys('chunk:zone:*')
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
      
      await Promise.all(promises);
      
      this.zoneCache.clear();
      
      logger.info('✅ Redis service shutdown completed');
    } catch (error) {
      logger.error('❌ Error during Redis shutdown', { error });
    }
  }
}
