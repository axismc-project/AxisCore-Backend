import { RedisClientType } from 'redis';
import { RedisConfig } from '../config/redis';
import { ChunkZoneData, ZoneEvent } from '../models/Zone';
import { PlayerPosition, PlayerZones } from '../models/Player';
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
      logger.info('RedisService initialisé');
    } catch (error) {
      logger.error('Erreur initialisation RedisService:', error);
      throw error;
    }
  }

  private getClient(): RedisClientType {
    if (!this.client) throw new Error('Redis client non initialisé');
    return this.client;
  }

  private getPublisher(): RedisClientType {
    if (!this.publisher) throw new Error('Redis publisher non initialisé');
    return this.publisher;
  }

  private getSubscriber(): RedisClientType {
    if (!this.subscriber) throw new Error('Redis subscriber non initialisé');
    return this.subscriber;
  }

  // ========== GESTION CHUNKS ==========
  async setChunkZone(chunkX: number, chunkZ: number, zoneData: ChunkZoneData): Promise<void> {
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
      logger.error(`Erreur setChunkZone ${chunkX},${chunkZ}:`, error);
      throw new Error('Impossible de sauvegarder la zone du chunk');
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
      logger.error(`Erreur getChunkZone ${chunkX},${chunkZ}:`, error);
      throw new Error('Impossible de récupérer la zone du chunk');
    }
  }

  async deleteChunkZone(chunkX: number, chunkZ: number): Promise<void> {
    const key = `chunk:zone:${chunkX}:${chunkZ}`;
    const client = this.getClient();
    
    try {
      await client.del(key);
    } catch (error) {
      logger.error(`Erreur deleteChunkZone ${chunkX},${chunkZ}:`, error);
      throw new Error('Impossible de supprimer la zone du chunk');
    }
  }

  async deleteChunkZonesByPattern(pattern: string): Promise<number> {
    const client = this.getClient();
    
    try {
      const keys = await client.keys(pattern);
      if (keys.length === 0) return 0;
      
      // Traiter par batch pour éviter de surcharger Redis
      const batchSize = 1000;
      let deletedCount = 0;
      
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        await client.del(batch);
        deletedCount += batch.length;
      }
      
      return deletedCount;
    } catch (error) {
      logger.error(`Erreur deleteChunkZonesByPattern ${pattern}:`, error);
      throw new Error('Impossible de supprimer les zones par pattern');
    }
  }

  // ========== POSITIONS JOUEURS ==========
  async setPlayerPosition(uuid: string, position: PlayerPosition): Promise<void> {
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
      logger.error(`Erreur setPlayerPosition ${uuid}:`, error);
      throw new Error('Impossible de sauvegarder la position du joueur');
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
      logger.error(`Erreur getPlayerPosition ${uuid}:`, error);
      throw new Error('Impossible de récupérer la position du joueur');
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
      logger.error(`Erreur setPlayerZones ${uuid}:`, error);
      throw new Error('Impossible de sauvegarder les zones du joueur');
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
      logger.error(`Erreur getPlayerZones ${uuid}:`, error);
      throw new Error('Impossible de récupérer les zones du joueur');
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
      logger.error(`Erreur addPlayerToZone ${zoneType}:${zoneId}:`, error);
      throw new Error('Impossible d\'ajouter le joueur à la zone');
    }
  }

  async removePlayerFromZone(zoneType: 'region' | 'node' | 'city', zoneId: number, uuid: string): Promise<void> {
    const key = `zone:${zoneType}:${zoneId}:players`;
    const client = this.getClient();
    
    try {
      await client.sRem(key, uuid);
    } catch (error) {
      logger.error(`Erreur removePlayerFromZone ${zoneType}:${zoneId}:`, error);
      throw new Error('Impossible de retirer le joueur de la zone');
    }
  }

  async getPlayersInZone(zoneType: 'region' | 'node' | 'city', zoneId: number): Promise<string[]> {
    const key = `zone:${zoneType}:${zoneId}:players`;
    const client = this.getClient();
    
    try {
      return await client.sMembers(key);
    } catch (error) {
      logger.error(`Erreur getPlayersInZone ${zoneType}:${zoneId}:`, error);
      throw new Error('Impossible de récupérer les joueurs de la zone');
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
      logger.error(`Erreur cacheZoneMetadata ${zoneType}:${id}:`, error);
      throw new Error('Impossible de mettre en cache les métadonnées de la zone');
    }
  }

  async getZoneMetadata(zoneType: 'region' | 'node' | 'city', id: number): Promise<Record<string, string> | null> {
    const key = `zone:${zoneType}:${id}`;
    const client = this.getClient();
    
    try {
      const data = await client.hGetAll(key);
      return Object.keys(data).length > 0 ? data : null;
    } catch (error) {
      logger.error(`Erreur getZoneMetadata ${zoneType}:${id}:`, error);
      throw new Error('Impossible de récupérer les métadonnées de la zone');
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
      logger.error(`Erreur invalidateZoneCache ${zoneType}:${id}:`, error);
      throw new Error('Impossible d\'invalider le cache de la zone');
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
      logger.error('Erreur publishZoneEvent:', error);
      throw new Error('Impossible de publier l\'événement de zone');
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
      logger.info(`Abonné aux ${channels.length} canaux de zones`);
    } catch (error) {
      logger.error('Erreur subscribeToZoneEvents:', error);
      throw new Error('Impossible de s\'abonner aux événements de zones');
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

      // Correction: utiliser la syntaxe correcte pour xTrim
      await client.xTrim('events:zone', 'MAXLEN', 10000, {
        strategyModifier: '~'
      });
    } catch (error) {
      logger.error('Erreur addEventToStream:', error);
      // Ne pas faire échouer la publication pour une erreur de stream
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
      logger.error('Erreur getStats:', error);
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
    const maxAge = 24 * 60 * 60 * 1000; // 24 heures
    
    let deletedPlayers = 0;
    let deletedZones = 0;
    
    try {
      // Nettoyer les positions de joueurs expirées
      const playerKeys = await client.keys('player:pos:*');
      
      for (const key of playerKeys) {
        try {
          const timestamp = await client.hGet(key, 'timestamp');
          if (timestamp && (now - parseInt(timestamp)) > maxAge) {
            await client.del(key);
            deletedPlayers++;
          }
        } catch (error) {
          logger.debug(`Erreur nettoyage clé ${key}:`, error);
        }
      }

      // Nettoyer les zones de joueurs expirées
      const zoneKeys = await client.keys('player:zones:*');
      
      for (const key of zoneKeys) {
        try {
          const lastUpdate = await client.hGet(key, 'last_update');
          if (lastUpdate && (now - parseInt(lastUpdate)) > maxAge) {
            await client.del(key);
            deletedZones++;
          }
        } catch (error) {
          logger.debug(`Erreur nettoyage clé ${key}:`, error);
        }
      }

      logger.info(`Nettoyage terminé: ${deletedPlayers} joueurs, ${deletedZones} zones supprimées`);
      
      return {
        deletedPlayers,
        deletedChunks: deletedZones
      };
    } catch (error) {
      logger.error('Erreur cleanupExpiredData:', error);
      throw new Error('Impossible de nettoyer les données expirées');
    }
  }

  // ========== SANTÉ ET MONITORING ==========
  async ping(): Promise<boolean> {
    try {
      const client = this.getClient();
      const result = await client.ping();
      return result === 'PONG';
    } catch (error) {
      logger.error('Erreur ping Redis:', error);
      return false;
    }
  }

  // ========== NETTOYAGE À LA FERMETURE ==========
  async destroy(): Promise<void> {
    logger.info('🛑 Fermeture RedisService...');
    
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
      logger.info('✅ RedisService fermé');
    } catch (error) {
      logger.error('Erreur fermeture RedisService:', error);
    }
  }
}