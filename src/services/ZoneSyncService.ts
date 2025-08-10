import { DatabaseService } from './DatabaseService';
import { RedisService } from './RedisService';
import { ChunkCalculatorService } from './ChunkCalculatorService';
import { Region, Node, City, PostgresNotification } from '../models/Zone';
import { logger } from '../utils/logger';

export class ZoneSyncService {
  private isInitialized = false;
  private lastSyncTime: Date | null = null;
  private syncInProgress = false;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private calculator: ChunkCalculatorService
  ) {}

  async init(): Promise<void> {
    if (this.isInitialized) return;

    logger.info('Initializing zone sync service');
    
    try {
      // Complete initial synchronization
      await this.fullSync();
      
      // Bidirectional sync: Database to Redis
      await this.syncPlayersFromDatabase();
      
      // Start incremental sync listener
      await this.startIncrementalSync();
      
      // Schedule automatic cleanup
      this.scheduleCleanup();
      
      this.isInitialized = true;
      logger.info('Zone sync service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize zone sync service', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to initialize synchronization service');
    }
  }

  // ========== BIDIRECTIONAL SYNC ==========
  private async syncPlayersFromDatabase(): Promise<void> {
    logger.info('Starting bidirectional sync: Database to Redis');
    
    try {
      const players = await this.db.getAllOnlinePlayers();
      
      if (players.length === 0) {
        logger.info('No online players to sync');
        return;
      }

      // FIX: Convert null values to undefined for Redis sync
      const playersForSync = players.map(player => ({
        player_uuid: player.player_uuid,
        x: player.x,
        y: player.y,
        z: player.z,
        chunk_x: player.chunk_x,
        chunk_z: player.chunk_z,
        last_updated: player.last_updated,
        region_id: player.region_id ?? undefined, // Convert null to undefined
        node_id: player.node_id ?? undefined,     // Convert null to undefined
        city_id: player.city_id ?? undefined      // Convert null to undefined
      }));

      const syncedCount = await this.redis.syncPlayersFromDatabase(playersForSync);
      
      logger.info('Database to Redis sync completed', { 
        totalPlayers: players.length, 
        syncedPlayers: syncedCount 
      });
    } catch (error) {
      logger.error('Failed to sync players from database', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ========== SYNCHRONISATION COMPLÈTE ==========
  async fullSync(): Promise<{
    duration: number;
    regionsCount: number;
    nodesCount: number;
    citiesCount: number;
    chunksProcessed: number;
    errors: number;
  }> {
    if (this.syncInProgress) {
      throw new Error('Synchronization already in progress');
    }

    this.syncInProgress = true;
    const startTime = Date.now();
    let chunksProcessed = 0;
    let errors = 0;
    
    try {
      logger.info('Starting full synchronization');
      
      // 1. Load all zones from PostgreSQL
      const [regions, nodes, cities] = await Promise.all([
        this.db.getAllRegions(),
        this.db.getAllNodes(),
        this.db.getAllCities()
      ]);

      logger.info('Loaded zones from database', { 
        regions: regions.length, 
        nodes: nodes.length, 
        cities: cities.length 
      });

      // 2. Validate zone data
      await this.validateZonesData(regions, nodes, cities);

      // 3. Pre-compute all chunks
      const result = await this.precomputeAllChunks(regions, nodes, cities);
      chunksProcessed = result.chunksProcessed;
      errors = result.errors;

      // 4. Cache zone metadata
      await this.cacheZoneMetadata(regions, nodes, cities);

      const duration = Date.now() - startTime;
      this.lastSyncTime = new Date();
      
      logger.info('Full synchronization completed', { 
        durationMs: duration, 
        chunksProcessed, 
        errors 
      });
      
      return {
        duration,
        regionsCount: regions.length,
        nodesCount: nodes.length,
        citiesCount: cities.length,
        chunksProcessed,
        errors
      };
    } catch (error) {
      logger.error('Full synchronization failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  private async validateZonesData(regions: Region[], nodes: Node[], cities: City[]): Promise<void> {
    logger.info('Validating zone data');
    
    const errors: string[] = [];
    
    // Validate polygons
    for (const region of regions) {
      try {
        const validation = this.calculator.validatePolygon(region.chunk_boundary);
        if (!validation.valid) {
          errors.push(`Invalid region ${region.name}: ${validation.error}`);
        }
      } catch (error) {
        errors.push(`Region validation error ${region.name}: ${error}`);
      }
    }

    for (const node of nodes) {
      try {
        const validation = this.calculator.validatePolygon(node.chunk_boundary);
        if (!validation.valid) {
          errors.push(`Invalid node ${node.name}: ${validation.error}`);
        }
      } catch (error) {
        errors.push(`Node validation error ${node.name}: ${error}`);
      }
    }

    for (const city of cities) {
      try {
        const validation = this.calculator.validatePolygon(city.chunk_boundary);
        if (!validation.valid) {
          errors.push(`Invalid city ${city.name}: ${validation.error}`);
        }
      } catch (error) {
        errors.push(`City validation error ${city.name}: ${error}`);
      }
    }

    // Validate hierarchical relationships
    const regionIds = new Set(regions.map(r => r.id));
    for (const node of nodes) {
      if (!regionIds.has(node.region_id)) {
        errors.push(`Node ${node.name} references non-existent region: ${node.region_id}`);
      }
    }

    const nodeIds = new Set(nodes.map(n => n.id));
    for (const city of cities) {
      if (!nodeIds.has(city.node_id)) {
        errors.push(`City ${city.name} references non-existent node: ${city.node_id}`);
      }
    }

    if (errors.length > 0) {
      logger.error('Validation errors detected', { errors });
      throw new Error(`${errors.length} validation errors: ${errors.slice(0, 3).join(', ')}${errors.length > 3 ? '...' : ''}`);
    }

    logger.info('Zone data validation completed successfully');
  }

  private async precomputeAllChunks(regions: Region[], nodes: Node[], cities: City[]): Promise<{
    chunksProcessed: number;
    errors: number;
  }> {
    // If no zones exist, skip pre-computation
    if (regions.length === 0 && nodes.length === 0 && cities.length === 0) {
      logger.info('No zones defined, skipping chunk pre-computation');
      return { chunksProcessed: 0, errors: 0 };
    }

    const batchSize = parseInt(process.env.PRECOMPUTE_BATCH_SIZE || '1000');
    
    let processedChunks = 0;
    let errorCount = 0;
    const errors: string[] = [];
    
    logger.info('Starting chunk computation for zones', { regionsCount: regions.length });

    // Optimization: calculate only chunks that intersect with zones
    const relevantChunks = this.getRelevantChunks(regions, nodes, cities);
    
    if (relevantChunks.length === 0) {
      logger.info('No relevant chunks found, skipping pre-computation');
      return { chunksProcessed: 0, errors: 0 };
    }

    logger.info('Optimized chunk computation', { 
      relevantChunks: relevantChunks.length 
    });

    // Process chunks in batches
    const batchPromises: Promise<void>[] = [];
    
    for (const chunk of relevantChunks) {
      batchPromises.push(
        this.processChunk(chunk.x, chunk.z, regions, nodes, cities)
          .catch(error => {
            errorCount++;
            const errorMsg = `Chunk (${chunk.x}, ${chunk.z}): ${error.message}`;
            if (errors.length < 10) {
              errors.push(errorMsg);
            }
          })
      );
      
      // Process in batches
      if (batchPromises.length >= batchSize) {
        await Promise.allSettled(batchPromises);
        batchPromises.length = 0;
        
        processedChunks += batchSize;
        
        if (processedChunks % 10000 === 0) {
          const progress = Math.round((processedChunks / relevantChunks.length) * 100);
          logger.info('Chunk processing progress', { 
            processed: processedChunks, 
            total: relevantChunks.length, 
            progressPercent: progress, 
            errors: errorCount 
          });
        }
      }
    }
    
    // Process final batch
    if (batchPromises.length > 0) {
      await Promise.allSettled(batchPromises);
      processedChunks += batchPromises.length;
    }

    if (errorCount > 0) {
      logger.warn('Chunk processing completed with errors', { 
        totalProcessed: processedChunks, 
        errors: errorCount 
      });
      if (errors.length > 0) {
        logger.debug('Sample errors', { errors });
      }
    }

    logger.info('Chunk pre-computation completed', { 
      chunksProcessed: processedChunks, 
      errors: errorCount 
    });
    
    return { chunksProcessed: processedChunks, errors: errorCount };
  }

  // Get only relevant chunks that intersect with zones
  private getRelevantChunks(regions: Region[], nodes: Node[], cities: City[]): Array<{x: number, z: number}> {
    const chunks = new Set<string>();
    
    // Get all chunks from regions
    for (const region of regions) {
      const regionChunks = this.calculator.getChunksInPolygon(region.chunk_boundary);
      for (const chunk of regionChunks) {
        chunks.add(`${chunk.x},${chunk.z}`);
      }
    }
    
    // Add chunks from nodes
    for (const node of nodes) {
      const nodeChunks = this.calculator.getChunksInPolygon(node.chunk_boundary);
      for (const chunk of nodeChunks) {
        chunks.add(`${chunk.x},${chunk.z}`);
      }
    }
    
    // Add chunks from cities
    for (const city of cities) {
      const cityChunks = this.calculator.getChunksInPolygon(city.chunk_boundary);
      for (const chunk of cityChunks) {
        chunks.add(`${chunk.x},${chunk.z}`);
      }
    }
    
    // Convert to array
    return Array.from(chunks).map(coord => {
      const [x, z] = coord.split(',').map(Number);
      return { x, z };
    });
  }

  private async processChunk(
    chunkX: number, 
    chunkZ: number, 
    regions: Region[], 
    nodes: Node[], 
    cities: City[]
  ): Promise<void> {
    try {
      const zoneData = this.calculator.calculateChunkZones(chunkX, chunkZ, regions, nodes, cities);
      
      // Save only if chunk belongs to a zone
      if (zoneData.regionId) {
        await this.redis.setChunkZone(chunkX, chunkZ, zoneData);
      }
    } catch (error) {
      throw new Error(`Calculation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async cacheZoneMetadata(regions: Region[], nodes: Node[], cities: City[]): Promise<void> {
    logger.info('Caching zone metadata');
    
    const promises: Promise<void>[] = [];
    let successCount = 0;
    let errorCount = 0;

    // Cache regions
    for (const region of regions) {
      const promise = this.redis.cacheZoneMetadata('region', region.id, {
        name: region.name,
        description: region.description || '',
        is_active: region.is_active,
        created_at: region.created_at.toISOString()
      })
        .then(() => { successCount++; })
        .catch(() => { errorCount++; });

      promises.push(promise);
    }

    // Cache nodes
    for (const node of nodes) {
      const promise = this.redis.cacheZoneMetadata('node', node.id, {
        name: node.name,
        description: node.description || '',
        region_id: node.region_id,
        experience_points: node.experience_points,
        is_active: node.is_active,
        created_at: node.created_at.toISOString()
      })
        .then(() => { successCount++; })
        .catch(() => { errorCount++; });

      promises.push(promise);
    }

    // Cache cities
    for (const city of cities) {
      const promise = this.redis.cacheZoneMetadata('city', city.id, {
        name: city.name,
        description: city.description || '',
        population: city.population,
        max_population: city.max_population,
        node_id: city.node_id,
        is_active: city.is_active,
        created_at: city.created_at.toISOString()
      })
        .then(() => { successCount++; })
        .catch(() => { errorCount++; });

      promises.push(promise);
    }

    await Promise.allSettled(promises);
    
    if (errorCount > 0) {
      logger.warn('Zone metadata caching completed with errors', { 
        successCount, 
        errorCount 
      });
    } else {
      logger.info('Zone metadata cached successfully', { 
        zonesCount: successCount 
      });
    }
  }

  // ========== SYNCHRONISATION INCRÉMENTALE ==========
  async startIncrementalSync(): Promise<void> {
    logger.info('Starting incremental synchronization listener');
    
    try {
      await this.db.listenToChanges(async (notification: PostgresNotification) => {
        logger.info('Database change detected', { 
          operation: notification.operation, 
          table: notification.table, 
          id: notification.id 
        });
        
        try {
          await this.handlePostgresNotification(notification);
        } catch (error) {
          logger.error('Failed to handle notification', { 
            notification, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      });
      
      logger.info('Incremental synchronization listener started');
    } catch (error) {
      logger.error('Failed to start incremental sync', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to start incremental synchronization');
    }
  }

  private async handlePostgresNotification(notification: PostgresNotification): Promise<void> {
    const { table, operation, id } = notification;
    
    try {
      switch (operation) {
        case 'INSERT':
        case 'UPDATE':
          await this.handleZoneUpdate(table, id);
          break;
        case 'DELETE':
          await this.handleZoneDelete(table, id);
          break;
        default:
          logger.warn('Unknown operation', { operation });
      }
    } catch (error) {
      logger.error('Failed to handle postgres notification', { 
        table, 
        operation, 
        id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async handleZoneUpdate(table: string, zoneId: number): Promise<void> {
    try {
      // 1. Invalidate Redis cache for this zone
      const zoneType = table.slice(0, -1) as 'region' | 'node' | 'city'; // regions -> region
      await this.redis.invalidateZoneCache(zoneType, zoneId);
      
      // 2. Reload zone from database
      const zone = await this.db.getZoneById(zoneType, zoneId);
      if (!zone) {
        logger.warn('Zone not found after UPDATE', { table, zoneId });
        return;
      }

      // 3. Recalculate affected chunks
      await this.recalculateZoneChunks(zoneType, zone);
      
await this.updateZoneMetadataCache(zoneType, zone);
      
      logger.info('Zone updated successfully', { table, zoneId });
    } catch (error) {
      logger.error('Failed to handle zone update', { 
        table, 
        zoneId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async handleZoneDelete(table: string, zoneId: number): Promise<void> {
    try {
      const zoneType = table.slice(0, -1) as 'region' | 'node' | 'city';
      
      // 1. Invalidate cache for this zone
      await this.redis.invalidateZoneCache(zoneType, zoneId);
      
      // 2. Remove chunks that referenced this zone
      let deletedChunks = 0;
      
      if (zoneType === 'region') {
        deletedChunks = await this.redis.deleteChunkZonesByPattern(`chunk:zone:*`);
        // After region deletion, recalculate everything
        await this.recalculateAllChunks();
      } else if (zoneType === 'node') {
        // Recalculate chunks of parent region
        await this.recalculateNodeParentChunks(zoneId);
      } else if (zoneType === 'city') {
        // Recalculate chunks of parent node
        await this.recalculateCityParentChunks(zoneId);
      }
      
      logger.info('Zone deleted successfully', { 
        table, 
        zoneId, 
        deletedChunks 
      });
    } catch (error) {
      logger.error('Failed to handle zone delete', { 
        table, 
        zoneId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async recalculateZoneChunks(
    zoneType: 'region' | 'node' | 'city', 
    zone: Region | Node | City
  ): Promise<void> {
    logger.info('Recalculating chunks for zone', { zoneType, zoneId: zone.id });
    
    try {
      // Get all chunks in this zone's polygon
      const chunks = this.calculator.getChunksInPolygon(zone.chunk_boundary);
      let successCount = 0;
      let errorCount = 0;
      
      if (zoneType === 'region') {
        // For region, recalculate with all nodes and cities
        const [nodes, cities] = await Promise.all([
          this.db.getAllNodes(),
          this.db.getAllCities()
        ]);
        
        const regionArray = [zone as Region];
        
        for (const chunk of chunks) {
          try {
            const zoneData = this.calculator.calculateChunkZones(
              chunk.x, chunk.z, regionArray, nodes, cities
            );
            await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
            successCount++;
          } catch (error) {
            errorCount++;
            if (errorCount <= 5) {
              logger.error('Failed to recalculate chunk', { 
                chunkX: chunk.x, 
                chunkZ: chunk.z, 
                error: error instanceof Error ? error.message : 'Unknown error' 
              });
            }
          }
        }
      } else if (zoneType === 'node') {
        // For node, recalculate with parent region and all cities
        const nodeObj = zone as Node;
        const [region, cities] = await Promise.all([
          this.db.getZoneById('region', nodeObj.region_id),
          this.db.getAllCities()
        ]);
        
        if (!region) {
          throw new Error(`Parent region ${nodeObj.region_id} not found`);
        }
        
        const regions = [region as Region];
        const nodes = [nodeObj];
        
        for (const chunk of chunks) {
          try {
            const zoneData = this.calculator.calculateChunkZones(
              chunk.x, chunk.z, regions, nodes, cities
            );
            await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
            successCount++;
          } catch (error) {
            errorCount++;
            if (errorCount <= 5) {
              logger.error('Failed to recalculate chunk', { 
                chunkX: chunk.x, 
                chunkZ: chunk.z, 
                error: error instanceof Error ? error.message : 'Unknown error' 
              });
            }
          }
        }
      } else {
        // For city, recalculate with parent node and region
        const cityObj = zone as City;
        const [node, regions, nodes, cities] = await Promise.all([
          this.db.getZoneById('node', cityObj.node_id),
          this.db.getAllRegions(),
          this.db.getAllNodes(),
          this.db.getAllCities()
        ]);
        
        if (!node) {
          throw new Error(`Parent node ${cityObj.node_id} not found`);
        }
        
        for (const chunk of chunks) {
          try {
            const zoneData = this.calculator.calculateChunkZones(
              chunk.x, chunk.z, regions, nodes, cities
            );
            await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
            successCount++;
          } catch (error) {
            errorCount++;
            if (errorCount <= 5) {
              logger.error('Failed to recalculate chunk', { 
                chunkX: chunk.x, 
                chunkZ: chunk.z, 
                error: error instanceof Error ? error.message : 'Unknown error' 
              });
            }
          }
        }
      }
      
      if (errorCount > 0) {
        logger.warn('Zone chunks recalculated with errors', { 
          zoneType, 
          zoneId: zone.id, 
          successCount, 
          errorCount 
        });
      } else {
        logger.info('Zone chunks recalculated successfully', { 
          zoneType, 
          zoneId: zone.id, 
          chunksCount: successCount 
        });
      }
    } catch (error) {
      logger.error('Failed to recalculate zone chunks', { 
        zoneType, 
        zoneId: zone.id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async updateZoneMetadataCache(
    zoneType: 'region' | 'node' | 'city',
    zone: Region | Node | City
  ): Promise<void> {
    try {
      let metadata: Record<string, any>;
      
      if (zoneType === 'region') {
        const region = zone as Region;
        metadata = {
          name: region.name,
          description: region.description || '',
          is_active: region.is_active,
          created_at: region.created_at.toISOString()
        };
      } else if (zoneType === 'node') {
        const node = zone as Node;
        metadata = {
          name: node.name,
          description: node.description || '',
          region_id: node.region_id,
          experience_points: node.experience_points,
          is_active: node.is_active,
          created_at: node.created_at.toISOString()
        };
      } else {
        const city = zone as City;
        metadata = {
          name: city.name,
          description: city.description || '',
          population: city.population,
          max_population: city.max_population,
          node_id: city.node_id,
          is_active: city.is_active,
          created_at: city.created_at.toISOString()
        };
      }
      
      await this.redis.cacheZoneMetadata(zoneType, zone.id, metadata);
    } catch (error) {
      logger.error('Failed to update zone metadata cache', { 
        zoneType, 
        zoneId: zone.id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async recalculateAllChunks(): Promise<void> {
    logger.warn('Starting full chunk recalculation');
    
    try {
      const [regions, nodes, cities] = await Promise.all([
        this.db.getAllRegions(),
        this.db.getAllNodes(),
        this.db.getAllCities()
      ]);
      
      const result = await this.precomputeAllChunks(regions, nodes, cities);
      logger.info('Full chunk recalculation completed', { 
        chunksProcessed: result.chunksProcessed, 
        errors: result.errors 
      });
    } catch (error) {
      logger.error('Failed to recalculate all chunks', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async recalculateNodeParentChunks(nodeId: number): Promise<void> {
    logger.info('Recalculating chunks after node deletion', { nodeId });
    
    try {
      // For now, full recalculation (future optimization possible)
      // TODO: Optimize by recalculating only parent region chunks
      await this.recalculateAllChunks();
    } catch (error) {
      logger.error('Failed to recalculate node parent chunks', { 
        nodeId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async recalculateCityParentChunks(cityId: number): Promise<void> {
    logger.info('Recalculating chunks after city deletion', { cityId });
    
    try {
      // For now, full recalculation (future optimization possible)
      // TODO: Optimize by recalculating only parent node chunks
      await this.recalculateAllChunks();
    } catch (error) {
      logger.error('Failed to recalculate city parent chunks', { 
        cityId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ========== NETTOYAGE ET MAINTENANCE ==========
  private scheduleCleanup(): void {
    // Automatic cleanup every hour
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.performCleanup();
      } catch (error) {
        logger.error('Automatic cleanup failed', { 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    }, 60 * 60 * 1000); // 1 hour

    logger.info('Automatic cleanup scheduled', { intervalHours: 1 });
  }

  async performCleanup(): Promise<{
    deletedPlayers: number;
    deletedChunks: number;
  }> {
    logger.info('Starting automatic cleanup');
    
    try {
      const result = await this.redis.cleanupExpiredData();
      
      logger.info('Automatic cleanup completed', { 
        deletedPlayers: result.deletedPlayers, 
        deletedChunks: result.deletedChunks 
      });
      return result;
    } catch (error) {
      logger.error('Cleanup failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ========== DIAGNOSTICS ET MONITORING ==========
  async getHealthStatus(): Promise<{
    isHealthy: boolean;
    lastSyncTime: Date | null;
    syncInProgress: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];
    
    try {
      // Check Redis
      await this.redis.getStats();
    } catch (error) {
      issues.push('Redis inaccessible');
    }
    
    try {
      // Check PostgreSQL
      await this.db.getZoneStats();
    } catch (error) {
      issues.push('PostgreSQL inaccessible');
    }
    
    // Check if last sync is not too old
    if (this.lastSyncTime) {
      const timeSinceLastSync = Date.now() - this.lastSyncTime.getTime();
      if (timeSinceLastSync > 24 * 60 * 60 * 1000) { // 24 hours
        issues.push('Last synchronization too old');
      }
    } else {
      issues.push('No synchronization performed');
    }
    
    return {
      isHealthy: issues.length === 0,
      lastSyncTime: this.lastSyncTime,
      syncInProgress: this.syncInProgress,
      issues
    };
  }

  async getDetailedStats(): Promise<{
    database: any;
    redis: any;
    sync: {
      lastSyncTime: Date | null;
      syncInProgress: boolean;
      isInitialized: boolean;
    };
  }> {
    try {
      const [dbStats, redisStats] = await Promise.all([
        this.db.getZoneStats(),
        this.redis.getStats()
      ]);
      
      return {
        database: dbStats,
        redis: redisStats,
        sync: {
          lastSyncTime: this.lastSyncTime,
          syncInProgress: this.syncInProgress,
          isInitialized: this.isInitialized
        }
      };
    } catch (error) {
      logger.error('Failed to get detailed stats', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ========== MÉTHODES PUBLIQUES ==========
  isReady(): boolean {
    return this.isInitialized && !this.syncInProgress;
  }

  getLastSyncTime(): Date | null {
    return this.lastSyncTime;
  }

  isSyncInProgress(): boolean {
    return this.syncInProgress;
  }

  async forceFreshSync(): Promise<void> {
    if (this.syncInProgress) {
      throw new Error('Synchronization already in progress');
    }
    
    logger.info('Forced synchronization started');
    await this.fullSync();
    await this.syncPlayersFromDatabase();
  }

  // ========== NETTOYAGE À LA FERMETURE ==========
  async destroy(): Promise<void> {
    logger.info('Shutting down zone sync service');
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    this.isInitialized = false;
    logger.info('Zone sync service shut down successfully');
  }
}