// src/services/RedisService.ts
import { createClient, RedisClientType } from 'redis';
import { RedisConfig } from '../config/redis';
import { ChunkZoneData } from '../models/Zone';
import { PlayerPosition, PlayerZones } from '../models/Player';
import { SecurityUtils } from '../utils/security';
import { logger } from '../utils/logger';

export class RedisService {
  private client: RedisClientType | null = null;
  private publisher: RedisClientType | null = null;
  private subscriber: RedisClientType | null = null;
  private keyspaceSubscriber: RedisClientType | null = null;

  // ========== INITIALIZATION ==========
  
  async init(): Promise<void> {
    try {
      logger.info('🔧 Initializing Redis service with multi-client architecture...');
      
      // Main client for general operations
      this.client = await RedisConfig.getClient();
      logger.info('✅ Redis main client connected');
      
      // Publisher for zone events
      this.publisher = await RedisConfig.getPublisher();
      logger.info('✅ Redis publisher connected');
      
      // Subscriber for zone events
      this.subscriber = await RedisConfig.getSubscriber();
      logger.info('✅ Redis subscriber connected');
      
      // Dedicated keyspace subscriber
      this.keyspaceSubscriber = createClient({
        url: process.env.REDIS_URL,
        password: process.env.REDIS_PASSWORD || undefined,
        database: parseInt(process.env.REDIS_DB || '0'),
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 1000)
        }
      });
      
      await this.keyspaceSubscriber.connect();
      logger.info('✅ Redis keyspace subscriber connected');
      
      // Configure keyspace notifications
      await this.setupKeyspaceNotifications();
      
      logger.info('🚀 Redis service fully initialized with 4 clients');
    } catch (error) {
      logger.error('❌ Failed to initialize Redis service', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }
  private async setupKeyspaceNotifications(): Promise<void> {
   try {
     if (!this.client) throw new Error('Redis client not initialized');
     
     // Enable keyspace notifications for hash operations (player positions)
     // K = keyspace events, h = hash commands, s = set commands
     await this.client.configSet('notify-keyspace-events', 'Khs');
     
     logger.info('✅ Redis keyspace notifications enabled (Khs)');
     
     // Verify configuration
     const config = await this.client.configGet('notify-keyspace-events');
     logger.info('📋 Keyspace events configuration verified:', { 
       config: Array.isArray(config) ? config[1] : config 
     });
     
   } catch (error) {
     logger.error('❌ Failed to setup keyspace notifications', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw error;
   }
 }

 // ========== CLIENT GETTERS ==========
 
 private getClient(): RedisClientType {
   if (!this.client) throw new Error('Redis main client not initialized');
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

 private getKeyspaceSubscriber(): RedisClientType {
   if (!this.keyspaceSubscriber) throw new Error('Redis keyspace subscriber not initialized');
   return this.keyspaceSubscriber;
 }

 // ========== BASIC REDIS OPERATIONS ==========
 
 async setex(key: string, seconds: number, value: string): Promise<void> {
   try {
     await this.getClient().setEx(key, seconds, value);
     logger.debug('✅ SETEX successful', { key, seconds });
   } catch (error) {
     logger.error('❌ SETEX failed', { 
       key, seconds, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to set key ${key} with expiration`);
   }
 }

 async get(key: string): Promise<string | null> {
   try {
     const result = await this.getClient().get(key);
     logger.debug('✅ GET successful', { key, hasValue: !!result });
     return result;
   } catch (error) {
     logger.error('❌ GET failed', { 
       key, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to get key ${key}`);
   }
 }

 async del(key: string | string[]): Promise<number> {
   try {
     const result = await this.getClient().del(key);
     logger.debug('✅ DEL successful', { 
       key: Array.isArray(key) ? `${key.length} keys` : key, 
       deleted: result 
     });
     return result;
   } catch (error) {
     logger.error('❌ DEL failed', { 
       key, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error('Unable to delete key(s)');
   }
 }

 async keys(pattern: string): Promise<string[]> {
   try {
     const result = await this.getClient().keys(pattern);
     logger.debug('✅ KEYS successful', { pattern, count: result.length });
     return result;
   } catch (error) {
     logger.error('❌ KEYS failed', { 
       pattern, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to get keys with pattern ${pattern}`);
   }
 }

 async hSet(key: string, field: string | Record<string, string>, value?: string): Promise<number> {
   try {
     let result: number;
     
     if (typeof field === 'string' && value !== undefined) {
       result = await this.getClient().hSet(key, field, value);
     } else if (typeof field === 'object' && field !== null) {
       result = await this.getClient().hSet(key, field);
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
     logger.error('❌ HSET failed', { 
       key, field, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to set hash field for key ${key}`);
   }
 }

 async hGet(key: string, field: string): Promise<string | undefined> {
   try {
     const result = await this.getClient().hGet(key, field);
     logger.debug('✅ HGET successful', { key, field, hasValue: !!result });
     return result;
   } catch (error) {
     logger.error('❌ HGET failed', { 
       key, field, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to get hash field ${field} from key ${key}`);
   }
 }

 async hGetAll(key: string): Promise<Record<string, string>> {
   try {
     const result = await this.getClient().hGetAll(key);
     logger.debug('✅ HGETALL successful', { 
       key, 
       fieldCount: Object.keys(result).length 
     });
     return result;
   } catch (error) {
     logger.error('❌ HGETALL failed', { 
       key, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to get hash for key ${key}`);
   }
 }

 async expire(key: string, seconds: number): Promise<boolean> {
   try {
     const result = await this.getClient().expire(key, seconds);
     logger.debug('✅ EXPIRE successful', { key, seconds, result });
     return result;
   } catch (error) {
     logger.error('❌ EXPIRE failed', { 
       key, seconds, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to set expiration for key ${key}`);
   }
 }

 // ========== CHUNK ZONE MANAGEMENT ==========
 
 async setChunkZone(chunkX: number, chunkZ: number, zoneData: ChunkZoneData): Promise<void> {
   if (!SecurityUtils.isValidChunkCoordinate(chunkX) || !SecurityUtils.isValidChunkCoordinate(chunkZ)) {
     throw new Error(`Invalid chunk coordinates: ${chunkX}, ${chunkZ}`);
   }

   const key = `chunk:zone:${chunkX}:${chunkZ}`;
   
   try {
     const data: Record<string, string> = {
       region_id: zoneData.regionId?.toString() || '',
       region_name: zoneData.regionName || '',
       node_id: zoneData.nodeId?.toString() || '',
       node_name: zoneData.nodeName || '',
       city_id: zoneData.cityId?.toString() || '',
       city_name: zoneData.cityName || '',
       cached_at: Date.now().toString()
     };

     await this.hSet(key, data);
     await this.expire(key, parseInt(process.env.CACHE_TTL_CHUNKS || '86400'));
     
     logger.debug('📦 Chunk zone cached', { 
       chunkX, chunkZ, 
       regionId: zoneData.regionId,
       nodeId: zoneData.nodeId,
       cityId: zoneData.cityId
     });
   } catch (error) {
     logger.error('❌ Failed to cache chunk zone', { 
       chunkX, chunkZ, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to cache zone for chunk ${chunkX},${chunkZ}`);
   }
 }

 async getChunkZone(chunkX: number, chunkZ: number): Promise<ChunkZoneData | null> {
   const key = `chunk:zone:${chunkX}:${chunkZ}`;
   
   try {
     const data = await this.hGetAll(key);
     
     if (Object.keys(data).length === 0) {
       logger.debug('🌿 Chunk zone not found (wilderness)', { chunkX, chunkZ });
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
     
     logger.debug('📦 Chunk zone retrieved', { 
       chunkX, chunkZ, 
       regionId: zoneData.regionId,
       nodeId: zoneData.nodeId,
       cityId: zoneData.cityId
     });
     
     return zoneData;
   } catch (error) {
     logger.error('❌ Failed to get chunk zone', { 
       chunkX, chunkZ, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return null; // Return null instead of throwing for read operations
   }
 }

 async deleteChunkZone(chunkX: number, chunkZ: number): Promise<void> {
   const key = `chunk:zone:${chunkX}:${chunkZ}`;
   
   try {
     await this.del(key);
     logger.debug('🗑️ Chunk zone deleted', { chunkX, chunkZ });
   } catch (error) {
     logger.error('❌ Failed to delete chunk zone', { 
       chunkX, chunkZ, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to delete zone for chunk ${chunkX},${chunkZ}`);
   }
 }

 async deleteChunkZonesByPattern(pattern: string): Promise<number> {
   if (!SecurityUtils.isValidRedisPattern(pattern)) {
     throw new Error(`Invalid Redis pattern: ${pattern}`);
   }
   
   try {
     const keys = await this.keys(pattern);
     if (keys.length === 0) {
       logger.debug('🗑️ No chunks to delete', { pattern });
       return 0;
     }
     
     // Process in batches to avoid Redis overload
     const batchSize = 1000;
     let deletedCount = 0;
     
     for (let i = 0; i < keys.length; i += batchSize) {
       const batch = keys.slice(i, i + batchSize);
       await this.del(batch);
       deletedCount += batch.length;
       
       logger.debug('🗑️ Chunk batch deleted', { 
         batchSize: batch.length,
         totalDeleted: deletedCount,
         remaining: keys.length - deletedCount
       });
     }
     
     logger.info('🗑️ Chunks deleted by pattern', { 
       pattern, 
       deletedCount,
       totalKeys: keys.length
     });
     
     return deletedCount;
   } catch (error) {
     logger.error('❌ Failed to delete chunks by pattern', { 
       pattern, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to delete chunks with pattern ${pattern}`);
   }
 }

 // ========== PLAYER POSITION MANAGEMENT ==========
 
 async setPlayerPosition(uuid: string, position: PlayerPosition): Promise<void> {
   if (!SecurityUtils.isValidUUID(uuid)) {
     throw new Error(`Invalid player UUID: ${uuid}`);
   }

   const key = `player:pos:${uuid}`;
   
   try {
     const data: Record<string, string> = {
       x: position.x.toString(),
       y: position.y.toString(),
       z: position.z.toString(),
       chunk_x: position.chunk_x.toString(),
       chunk_z: position.chunk_z.toString(),
       timestamp: position.timestamp.toString()
     };

     await this.hSet(key, data);
     await this.expire(key, parseInt(process.env.CACHE_TTL_PLAYERS || '3600'));
     
     logger.debug('📍 Player position updated', { 
       uuid: uuid.substring(0, 8) + '...',
       x: position.x,
       y: position.y,
       z: position.z,
       chunk: `${position.chunk_x},${position.chunk_z}`
     });
   } catch (error) {
     logger.error('❌ Failed to set player position', { 
       uuid: uuid.substring(0, 8) + '...',
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to save position for player ${uuid}`);
   }
 }

 async getPlayerPosition(uuid: string): Promise<PlayerPosition | null> {
   const key = `player:pos:${uuid}`;
   
   try {
     const data = await this.hGetAll(key);
     
     if (Object.keys(data).length === 0) {
       logger.debug('📍 Player position not found', { 
         uuid: uuid.substring(0, 8) + '...'
       });
       return null;
     }
     
     // Validate required fields
     const requiredFields = ['x', 'y', 'z', 'chunk_x', 'chunk_z', 'timestamp'];
     const missingFields = requiredFields.filter(field => !data[field]);
     
     if (missingFields.length > 0) {
       logger.warn('📍 Incomplete player position data', { 
         uuid: uuid.substring(0, 8) + '...',
         missingFields
       });
       return null;
     }
     
     const position: PlayerPosition = {
       x: parseFloat(data.x),
       y: parseFloat(data.y),
       z: parseFloat(data.z),
       chunk_x: parseInt(data.chunk_x),
       chunk_z: parseInt(data.chunk_z),
       timestamp: parseInt(data.timestamp)
     };
     
     logger.debug('📍 Player position retrieved', { 
       uuid: uuid.substring(0, 8) + '...',
       x: position.x,
       y: position.y,
       z: position.z,
       age: Date.now() - position.timestamp
     });
     
     return position;
   } catch (error) {
     logger.error('❌ Failed to get player position', { 
       uuid: uuid.substring(0, 8) + '...',
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return null; // Return null for read errors to avoid breaking sync
   }
 }

 async setPlayerChunk(uuid: string, chunkX: number, chunkZ: number): Promise<void> {
   if (!SecurityUtils.isValidUUID(uuid)) {
     throw new Error(`Invalid player UUID: ${uuid}`);
   }

   if (!SecurityUtils.isValidChunkCoordinate(chunkX) || !SecurityUtils.isValidChunkCoordinate(chunkZ)) {
     throw new Error(`Invalid chunk coordinates: ${chunkX}, ${chunkZ}`);
   }

   const key = `player:chunk:${uuid}`;
   
   try {
     const data: Record<string, string> = {
       chunk_x: chunkX.toString(),
       chunk_z: chunkZ.toString(),
       timestamp: Date.now().toString()
     };

     await this.hSet(key, data);
     await this.expire(key, parseInt(process.env.CACHE_TTL_PLAYERS || '3600'));
     
     logger.debug('📦 Player chunk updated', { 
       uuid: uuid.substring(0, 8) + '...',
       chunkX, chunkZ
     });
   } catch (error) {
     logger.error('❌ Failed to set player chunk', { 
       uuid: uuid.substring(0, 8) + '...',
       chunkX, chunkZ, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to save chunk for player ${uuid}`);
   }
 }

 async getPlayerChunk(uuid: string): Promise<{ chunk_x: number; chunk_z: number; timestamp: number } | null> {
   const key = `player:chunk:${uuid}`;
   
   try {
     const data = await this.hGetAll(key);
     
     if (Object.keys(data).length === 0) {
       logger.debug('📦 Player chunk not found', { 
         uuid: uuid.substring(0, 8) + '...'
       });
       return null;
     }

     // Validate required fields
     if (!data.chunk_x || !data.chunk_z || !data.timestamp) {
       logger.warn('📦 Incomplete player chunk data', { 
         uuid: uuid.substring(0, 8) + '...',
         data: Object.keys(data)
       });
       return null;
     }
     
     const chunk = {
       chunk_x: parseInt(data.chunk_x),
       chunk_z: parseInt(data.chunk_z),
       timestamp: parseInt(data.timestamp)
     };
     
     logger.debug('📦 Player chunk retrieved', { 
       uuid: uuid.substring(0, 8) + '...',
       chunk: `${chunk.chunk_x},${chunk.chunk_z}`,
       age: Date.now() - chunk.timestamp
     });
     
     return chunk;
   } catch (error) {
     logger.error('❌ Failed to get player chunk', { 
       uuid: uuid.substring(0, 8) + '...',
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return null;
   }
 }

 // ========== PLAYER ZONES MANAGEMENT ==========
 
 async setPlayerZones(uuid: string, zones: PlayerZones): Promise<void> {
   if (!SecurityUtils.isValidUUID(uuid)) {
     throw new Error(`Invalid player UUID: ${uuid}`);
   }

   const key = `player:zones:${uuid}`;
   
   try {
     const data: Record<string, string> = {
       last_update: zones.last_update.toString()
     };

     // Handle null values explicitly
     if (zones.region_id !== undefined && zones.region_id !== null) {
       data.region_id = zones.region_id.toString();
     }
     if (zones.node_id !== undefined && zones.node_id !== null) {
       data.node_id = zones.node_id.toString();
     }
     if (zones.city_id !== undefined && zones.city_id !== null) {
       data.city_id = zones.city_id.toString();
     }

     await this.hSet(key, data);
     await this.expire(key, parseInt(process.env.CACHE_TTL_PLAYERS || '3600'));
     
     logger.debug('🏘️ Player zones updated', { 
       uuid: uuid.substring(0, 8) + '...',
       regionId: zones.region_id,
       nodeId: zones.node_id,
       cityId: zones.city_id
     });
   } catch (error) {
     logger.error('❌ Failed to set player zones', { 
       uuid: uuid.substring(0, 8) + '...',
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to save zones for player ${uuid}`);
   }
 }

 async getPlayerZones(uuid: string): Promise<PlayerZones | null> {
   const key = `player:zones:${uuid}`;
   
   try {
     const data = await this.hGetAll(key);
     
     if (Object.keys(data).length === 0 || !data.last_update) {
       logger.debug('🏘️ Player zones not found', { 
         uuid: uuid.substring(0, 8) + '...'
       });
       return null;
     }
     
     const zones: PlayerZones = {
       region_id: data.region_id && data.region_id !== '' ? parseInt(data.region_id) : null,
       node_id: data.node_id && data.node_id !== '' ? parseInt(data.node_id) : null,
       city_id: data.city_id && data.city_id !== '' ? parseInt(data.city_id) : null,
       last_update: parseInt(data.last_update)
     };
     
     logger.debug('🏘️ Player zones retrieved', { 
       uuid: uuid.substring(0, 8) + '...',
       regionId: zones.region_id,
       nodeId: zones.node_id,
       cityId: zones.city_id,
       age: Date.now() - zones.last_update
     });
     
     return zones;
   } catch (error) {
     logger.error('❌ Failed to get player zones', { 
       uuid: uuid.substring(0, 8) + '...',
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return null;
   }
 }

 // ========== KEYSPACE NOTIFICATIONS ==========
 
 async subscribeToKeyspaceEvents(callback: (uuid: string, operation: string) => void): Promise<void> {
   try {
     const keyspaceSubscriber = this.getKeyspaceSubscriber();
     
     logger.info('🔧 Setting up keyspace event subscriptions...');
     
     // Subscribe to player position updates
     await keyspaceSubscriber.pSubscribe('__keyspace@0__:player:pos:*', (message, channel) => {
       try {
         const uuid = this.extractUuidFromChannel(channel, 'player:pos:');
         if (uuid) {
           logger.debug('📍 Position keyspace event', { 
             uuid: uuid.substring(0, 8) + '...',
             message, 
             channel 
           });
           callback(uuid, 'position_update');
         }
       } catch (error) {
         logger.error('❌ Error processing position keyspace event', { 
           channel, message, 
           error: error instanceof Error ? error.message : 'Unknown error' 
         });
       }
     });
     
     // Subscribe to player chunk updates
     await keyspaceSubscriber.pSubscribe('__keyspace@0__:player:chunk:*', (message, channel) => {
       try {
         const uuid = this.extractUuidFromChannel(channel, 'player:chunk:');
         if (uuid) {
           logger.debug('📦 Chunk keyspace event', { 
             uuid: uuid.substring(0, 8) + '...',
             message, 
             channel 
           });
           callback(uuid, 'chunk_update');
         }
       } catch (error) {
         logger.error('❌ Error processing chunk keyspace event', { 
           channel, message, 
           error: error instanceof Error ? error.message : 'Unknown error' 
         });
       }
     });
     
     logger.info('✅ Keyspace notifications subscribed successfully');
   } catch (error) {
     logger.error('❌ Failed to subscribe to keyspace events', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw error;
   }
 }

 private extractUuidFromChannel(channel: string, prefix: string): string | null {
   try {
     // Channel format: __keyspace@0__:player:pos:uuid
     const parts = channel.split(':');
     const prefixIndex = parts.findIndex(part => part === prefix.split(':')[1]);
     
     if (prefixIndex !== -1 && parts.length > prefixIndex + 2) {
       return parts.slice(prefixIndex + 2).join(':');
     }
     
     return null;
   } catch (error) {
     logger.error('❌ Failed to extract UUID from channel', { 
       channel, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return null;
   }
 }

 // ========== ZONE EVENT PUB/SUB ==========
 
 async publishZoneEvent(event: {
   playerUuid: string;
   zoneType: 'region' | 'node' | 'city';
   zoneId: number;
   zoneName: string;
   eventType: 'enter' | 'leave';
   timestamp: number;
 }): Promise<number> {
   try {
     const channel = 'zone_transitions';
     const message = JSON.stringify(event);

     logger.info('📡 Publishing zone event', {
       channel,
       playerUuid: event.playerUuid.substring(0, 8) + '...',
       event: `${event.zoneType}_${event.eventType}`,
       zoneName: event.zoneName,
       zoneId: event.zoneId,
       messageSize: message.length
     });

     const publisher = this.getPublisher();
     const subscriberCount = await publisher.publish(channel, message);
     
     logger.info('✅ Zone event published successfully', {
       channel,
       playerUuid: event.playerUuid.substring(0, 8) + '...',
       subscriberCount,
       messageSize: message.length
     });

     return subscriberCount;
   } catch (error) {
     logger.error('❌ Failed to publish zone event', {
       event: {
         ...event,
         playerUuid: event.playerUuid.substring(0, 8) + '...'
       },
       error: error instanceof Error ? error.message : 'Unknown error'
     });
     throw error;
   }
 }

 async subscribeToZoneEvents(callback: (channel: string, message: string) => void): Promise<void> {
   try {
     const subscriber = this.getSubscriber();
     const channel = 'zone_transitions';

     logger.info('🔧 Subscribing to zone events', { channel });

     await subscriber.subscribe(channel, (message, receivedChannel) => {
       logger.debug('📨 Zone event received', { 
         receivedChannel, 
         messageLength: message.length,
         messagePreview: message.substring(0, 100) + (message.length > 100 ? '...' : '')
       });
       
       callback(receivedChannel, message);
     });
     
     logger.info('✅ Subscribed to zone events successfully', { channel });
   } catch (error) {
     logger.error('❌ Failed to subscribe to zone events', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw error;
   }
 }

 // ========== PLAYER ZONE LISTS ==========
 
 async addPlayerToZone(zoneType: 'region' | 'node' | 'city', zoneId: number, uuid: string): Promise<void> {
   const key = `zone:${zoneType}:${zoneId}:players`;
   
   try {
     const client = this.getClient();
     await client.sAdd(key, uuid);
     await this.expire(key, parseInt(process.env.CACHE_TTL_ZONES || '3600'));
     
     logger.debug('➕ Player added to zone', { 
       zoneType, zoneId, 
       uuid: uuid.substring(0, 8) + '...'
     });
   } catch (error) {
     logger.error('❌ Failed to add player to zone', { 
       zoneType, zoneId, 
       uuid: uuid.substring(0, 8) + '...',
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to add player to ${zoneType} ${zoneId}`);
   }
 }

 async removePlayerFromZone(zoneType: 'region' | 'node' | 'city', zoneId: number, uuid: string): Promise<void> {
   const key = `zone:${zoneType}:${zoneId}:players`;
   
   try {
     const client = this.getClient();
     await client.sRem(key, uuid);
     
     logger.debug('➖ Player removed from zone', { 
       zoneType, zoneId, 
       uuid: uuid.substring(0, 8) + '...'
     });
   } catch (error) {
     logger.error('❌ Failed to remove player from zone', { 
       zoneType, zoneId, 
       uuid: uuid.substring(0, 8) + '...',
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error(`Unable to remove player from ${zoneType} ${zoneId}`);
   }
 }

 async getPlayersInZone(zoneType: 'region' | 'node' | 'city', zoneId: number): Promise<string[]> {
   const key = `zone:${zoneType}:${zoneId}:players`;
   
   try {
     const client = this.getClient();
     const players = await client.sMembers(key);
     
     logger.debug('👥 Players in zone retrieved', { 
       zoneType, zoneId, 
       playerCount: players.length
     });
     
     return players;
   } catch (error) {
     logger.error('❌ Failed to get players in zone', { 
       zoneType, zoneId, 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return []; // Return empty array instead of throwing for read operations
   }
 }

 // ========== STATISTICS ==========
 
 async getStats(): Promise<{
   activePlayers: number;
   cachedChunks: number;
   memoryUsage: string;
   connectionStatus: string;
   keyspaceEvents: string;
   clientsStatus: {
     main: boolean;
     publisher: boolean;
     subscriber: boolean;
     keyspaceSubscriber: boolean;
   };
 }> {
   try {
     const [playerKeys, chunkKeys, memoryInfo, keyspaceConfig] = await Promise.all([
       this.keys('player:pos:*').catch(() => []),
       this.keys('chunk:zone:*').catch(() => []),
       this.getClient().info('memory').catch(() => ''),
       this.getClient().configGet('notify-keyspace-events').catch(() => ['', 'disabled'])
     ]);

     // Check client health
     const clientsStatus = await this.getClientsHealth();

     return {
       activePlayers: playerKeys.length,
       cachedChunks: chunkKeys.length,
       memoryUsage: this.parseMemoryInfo(memoryInfo),
       connectionStatus: clientsStatus.main && clientsStatus.publisher && clientsStatus.subscriber && clientsStatus.keyspaceSubscriber ? 'connected' : 'partial',
       keyspaceEvents: Array.isArray(keyspaceConfig) ? keyspaceConfig[1] || 'disabled' : 'unknown',
       clientsStatus
     };
   } catch (error) {
     logger.error('❌ Failed to get Redis stats', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return {
       activePlayers: 0,
       cachedChunks: 0,
       memoryUsage: 'Unknown',
       connectionStatus: 'error',
       keyspaceEvents: 'unknown',
       clientsStatus: {
         main: false,
         publisher: false,
         subscriber: false,
         keyspaceSubscriber: false
       }
     };
   }
 }

 private async getClientsHealth(): Promise<{
   main: boolean;
   publisher: boolean;
   subscriber: boolean;
   keyspaceSubscriber: boolean;
 }> {
   try {
     const [mainPing, pubPing, subPing, keyspacePing] = await Promise.allSettled([
       this.client?.ping(),
       this.publisher?.ping(),
       this.subscriber?.ping(),
       this.keyspaceSubscriber?.ping()
     ]);

     return {
       main: mainPing.status === 'fulfilled' && mainPing.value === 'PONG',
       publisher: pubPing.status === 'fulfilled' && pubPing.value === 'PONG',
       subscriber: subPing.status === 'fulfilled' && subPing.value === 'PONG',
       keyspaceSubscriber: keyspacePing.status === 'fulfilled' && keyspacePing.value === 'PONG'
     };
   } catch (error) {
     logger.error('❌ Client health check failed', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return {
       main: false,
       publisher: false,
       subscriber: false,
       keyspaceSubscriber: false
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

 // ========== HEALTH CHECK ==========
 
 async isHealthy(): Promise<{
   main: boolean;
   publisher: boolean;
   subscriber: boolean;
   keyspaceSubscriber: boolean;
   overall: boolean;
 }> {
   const clientsHealth = await this.getClientsHealth();
   const overall = clientsHealth.main && clientsHealth.publisher && 
                  clientsHealth.subscriber && clientsHealth.keyspaceSubscriber;

   return {
     ...clientsHealth,
     overall
   };
 }

 async ping(): Promise<boolean> {
   try {
     const result = await this.getClient().ping();
     return result === 'PONG';
   } catch (error) {
     logger.error('❌ Redis ping failed', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     return false;
   }
 }

 // ========== CLEANUP ==========
 
 async cleanupExpiredData(): Promise<{
   deletedPlayers: number;
   deletedChunks: number;
 }> {
   const now = Date.now();
   const maxAge = 24 * 60 * 60 * 1000; // 24 hours
   
   let deletedPlayers = 0;
   let deletedZones = 0;
   
   try {
     logger.info('🧹 Starting Redis cleanup...');
     
     // Clean expired player positions
     const playerKeys = await this.keys('player:pos:*');
     
     for (const key of playerKeys) {
       try {
         const timestamp = await this.hGet(key, 'timestamp');
         if (timestamp && (now - parseInt(timestamp)) > maxAge) {
           await this.del(key);
           deletedPlayers++;
         }
       } catch (error) {
         logger.debug('Error cleaning player key', { 
           key, 
           error: error instanceof Error ? error.message : 'Unknown error' 
         });
       }
     }

     // Clean expired player zones
     const zoneKeys = await this.keys('player:zones:*');
     
     for (const key of zoneKeys) {
       try {
         const lastUpdate = await this.hGet(key, 'last_update');
         if (lastUpdate && (now - parseInt(lastUpdate)) > maxAge) {
           await this.del(key);
           deletedZones++;
         }
       } catch (error) {
         logger.debug('Error cleaning zone key', { 
           key, 
           error: error instanceof Error ? error.message : 'Unknown error' 
         });
       }
     }

     logger.info('✅ Redis cleanup completed', { 
       deletedPlayers, 
       deletedZones,
       totalCleaned: deletedPlayers + deletedZones
     });
     
     return {
       deletedPlayers,
       deletedChunks: deletedZones
     };
   } catch (error) {
     logger.error('❌ Redis cleanup failed', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error('Unable to cleanup expired data');
   }
 }

 // ========== BIDIRECTIONAL SYNC UTILITIES ==========
 
 async syncPlayersFromDatabase(players: Array<{
   player_uuid: string;
   server_uuid: string;
   x: number;
   y: number;
   z: number;
   chunk_x: number;
   chunk_z: number;
   last_updated: Date;
   region_id?: number | null;
   node_id?: number | null;
   city_id?: number | null;
 }>): Promise<number> {
   let syncedCount = 0;
   const batchSize = 100;
   
   try {
     logger.info('🔄 Starting database → Redis sync', { 
       totalPlayers: players.length 
     });
     
     for (let i = 0; i < players.length; i += batchSize) {
       const batch = players.slice(i, i + batchSize);
       
       const promises = batch.map(async (player) => {
         try {
           // Sync position using server_uuid (Redis keys use server_uuid)
           await this.setPlayerPosition(player.server_uuid, {
             x: player.x,
             y: player.y,
             z: player.z,
             chunk_x: player.chunk_x,
             chunk_z: player.chunk_z,
             timestamp: player.last_updated.getTime()
           });

           // Sync zones if they exist
           if (player.region_id !== null || player.node_id !== null || player.city_id !== null) {
             await this.setPlayerZones(player.server_uuid, {
               region_id: player.region_id,
               node_id: player.node_id,
               city_id: player.city_id,
               last_update: player.last_updated.getTime()
             });
           }

           return 1;
         } catch (error) {
           logger.error('❌ Failed to sync individual player', { 
             serverUuid: player.server_uuid.substring(0, 8) + '...',
             playerUuid: player.player_uuid.substring(0, 8) + '...',
             error: error instanceof Error ? error.message : 'Unknown error' 
           });
           return 0;
         }
       });

       const batchResults = await Promise.allSettled(promises);
       const batchSyncCount = batchResults
         .filter(result => result.status === 'fulfilled')
         .reduce((sum, result) => sum + (result as PromiseFulfilledResult<number>).value, 0);
       
       syncedCount += batchSyncCount;
       
       logger.debug('✅ Sync batch completed', {
         batchNumber: Math.floor(i / batchSize) + 1,
         batchSize: batch.length,
         batchSynced: batchSyncCount,
         totalSynced: syncedCount,
         remaining: players.length - (i + batchSize)
       });
     }

     logger.info('✅ Database → Redis sync completed', { 
       totalPlayers: players.length, 
       syncedCount,
       successRate: Math.round((syncedCount / players.length) * 100)
     });
     
     return syncedCount;
   } catch (error) {
     logger.error('❌ Failed to sync players from database', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     throw new Error('Unable to sync players from database');
   }
 }

 // ========== SHUTDOWN ==========
 
 async destroy(): Promise<void> {
   logger.info('🛑 Shutting down Redis service...');
   
   const shutdownPromises: Promise<void>[] = [];
   
   try {
     if (this.client) {
       shutdownPromises.push(this.client.quit().then(() => {
         this.client = null;
         logger.info('✅ Redis main client closed');
       }).catch((error) => {
         logger.warn('⚠️ Error closing main client', { error: error.message });
       }));
     }
     
     if (this.publisher) {
       shutdownPromises.push(this.publisher.quit().then(() => {
         this.publisher = null;
         logger.info('✅ Redis publisher closed');
       }).catch((error) => {
         logger.warn('⚠️ Error closing publisher', { error: error.message });
       }));
     }
     
     if (this.subscriber) {
       shutdownPromises.push(this.subscriber.quit().then(() => {
         this.subscriber = null;
         logger.info('✅ Redis subscriber closed');
       }).catch((error) => {
         logger.warn('⚠️ Error closing subscriber', { error: error.message });
       }));
     }
     
     if (this.keyspaceSubscriber) {
       shutdownPromises.push(this.keyspaceSubscriber.quit().then(() => {
         this.keyspaceSubscriber = null;
         logger.info('✅ Redis keyspace subscriber closed');
       }).catch((error) => {
         logger.warn('⚠️ Error closing keyspace subscriber', { error: error.message });
       }));
     }

     // Wait for all closures with timeout
     await Promise.race([
       Promise.all(shutdownPromises),
       new Promise(resolve => setTimeout(resolve, 5000)) // 5 second timeout
     ]);
     
     logger.info('✅ Redis service shutdown completed');
   } catch (error) {
     logger.error('❌ Error during Redis service shutdown', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
   }
 }
}