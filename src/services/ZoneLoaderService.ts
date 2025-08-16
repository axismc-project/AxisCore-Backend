// src/services/ZoneLoaderService.ts
import { DatabaseService } from './DatabaseService';
import { RedisService } from './RedisService';
import { ChunkCalculatorService } from './ChunkCalculatorService';
import { logger } from '../utils/logger';

export class ZoneLoaderService {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private calculator: ChunkCalculatorService
  ) {}

  async loadAllZonesToRedis(): Promise<void> {
    try {
      logger.info('🗺️ Loading zones from PostgreSQL to Redis...');
      
      const startTime = Date.now();
      
      // 1. Nettoyer les anciens chunks
      await this.clearExistingChunks();
      
      // 2. Charger les zones de la base
      const [regions, nodes, cities] = await Promise.all([
        this.db.getAllRegions(),
        this.db.getAllNodes(),
        this.db.getAllCities()
      ]);
      
      logger.info('📊 Zones loaded from database', {
        regions: regions.length,
        nodes: nodes.length,
        cities: cities.length
      });
      
      // 3. Calculer et stocker les chunks par priorité (région → node → ville)
      let totalChunks = 0;
      
      // Étape 1: Régions (base)
      for (const region of regions) {
        const chunks = await this.processZoneChunks(region, 'region');
        totalChunks += chunks;
        logger.debug(`✅ Region "${region.name}": ${chunks} chunks processed`);
      }
      
      // Étape 2: Nodes (override régions)
      for (const node of nodes) {
        const chunks = await this.processZoneChunks(node, 'node');
        logger.debug(`✅ Node "${node.name}": ${chunks} chunks processed`);
      }
      
      // Étape 3: Villes (override nodes)
      for (const city of cities) {
        const chunks = await this.processZoneChunks(city, 'city');
        logger.debug(`✅ City "${city.name}": ${chunks} chunks processed`);
      }
      
      const duration = Date.now() - startTime;
      
      logger.info('✅ Zone loading completed', {
        totalZones: regions.length + nodes.length + cities.length,
        totalChunks,
        durationMs: duration,
        avgChunksPerZone: Math.round(totalChunks / (regions.length + nodes.length + cities.length))
      });
      
    } catch (error) {
      logger.error('❌ Failed to load zones to Redis', { error });
      throw error;
    }
  }

  private async clearExistingChunks(): Promise<void> {
    try {
      const existingKeys = await this.redis.keys('chunk:zone:*');
      if (existingKeys.length > 0) {
        await this.redis.del(existingKeys);
        logger.info(`🧹 Cleared ${existingKeys.length} existing chunk entries`);
      }
    } catch (error) {
      logger.warn('⚠️ Failed to clear existing chunks', { error });
    }
  }

  private async processZoneChunks(
    zone: any, 
    zoneType: 'region' | 'node' | 'city'
  ): Promise<number> {
    try {
      if (!zone.chunk_boundary || !Array.isArray(zone.chunk_boundary) || zone.chunk_boundary.length < 3) {
        logger.warn(`⚠️ Invalid polygon for ${zoneType} "${zone.name}"`, {
          zoneId: zone.id,
          boundaryLength: zone.chunk_boundary?.length || 0
        });
        return 0;
      }

      const chunks = this.calculator.getChunksInPolygon(zone.chunk_boundary);
      
      if (chunks.length === 0) {
        logger.warn(`⚠️ No chunks found for ${zoneType} "${zone.name}"`, {
          zoneId: zone.id,
          polygon: zone.chunk_boundary
        });
        return 0;
      }

      // Traiter par batches pour éviter la surcharge Redis
      const batchSize = 500;
      let processedCount = 0;

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        
        for (const chunk of batch) {
          await this.updateChunkZone(chunk.x, chunk.z, zone, zoneType);
          processedCount++;
        }
        
        // Petit délai pour éviter la surcharge
        if (i + batchSize < chunks.length) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      return processedCount;
      
    } catch (error) {
      logger.error(`❌ Failed to process ${zoneType} "${zone.name}"`, {
        zoneId: zone.id,
        error
      });
      return 0;
    }
  }

  private async updateChunkZone(
    chunkX: number, 
    chunkZ: number, 
    zone: any, 
    zoneType: 'region' | 'node' | 'city'
  ): Promise<void> {
    try {
      // Récupérer les zones existantes pour ce chunk
      const existingZones = await this.redis.getChunkZone(chunkX, chunkZ);
      
      // Créer la nouvelle structure de zones
      const zoneData = {
        regionId: existingZones?.regionId || null,
        regionName: existingZones?.regionName || null,
        nodeId: existingZones?.nodeId || null,
        nodeName: existingZones?.nodeName || null,
        cityId: existingZones?.cityId || null,
        cityName: existingZones?.cityName || null
      };

      // Mettre à jour selon le type de zone
      switch (zoneType) {
        case 'region':
          zoneData.regionId = zone.id;
          zoneData.regionName = zone.name;
          break;
        case 'node':
          zoneData.nodeId = zone.id;
          zoneData.nodeName = zone.name;
          break;
        case 'city':
          zoneData.cityId = zone.id;
          zoneData.cityName = zone.name;
          break;
      }

      await this.redis.setChunkZone(chunkX, chunkZ, zoneData);
      
    } catch (error) {
      logger.error('❌ Failed to update chunk zone', {
        chunkX, chunkZ, zoneType, zoneId: zone.id, error
      });
    }
  }

  // Méthode pour recharger une zone spécifique (utile après modification)
  async reloadZone(zoneType: 'region' | 'node' | 'city', zoneId: number): Promise<void> {
    try {
      logger.info(`🔄 Reloading ${zoneType} ${zoneId}...`);
      
      const zone = await this.db.getZoneById(zoneType, zoneId);
      if (!zone) {
        throw new Error(`Zone ${zoneType}:${zoneId} not found`);
      }

      const chunks = await this.processZoneChunks(zone, zoneType);
      
      logger.info(`✅ Zone ${zoneType}:${zoneId} reloaded`, { chunks });
      
    } catch (error) {
      logger.error(`❌ Failed to reload zone ${zoneType}:${zoneId}`, { error });
      throw error;
    }
  }

  // Statistiques du cache
  async getCacheStats(): Promise<{
    totalCachedChunks: number;
    regionsCount: number;
    nodesCount: number;
    citiesCount: number;
    wildcardChunks: number;
  }> {
    try {
      const chunkKeys = await this.redis.keys('chunk:zone:*');
      
      let regionsCount = 0;
      let nodesCount = 0;
      let citiesCount = 0;
      let wildcardChunks = 0;

      // Échantillonner quelques chunks pour les stats
      const sampleSize = Math.min(100, chunkKeys.length);
      const sampleKeys = chunkKeys.slice(0, sampleSize);

      for (const key of sampleKeys) {
        const zoneData = await this.redis.hGetAll(key);
        
        if (!zoneData.region_id && !zoneData.node_id && !zoneData.city_id) {
          wildcardChunks++;
        } else {
          if (zoneData.region_id) regionsCount++;
          if (zoneData.node_id) nodesCount++;
          if (zoneData.city_id) citiesCount++;
        }
      }

      return {
        totalCachedChunks: chunkKeys.length,
        regionsCount: Math.round(regionsCount * chunkKeys.length / sampleSize),
        nodesCount: Math.round(nodesCount * chunkKeys.length / sampleSize),
        citiesCount: Math.round(citiesCount * chunkKeys.length / sampleSize),
        wildcardChunks: Math.round(wildcardChunks * chunkKeys.length / sampleSize)
      };
      
    } catch (error) {
      logger.error('❌ Failed to get cache stats', { error });
      return {
        totalCachedChunks: 0,
        regionsCount: 0,
        nodesCount: 0,
        citiesCount: 0,
        wildcardChunks: 0
      };
    }
  }
}