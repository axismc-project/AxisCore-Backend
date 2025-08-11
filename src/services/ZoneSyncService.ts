import { RedisService } from './RedisService';
import { DatabaseService } from './DatabaseService';
import { logger } from '../utils/logger';

interface ZoneData {
  id: number;
  name: string;
  chunk_boundary: [number, number][];
  boundary_cache: [number, number][];
  is_active: boolean;
  type: 'region' | 'node' | 'city';
  region_id?: number;
  node_id?: number;
}

interface BoundingBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface ChunkZoneData {
  regionId?: number;
  regionName?: string;
  nodeId?: number;
  nodeName?: string;
  cityId?: number;
  cityName?: string;
}

export class ZoneSyncService {
  private redisService: RedisService;
  private databaseService: DatabaseService;
  private allZones: ZoneData[] = [];
  private chunkCache: Map<string, ChunkZoneData> = new Map();
  private isInitialized = false;
  private syncInProgress = false;

  constructor(redisService: RedisService, databaseService: DatabaseService) {
    this.redisService = redisService;
    this.databaseService = databaseService;
  }

  /**
   * Initialise le service et effectue la synchronisation complète
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Zone sync service already initialized');
      return;
    }

    logger.info('🚀 Initializing REAL-TIME zone sync service');

    try {
      await this.performFullSync();
      this.isInitialized = true;
      logger.info('✅ Zone sync service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize zone sync service', { error });
      throw error;
    }
  }

  /**
   * Effectue une synchronisation complète
   */
  async performFullSync(): Promise<void> {
    if (this.syncInProgress) {
      logger.warn('Sync already in progress, skipping');
      return;
    }

    this.syncInProgress = true;
    const startTime = Date.now();

    try {
      logger.info('Starting full synchronization');

      // 1. Charger toutes les zones depuis la base
      await this.loadZonesFromDatabase();

      // 2. Valider les données des zones
      this.validateZoneData();

      // 3. Calculer les chunks pour toutes les zones
      await this.computeAllChunks();

      // 4. Mettre en cache les métadonnées des zones
      await this.cacheZoneMetadata();

      const duration = Date.now() - startTime;
      const chunksCount = this.chunkCache.size;

      logger.info('Full synchronization completed', {
        durationMs: duration,
        chunksProcessed: chunksCount,
        errors: 0,
        zonesCount: this.allZones.length
      });

      logger.info('✅ Full sync completed - continuing...');

    } catch (error) {
      logger.error('Full synchronization failed', { error });
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Charge toutes les zones depuis la base de données
   */
// Remplacer les méthodes query par les bonnes méthodes
private async loadZonesFromDatabase(): Promise<void> {
  try {
    const [regions, nodes, cities] = await Promise.all([
      this.databaseService.executeQuery('SELECT id, name, chunk_boundary, boundary_cache, is_active FROM regions WHERE is_active = true'),
      this.databaseService.executeQuery('SELECT id, name, region_id, chunk_boundary, boundary_cache, is_active FROM nodes WHERE is_active = true'),
      this.databaseService.executeQuery('SELECT id, name, node_id, chunk_boundary, boundary_cache, is_active FROM cities WHERE is_active = true')
    ]);

    // Convertir et typer les données avec types explicites
    this.allZones = [
      ...regions.rows.map((r: any) => ({ ...r, type: 'region' as const })),
      ...nodes.rows.map((n: any) => ({ ...n, type: 'node' as const })),
      ...cities.rows.map((c: any) => ({ ...c, type: 'city' as const }))
    ];

    logger.info('Loaded zones from database', {
      regions: regions.rows.length,
      nodes: nodes.rows.length,
      cities: cities.rows.length
    });

  } catch (error) {
    logger.error('Failed to load zones from database', { error });
    throw error;
  }
}

  /**
   * Valide les données des zones
   */
  private validateZoneData(): void {
    logger.info('Validating zone data');
    
    let invalidCount = 0;
    
    this.allZones = this.allZones.filter(zone => {
      // Vérifier chunk_boundary
      if (!zone.chunk_boundary || !Array.isArray(zone.chunk_boundary)) {
        logger.warn(`Zone ${zone.name} has invalid chunk_boundary - not an array`);
        invalidCount++;
        return false;
      }

      // Vérifier qu'il y a au moins 3 points pour former un polygone
      if (zone.chunk_boundary.length < 3) {
        logger.warn(`Zone ${zone.name} has insufficient points in chunk_boundary: ${zone.chunk_boundary.length}`);
        invalidCount++;
        return false;
      }

      // Vérifier que tous les points sont valides
      const hasInvalidPoints = zone.chunk_boundary.some((point, index) => {
        if (!Array.isArray(point)) {
          logger.warn(`Zone ${zone.name} point ${index} is not an array: ${typeof point}`);
          return true;
        }
        if (point.length !== 2) {
          logger.warn(`Zone ${zone.name} point ${index} does not have 2 coordinates: ${point.length}`);
          return true;
        }
        if (typeof point[0] !== 'number' || typeof point[1] !== 'number') {
          logger.warn(`Zone ${zone.name} point ${index} has non-numeric coordinates: [${typeof point[0]}, ${typeof point[1]}]`);
          return true;
        }
        if (!isFinite(point[0]) || !isFinite(point[1])) {
          logger.warn(`Zone ${zone.name} point ${index} has infinite coordinates: [${point[0]}, ${point[1]}]`);
          return true;
        }
        return false;
      });

      if (hasInvalidPoints) {
        invalidCount++;
        return false;
      }

      return true;
    });

    if (invalidCount > 0) {
      logger.warn(`Filtered out ${invalidCount} invalid zones`);
    }

    logger.info('Zone data validation completed successfully');
  }

  /**
   * Calcule les chunks pour toutes les zones
   */
  private async computeAllChunks(): Promise<void> {
    logger.info('🔄 NEW ZoneSyncService - Starting chunk computation for zones', {
      regionsCount: this.allZones.filter(z => z.type === 'region').length,
      nodesCount: this.allZones.filter(z => z.type === 'node').length,
      citiesCount: this.allZones.filter(z => z.type === 'city').length
    });

    this.chunkCache.clear();
    let totalChunks = 0;
    let errors = 0;

    for (const zone of this.allZones) {
      try {
        logger.debug(`Computing chunks for zone: ${zone.name} (${zone.type})`);
        
        const chunks = this.computeChunksForZone(zone);
        totalChunks += chunks.size;

        logger.debug(`Zone ${zone.name} contains ${chunks.size} chunks`);

        // Ajouter les chunks au cache
        for (const chunkKey of chunks) {
          const existing = this.chunkCache.get(chunkKey) || {};
          
          if (zone.type === 'region') {
            existing.regionId = zone.id;
            existing.regionName = zone.name;
          } else if (zone.type === 'node') {
            existing.nodeId = zone.id;
            existing.nodeName = zone.name;
          } else if (zone.type === 'city') {
            existing.cityId = zone.id;
            existing.cityName = zone.name;
          }

          this.chunkCache.set(chunkKey, existing);
        }

      } catch (error) {
        errors++;
        logger.error(`Failed to compute chunks for zone ${zone.name}`, { 
          error: error instanceof Error ? error.message : String(error),
          zone: zone.name,
          zoneType: zone.type
        });
      }
    }

    logger.info('Chunk pre-computation completed', {
      chunksProcessed: totalChunks,
      errors: errors,
      uniqueChunks: this.chunkCache.size
    });

    if (errors > 0) {
      logger.warn('Chunk processing completed with errors', {
        errors: errors,
        totalProcessed: totalChunks
      });
    }
  }

  /**
   * Calcule les chunks pour une zone spécifique
   */
  private computeChunksForZone(zone: ZoneData): Set<string> {
    const chunks = new Set<string>();
    const polygon = zone.chunk_boundary;

    try {
      // Calculer la bounding box pour optimiser
      const bounds = this.getBoundingBox(polygon);
      
      logger.debug(`Zone ${zone.name} bounding box:`, bounds);
      
      // Limiter la zone de calcul pour éviter les chunks trop éloignés
      const MAX_CHUNK_DISTANCE = 2000; // ±32000 blocs
      const originalBounds = { ...bounds };
      
      bounds.minX = Math.max(bounds.minX, -MAX_CHUNK_DISTANCE);
      bounds.maxX = Math.min(bounds.maxX, MAX_CHUNK_DISTANCE);
      bounds.minZ = Math.max(bounds.minZ, -MAX_CHUNK_DISTANCE);
      bounds.maxZ = Math.min(bounds.maxZ, MAX_CHUNK_DISTANCE);

      if (bounds.minX !== originalBounds.minX || bounds.maxX !== originalBounds.maxX ||
          bounds.minZ !== originalBounds.minZ || bounds.maxZ !== originalBounds.maxZ) {
        logger.debug(`Zone ${zone.name} bounds clamped from [${originalBounds.minX},${originalBounds.minZ}] to [${originalBounds.maxX},${originalBounds.maxZ}] -> [${bounds.minX},${bounds.minZ}] to [${bounds.maxX},${bounds.maxZ}]`);
      }

      // Calculer le nombre de chunks à tester
      const chunksToTest = (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1);
      logger.debug(`Zone ${zone.name} will test ${chunksToTest} chunks`);

      // Tester chaque chunk dans la bounding box
      for (let chunkX = bounds.minX; chunkX <= bounds.maxX; chunkX++) {
        for (let chunkZ = bounds.minZ; chunkZ <= bounds.maxZ; chunkZ++) {
          if (this.isPointInPolygon([chunkX, chunkZ], polygon)) {
            chunks.add(`${chunkX},${chunkZ}`);
          }
        }
      }

      return chunks;

    } catch (error) {
      logger.error(`Error computing chunks for zone ${zone.name}:`, {
        error: error instanceof Error ? error.message : String(error),
        polygonLength: polygon.length
      });
      return new Set();
    }
  }

  /**
   * Calcule la bounding box d'un polygone
   */
  private getBoundingBox(polygon: [number, number][]): BoundingBox {
    if (polygon.length === 0) {
      throw new Error('Cannot compute bounding box of empty polygon');
    }

    let minX = polygon[0][0];
    let maxX = polygon[0][0];
    let minZ = polygon[0][1];
    let maxZ = polygon[0][1];

    for (let i = 1; i < polygon.length; i++) {
      const [x, z] = polygon[i];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }

    return { minX, maxX, minZ, maxZ };
  }

  /**
   * Algorithme point-in-polygon (Ray casting)
   */
  private isPointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];

      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }

    return inside;
  }

  /**
   * Met en cache les métadonnées des zones dans Redis
   */
  private async cacheZoneMetadata(): Promise<void> {
    logger.info('Caching zone metadata');

    try {
      // Préparer les données pour Redis
      const zoneMetadata = {
        regions: this.allZones.filter(z => z.type === 'region').map(z => ({
          id: z.id,
          name: z.name
        })),
        nodes: this.allZones.filter(z => z.type === 'node').map(z => ({
          id: z.id,
          name: z.name,
          region_id: z.region_id
        })),
        cities: this.allZones.filter(z => z.type === 'city').map(z => ({
          id: z.id,
          name: z.name,
          node_id: z.node_id
        })),
        lastUpdate: new Date().toISOString(),
        totalChunks: this.chunkCache.size
      };

      // Stocker dans Redis avec expiration de 24h
      await this.redisService.setex('zones:metadata', 86400, JSON.stringify(zoneMetadata));

      // Stocker également un index des chunks pour accès rapide
      const chunkIndex: Record<string, ChunkZoneData> = {};
      for (const [chunkKey, zoneData] of this.chunkCache.entries()) {
        chunkIndex[chunkKey] = zoneData;
      }

      await this.redisService.setex('zones:chunks', 86400, JSON.stringify(chunkIndex));

      logger.info('Zone metadata cached successfully', {
        zonesCount: this.allZones.length
      });

    } catch (error) {
      logger.error('Failed to cache zone metadata', { error });
      throw error;
    }
  }

  /**
   * Obtient les zones pour un chunk donné
   */
  async getZonesForChunk(chunkX: number, chunkZ: number): Promise<ChunkZoneData | null> {
    const chunkKey = `${chunkX},${chunkZ}`;
    
    // Essayer d'abord le cache mémoire
    if (this.chunkCache.has(chunkKey)) {
      return this.chunkCache.get(chunkKey) || null;
    }

    // Essayer le cache Redis
    try {
      const cachedData = await this.redisService.get('zones:chunks');
      if (cachedData) {
        const chunkIndex = JSON.parse(cachedData);
        return chunkIndex[chunkKey] || null;
      }
    } catch (error) {
      logger.warn('Failed to get chunk data from Redis cache', { error });
    }

    // Calcul en temps réel si pas en cache
    return this.computeZonesForChunkRealtime(chunkX, chunkZ);
  }

  /**
   * Calcule les zones pour un chunk en temps réel
   */
  private computeZonesForChunkRealtime(chunkX: number, chunkZ: number): ChunkZoneData | null {
    const result: ChunkZoneData = {};

    for (const zone of this.allZones) {
      if (this.isPointInPolygon([chunkX, chunkZ], zone.chunk_boundary)) {
        if (zone.type === 'region') {
          result.regionId = zone.id;
          result.regionName = zone.name;
        } else if (zone.type === 'node') {
          result.nodeId = zone.id;
          result.nodeName = zone.name;
        } else if (zone.type === 'city') {
          result.cityId = zone.id;
          result.cityName = zone.name;
        }
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * Obtient les zones pour des coordonnées monde
   */
  async getZonesForWorldCoordinates(x: number, z: number): Promise<ChunkZoneData | null> {
    const chunkX = Math.floor(x / 16);
    const chunkZ = Math.floor(z / 16);
    return this.getZonesForChunk(chunkX, chunkZ);
  }

  /**
   * Force une resynchronisation
   */
  async forceResync(): Promise<void> {
    logger.info('Forcing zone resynchronization');
    await this.performFullSync();
  }

  /**
   * Obtient les statistiques du service
   */
  getStats(): any {
    return {
      isInitialized: this.isInitialized,
      syncInProgress: this.syncInProgress,
      zonesLoaded: this.allZones.length,
      chunksInCache: this.chunkCache.size,
      zonesByType: {
        regions: this.allZones.filter(z => z.type === 'region').length,
        nodes: this.allZones.filter(z => z.type === 'node').length,
        cities: this.allZones.filter(z => z.type === 'city').length
      }
    };
  }
}