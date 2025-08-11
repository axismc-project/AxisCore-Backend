import { RedisService } from './RedisService';
import { DatabaseService } from './DatabaseService';
import { ChunkCalculatorService } from './ChunkCalculatorService';
import { DatabaseBatchService } from './DatabaseBatchService';
import { Region, Node, City, ChunkZoneData } from '../models/Zone';
import { logger } from '../utils/logger';

interface ZoneSyncStats {
  isReady: boolean;
  lastSyncTime: Date | null;
  syncInProgress: boolean;
  zonesLoaded: number;
  chunksProcessed: number;
  errors: number;
  performance: {
    lastSyncDuration: number;
    averageChunkTime: number;
  };
}

interface HealthStatus {
  isHealthy: boolean;
  lastSync: Date | null;
  syncInProgress: boolean;
  issues: string[];
  services: {
    redis: boolean;
    database: boolean;
    calculator: boolean;
  };
}

export class ZoneSyncService {
  private serviceReady = false;
  private lastSyncTime: Date | null = null;
  private syncInProgress = false;
  private postgresListener: any = null;
  private keyspaceListener: boolean = false;
  
  // Cached data
  private regions: Region[] = [];
  private nodes: Node[] = [];
  private cities: City[] = [];
  
  // Statistics
  private stats: ZoneSyncStats = {
    isReady: false,
    lastSyncTime: null,
    syncInProgress: false,
    zonesLoaded: 0,
    chunksProcessed: 0,
    errors: 0,
    performance: {
      lastSyncDuration: 0,
      averageChunkTime: 0
    }
  };

  constructor(
    private databaseService: DatabaseService,
    private redisService: RedisService,
    private calculatorService?: ChunkCalculatorService,
    private batchService?: DatabaseBatchService
  ) {
    logger.info('🚀 ZoneSyncService constructor initialized');
  }

  // ========== INITIALIZATION ==========
  async init(): Promise<void> {
    if (this.serviceReady) {
      logger.warn('ZoneSyncService already initialized');
      return;
    }

    try {
      logger.info('🚀 Initializing ZoneSyncService with REAL-TIME capabilities');
      
      // 1. Perform initial zone synchronization
      await this.performFullSync();
      
      // 2. Set up PostgreSQL listener for zone changes
      await this.setupPostgresListener();
      
      // 3. Set up Redis keyspace notifications for player positions
      await this.setupRedisKeyspaceListener();
      
      // 4. Mark as ready
      this.serviceReady = true;
      this.lastSyncTime = new Date();
      this.updateStats();
      
      logger.info('✅ ZoneSyncService initialized successfully', {
        regions: this.regions.length,
        nodes: this.nodes.length,
        cities: this.cities.length,
        chunksProcessed: this.stats.chunksProcessed
      });
    } catch (error) {
      logger.error('❌ Failed to initialize ZoneSyncService', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      this.serviceReady = false;
      throw error;
    }
  }

  // ========== CORE SYNC METHODS ==========
  async performFullSync(): Promise<void> {
    if (this.syncInProgress) {
      logger.warn('Sync already in progress, skipping');
      return;
    }

    this.syncInProgress = true;
    const startTime = Date.now();
    let chunksProcessed = 0;
    let errors = 0;

    try {
      logger.info('🔄 Starting full zone synchronization');

      // 1. Load all zones from database
      await this.loadZonesFromDatabase();

      // 2. Validate zone data
      this.validateZoneData();

      // 3. Pre-calculate and cache chunk zones
      if (this.calculatorService) {
        chunksProcessed = await this.preCalculateAllChunks();
      } else {
        logger.warn('Calculator service not available, skipping chunk pre-calculation');
      }

      // 4. Cache zone metadata in Redis
      await this.cacheZoneMetadata();

      const duration = Date.now() - startTime;
      
      logger.info('✅ Full synchronization completed successfully', {
        durationMs: duration,
        regions: this.regions.length,
        nodes: this.nodes.length,
        cities: this.cities.length,
        chunksProcessed,
        errors,
        performance: {
          avgTimePerChunk: chunksProcessed > 0 ? Math.round(duration / chunksProcessed * 100) / 100 : 0
        }
      });

      // Update statistics
      this.stats.performance.lastSyncDuration = duration;
      this.stats.chunksProcessed = chunksProcessed;
      this.stats.errors = errors;
      this.stats.performance.averageChunkTime = chunksProcessed > 0 ? duration / chunksProcessed : 0;

    } catch (error) {
      errors++;
      this.stats.errors = errors;
      logger.error('❌ Full synchronization failed', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime
      });
      throw error;
    } finally {
      this.syncInProgress = false;
      this.lastSyncTime = new Date();
      this.updateStats();
    }
  }

  private async loadZonesFromDatabase(): Promise<void> {
    try {
      logger.info('📊 Loading zones from database');

      const [regions, nodes, cities] = await Promise.all([
        this.databaseService.getAllRegions(),
        this.databaseService.getAllNodes(),
        this.databaseService.getAllCities()
      ]);

      this.regions = regions;
      this.nodes = nodes;
      this.cities = cities;

      logger.info('✅ Zones loaded from database', {
        regions: regions.length,
        nodes: nodes.length,
        cities: cities.length,
        totalZones: regions.length + nodes.length + cities.length
      });

      // ✅ DEBUG: Log zone data to see what we actually have
      this.regions.forEach((region, index) => {
        logger.info(`🔍 Region ${index + 1}:`, {
          id: region.id,
          name: region.name,
          boundaryPoints: region.chunk_boundary?.length || 0,
          firstPoint: region.chunk_boundary?.[0],
          isActive: region.is_active
        });
      });

      this.nodes.forEach((node, index) => {
        logger.info(`🔍 Node ${index + 1}:`, {
          id: node.id,
          name: node.name,
          regionId: node.region_id,
          boundaryPoints: node.chunk_boundary?.length || 0,
          firstPoint: node.chunk_boundary?.[0],
          isActive: node.is_active
        });
      });

      this.cities.forEach((city, index) => {
        logger.info(`🔍 City ${index + 1}:`, {
          id: city.id,
          name: city.name,
          nodeId: city.node_id,
          boundaryPoints: city.chunk_boundary?.length || 0,
          firstPoint: city.chunk_boundary?.[0],
          isActive: city.is_active
        });
      });

    } catch (error) {
      logger.error('❌ Failed to load zones from database', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to load zones from database');
    }
  }

  private validateZoneData(): void {
    logger.info('🔍 Validating zone data');
    
    let invalidCount = 0;
    const originalCount = this.regions.length + this.nodes.length + this.cities.length;

    // Validate regions
    this.regions = this.regions.filter(region => {
      const isValid = this.validateZonePolygon(region, 'region');
      if (!isValid) invalidCount++;
      return isValid;
    });

    // Validate nodes
    this.nodes = this.nodes.filter(node => {
      const isValid = this.validateZonePolygon(node, 'node');
      if (!isValid) invalidCount++;
      return isValid;
    });

    // Validate cities
    this.cities = this.cities.filter(city => {
      const isValid = this.validateZonePolygon(city, 'city');
      if (!isValid) invalidCount++;
      return isValid;
    });

    const validCount = this.regions.length + this.nodes.length + this.cities.length;

    if (invalidCount > 0) {
      logger.warn(`⚠️ Filtered out ${invalidCount} invalid zones`, {
        originalCount,
        validCount,
        invalidCount
      });
    }

    logger.info('✅ Zone data validation completed', {
      validRegions: this.regions.length,
      validNodes: this.nodes.length,
      validCities: this.cities.length,
      invalidFiltered: invalidCount
    });
  }

  private validateZonePolygon(zone: any, zoneType: string): boolean {
    try {
      // Check if chunk_boundary exists and is array
      if (!zone.chunk_boundary || !Array.isArray(zone.chunk_boundary)) {
        logger.warn(`❌ ${zoneType} ${zone.name} has invalid chunk_boundary - not an array`, {
          boundaryType: typeof zone.chunk_boundary,
          boundaryValue: zone.chunk_boundary
        });
        return false;
      }

      // Check minimum points for polygon
      if (zone.chunk_boundary.length < 3) {
        logger.warn(`❌ ${zoneType} ${zone.name} has insufficient points: ${zone.chunk_boundary.length}`);
        return false;
      }

      // Validate each point
      for (let i = 0; i < zone.chunk_boundary.length; i++) {
        const point = zone.chunk_boundary[i];
        
        if (!Array.isArray(point) || point.length !== 2) {
          logger.warn(`❌ ${zoneType} ${zone.name} point ${i} is invalid format:`, {
            point,
            isArray: Array.isArray(point),
            length: point?.length
          });
          return false;
        }

        const [x, z] = point;
        if (typeof x !== 'number' || typeof z !== 'number' || !isFinite(x) || !isFinite(z)) {
          logger.warn(`❌ ${zoneType} ${zone.name} point ${i} has invalid coordinates:`, {
            x, z,
            xType: typeof x,
            zType: typeof z,
            xFinite: isFinite(x),
            zFinite: isFinite(z)
          });
          return false;
        }
      }

      logger.info(`✅ ${zoneType} ${zone.name} validation passed`, {
        points: zone.chunk_boundary.length,
        samplePoint: zone.chunk_boundary[0]
      });

      return true;
    } catch (error) {
      logger.warn(`❌ ${zoneType} ${zone.name} validation error: ${error}`);
      return false;
    }
  }

private async preCalculateAllChunks(): Promise<number> {
  logger.info('🧮 DIAGNOSTIC: Starting chunk pre-calculation');
  
  if (!this.calculatorService) {
    logger.error('❌ DIAGNOSTIC: Calculator service is null/undefined');
    return 0;
  }

  logger.info('✅ DIAGNOSTIC: Calculator service is available');

  // Test if methods exist
  logger.info('🔍 DIAGNOSTIC: Checking calculator methods', {
    hasGetChunksInPolygon: typeof this.calculatorService.getChunksInPolygon === 'function',
    hasGetChunksInPolygonOptimized: typeof this.calculatorService.getChunksInPolygonOptimized === 'function',
    hasCalculateChunkZones: typeof this.calculatorService.calculateChunkZones === 'function'
  });

  let totalChunks = 0;
  const batchSize = 500;

  try {
    // Process ALL zones (regions, nodes, cities)
    const allZones = [
      ...this.regions.map(r => ({ ...r, type: 'region' as const })),
      ...this.nodes.map(n => ({ ...n, type: 'node' as const })),
      ...this.cities.map(c => ({ ...c, type: 'city' as const }))
    ];

    logger.info(`🔄 DIAGNOSTIC: Processing ${allZones.length} zones total`, {
      regions: this.regions.length,
      nodes: this.nodes.length,
      cities: this.cities.length
    });

    for (const zone of allZones) {
      try {
        logger.info(`🔄 DIAGNOSTIC: Processing ${zone.type} "${zone.name}"`, {
          id: zone.id,
          boundaryPoints: zone.chunk_boundary?.length || 0,
          samplePoints: zone.chunk_boundary?.slice(0, 3) || []
        });

        // Test polygon validity
        if (!zone.chunk_boundary || !Array.isArray(zone.chunk_boundary)) {
          logger.error(`❌ DIAGNOSTIC: Invalid boundary for ${zone.name}`);
          continue;
        }

        if (zone.chunk_boundary.length < 3) {
          logger.error(`❌ DIAGNOSTIC: Not enough points for ${zone.name}: ${zone.chunk_boundary.length}`);
          continue;
        }

        logger.info(`✅ DIAGNOSTIC: Polygon valid for ${zone.name}, calculating chunks...`);

        let zoneChunks: Array<{ x: number; z: number }> = [];
        
        try {
          // Try basic method first for testing
          logger.info(`🔄 DIAGNOSTIC: Trying getChunksInPolygon for ${zone.name}`);
          zoneChunks = this.calculatorService.getChunksInPolygon(zone.chunk_boundary);
          logger.info(`✅ DIAGNOSTIC: getChunksInPolygon returned ${zoneChunks.length} chunks for ${zone.name}`);
        } catch (error) {
          logger.error(`❌ DIAGNOSTIC: getChunksInPolygon failed for ${zone.name}`, { 
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
          });
          
          try {
            logger.info(`🔄 DIAGNOSTIC: Trying getChunksInPolygonOptimized for ${zone.name}`);
            zoneChunks = this.calculatorService.getChunksInPolygonOptimized(zone.chunk_boundary);
            logger.info(`✅ DIAGNOSTIC: getChunksInPolygonOptimized returned ${zoneChunks.length} chunks for ${zone.name}`);
          } catch (error2) {
            logger.error(`❌ DIAGNOSTIC: Both methods failed for ${zone.name}`, { 
              error: error2 instanceof Error ? error2.message : 'Unknown error' 
            });
            continue;
          }
        }

        if (zoneChunks.length === 0) {
          logger.warn(`⚠️ DIAGNOSTIC: No chunks found for ${zone.type} "${zone.name}" - check polygon validity`);
          continue;
        }

        logger.info(`📊 DIAGNOSTIC: ${zone.type} "${zone.name}" contains ${zoneChunks.length} chunks`);

        // Test chunk calculation with first chunk
        if (zoneChunks.length > 0) {
          const testChunk = zoneChunks[0];
          logger.info(`🧪 DIAGNOSTIC: Testing chunk calculation with chunk ${testChunk.x},${testChunk.z}`);
          
          try {
            const zoneData = this.calculatorService.calculateChunkZones(
              testChunk.x, testChunk.z, 
              this.regions, this.nodes, this.cities
            );
            
            logger.info(`✅ DIAGNOSTIC: Chunk calculation successful`, {
              chunk: `${testChunk.x},${testChunk.z}`,
              regionId: zoneData.regionId,
              nodeId: zoneData.nodeId,
              cityId: zoneData.cityId
            });
          } catch (error) {
            logger.error(`❌ DIAGNOSTIC: Chunk calculation failed`, {
              chunk: `${testChunk.x},${testChunk.z}`,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        }

        // Process only first 10 chunks for testing
        const testChunks = zoneChunks.slice(0, Math.min(10, zoneChunks.length));
        logger.info(`🔄 DIAGNOSTIC: Processing ${testChunks.length} test chunks for ${zone.name}`);

        for (const chunk of testChunks) {
          try {
            const zoneData = this.calculatorService.calculateChunkZones(
              chunk.x, chunk.z, 
              this.regions, this.nodes, this.cities
            );

            if (zoneData.regionId || zoneData.nodeId || zoneData.cityId) {
              await this.redisService.setChunkZone(chunk.x, chunk.z, zoneData);
              totalChunks++;
              logger.debug(`✅ DIAGNOSTIC: Cached chunk ${chunk.x},${chunk.z}`, zoneData);
            } else {
              logger.debug(`⚠️ DIAGNOSTIC: No zone data for chunk ${chunk.x},${chunk.z}`);
            }
          } catch (error) {
            logger.error(`❌ DIAGNOSTIC: Failed to process chunk ${chunk.x},${chunk.z}`, { 
              error: error instanceof Error ? error.message : 'Unknown error' 
            });
          }
        }

        logger.info(`✅ DIAGNOSTIC: ${zone.type} "${zone.name}": ${totalChunks} chunks processed so far`);

      } catch (error) {
        logger.error(`❌ DIAGNOSTIC: Failed to process ${zone.type} "${zone.name}"`, { 
          zoneId: zone.id,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined
        });
      }
    }

    logger.info('✅ DIAGNOSTIC: Chunk pre-calculation completed', {
      totalChunks,
      zonesProcessed: allZones.length
    });

    return totalChunks;

  } catch (error) {
    logger.error('❌ DIAGNOSTIC: Chunk pre-calculation failed', { 
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}

  private async cacheZoneMetadata(): Promise<void> {
    try {
      logger.info('💾 Caching zone metadata in Redis');

      const metadata = {
        regions: this.regions.map(r => ({
          id: r.id,
          name: r.name,
          description: r.description,
          is_active: r.is_active
        })),
        nodes: this.nodes.map(n => ({
          id: n.id,
          name: n.name,
          description: n.description,
          region_id: n.region_id,
          is_active: n.is_active
        })),
        cities: this.cities.map(c => ({
          id: c.id,
          name: c.name,
          description: c.description,
          node_id: c.node_id,
          is_active: c.is_active
        })),
        lastUpdate: new Date().toISOString(),
        totalZones: this.regions.length + this.nodes.length + this.cities.length,
        chunksProcessed: this.stats.chunksProcessed
      };

      // Store metadata with 24h expiration
      await this.redisService.setex('zones:metadata', 86400, JSON.stringify(metadata));

      logger.info('✅ Zone metadata cached successfully', {
        totalZones: metadata.totalZones,
        regions: this.regions.length,
        nodes: this.nodes.length,
        cities: this.cities.length
      });

    } catch (error) {
      logger.error('❌ Failed to cache zone metadata', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ========== REAL-TIME LISTENERS ==========
  private async setupPostgresListener(): Promise<void> {
    try {
      this.postgresListener = await this.databaseService.listenToChanges((notification) => {
        this.handleZoneChange(notification);
      });
      
      logger.info('✅ PostgreSQL zone change listener activated');
    } catch (error) {
      logger.error('❌ Failed to setup PostgreSQL listener', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      // Don't throw - this is not critical for basic functionality
    }
  }

  private async setupRedisKeyspaceListener(): Promise<void> {
    try {
      await this.redisService.subscribeToKeyspaceEvents((uuid, operation) => {
        this.handlePlayerPositionChange(uuid, operation);
      });
      
      this.keyspaceListener = true;
      logger.info('✅ Redis keyspace listener activated for REAL-TIME position tracking');
    } catch (error) {
      logger.error('❌ Failed to setup Redis keyspace listener', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      // Don't throw - this is not critical for basic functionality
    }
  }

  private handleZoneChange(notification: any): void {
    logger.info('🔄 Zone change detected, triggering resync', { notification });
    
    // Trigger zone recalculation asynchronously
    setImmediate(async () => {
      try {
        await this.forceResync();
      } catch (error) {
        logger.error('Failed to handle zone change', { 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    });
  }

  private async handlePlayerPositionChange(uuid: string, operation: string): Promise<void> {
    if (!this.calculatorService || !this.serviceReady) {
      return;
    }

    try {
      // Get player's current position
      const position = await this.redisService.getPlayerPosition(uuid);
      if (!position) return;

      // Calculate zones for current position
      const zoneData = this.calculatorService.calculateChunkZones(
        position.chunk_x, position.chunk_z, 
        this.regions, this.nodes, this.cities
      );

      // Update player zones if any zones found
      if (zoneData.regionId || zoneData.nodeId || zoneData.cityId) {
        await this.redisService.setPlayerZones(uuid, {
          region_id: zoneData.regionId || undefined,
          node_id: zoneData.nodeId || undefined,
          city_id: zoneData.cityId || undefined,
          last_update: Date.now()
        });

        // Publish zone events (implementation depends on your event system)
        await this.publishZoneEvents(uuid, zoneData);
      }

    } catch (error) {
      logger.error('Failed to handle player position change', { 
        uuid, 
        operation,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  private async publishZoneEvents(uuid: string, zoneData: ChunkZoneData): Promise<void> {
    try {
      // Get previous zones to detect changes
      const previousZones = await this.redisService.getPlayerZones(uuid);
      
      // Compare and publish enter/leave events
      if (previousZones) {
        // Check for zone changes and publish appropriate events
        if (previousZones.region_id !== zoneData.regionId) {
          // Region change logic
        }
        if (previousZones.node_id !== zoneData.nodeId) {
          // Node change logic
        }
        if (previousZones.city_id !== zoneData.cityId) {
          // City change logic
        }
      }

      logger.debug('Zone events processed', { uuid, zoneData });
    } catch (error) {
      logger.error('Failed to publish zone events', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  // ========== PUBLIC API METHODS ==========
  async forceResync(): Promise<void> {
    logger.info('🔄 Starting forced resynchronization');
    await this.performFullSync();
  }

  async forceFreshSync(): Promise<void> {
    logger.info('🔄 Starting forced fresh synchronization');
    
    // Clear Redis cache before sync
    try {
      await this.redisService.del('zones:metadata');
      const chunkKeys = await this.redisService.keys('chunk:zone:*');
      if (chunkKeys.length > 0) {
        await this.redisService.del(chunkKeys);
      }
      logger.info('✅ Redis cache cleared for fresh sync');
    } catch (error) {
      logger.warn('Failed to clear Redis cache', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }

    await this.performFullSync();
  }

  async performCleanup(): Promise<{
    deletedChunks: number;
    deletedPlayers: number;
    cacheCleared: boolean;
    errors: string[];
  }> {
    logger.info('🧹 Starting cleanup process');
    const errors: string[] = [];
    let deletedChunks = 0;
    let deletedPlayers = 0;
    let cacheCleared = false;

    try {
      // Clean expired Redis data
      const cleanup = await this.redisService.cleanupExpiredData();
      deletedChunks = cleanup.deletedChunks;
      deletedPlayers = cleanup.deletedPlayers;

      // Clear zone metadata cache
      try {
        await this.redisService.del('zones:metadata');
        cacheCleared = true;
      } catch (error) {
        errors.push('Failed to clear metadata cache');
      }

      logger.info('✅ Cleanup completed', {
        deletedChunks,
        deletedPlayers,
        cacheCleared,
        errors: errors.length
      });

      return {
        deletedChunks,
        deletedPlayers,
        cacheCleared,
        errors
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(errorMsg);
      logger.error('❌ Cleanup failed', { error: errorMsg });
      
      return {
        deletedChunks,
        deletedPlayers,
        cacheCleared,
        errors
      };
    }
  }

  // ========== STATUS AND MONITORING ==========
  isReady(): boolean {
    return this.serviceReady;
  }

  getLastSyncTime(): Date | null {
    return this.lastSyncTime;
  }

  isSyncInProgress(): boolean {
    return this.syncInProgress;
  }

  async getHealthStatus(): Promise<HealthStatus> {
    const issues: string[] = [];
    
    // Check service status
    if (!this.serviceReady) {
      issues.push('Service not initialized');
    }

    // Check Redis connection
    const redisHealthy = await this.redisService.ping().catch(() => false);
    if (!redisHealthy) {
      issues.push('Redis connection failed');
    }

    // Check last sync time
    if (this.lastSyncTime && Date.now() - this.lastSyncTime.getTime() > 24 * 60 * 60 * 1000) {
      issues.push('Last sync more than 24 hours ago');
    }

    // Check if zones are loaded
    if (this.regions.length === 0 && this.nodes.length === 0 && this.cities.length === 0) {
      issues.push('No zones loaded');
    }

    return {
      isHealthy: issues.length === 0,
      lastSync: this.lastSyncTime,
      syncInProgress: this.syncInProgress,
      issues,
      services: {
        redis: redisHealthy,
        database: true, // Assume healthy if we got this far
        calculator: !!this.calculatorService
      }
    };
  }

  async getDetailedStats(): Promise<{
    service: ZoneSyncStats;
    zones: {
      regions: number;
      nodes: number;
      cities: number;
      total: number;
    };
    redis: any;
    database: any;
  }> {
    try {
      const [redisStats, dbStats] = await Promise.all([
        this.redisService.getStats().catch(() => ({ error: 'Redis stats unavailable' })),
        this.databaseService.getZoneStats().catch(() => ({ error: 'Database stats unavailable' }))
      ]);

      this.updateStats();

      return {
        service: this.stats,
        zones: {
          regions: this.regions.length,
          nodes: this.nodes.length,
          cities: this.cities.length,
          total: this.regions.length + this.nodes.length + this.cities.length
        },
        redis: redisStats,
        database: dbStats
      };
    } catch (error) {
      logger.error('Failed to get detailed stats', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private updateStats(): void {
    this.stats = {
      isReady: this.serviceReady,
      lastSyncTime: this.lastSyncTime,
      syncInProgress: this.syncInProgress,
      zonesLoaded: this.regions.length + this.nodes.length + this.cities.length,
      chunksProcessed: this.stats.chunksProcessed,
      errors: this.stats.errors,
      performance: this.stats.performance
    };
  }

  // ========== ZONE QUERY METHODS ==========
  async getZonesForChunk(chunkX: number, chunkZ: number): Promise<ChunkZoneData | null> {
    try {
      // Try Redis cache first
      const cached = await this.redisService.getChunkZone(chunkX, chunkZ);
      if (cached) {
        return cached;
      }

      // Calculate in real-time if not cached
      if (this.calculatorService && this.serviceReady) {
        return this.calculatorService.calculateChunkZones(
          chunkX, chunkZ,
          this.regions, this.nodes, this.cities
        );
      }

      return null;
    } catch (error) {
      logger.error('Failed to get zones for chunk', { 
        chunkX, 
        chunkZ, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return null;
    }
  }

  async getZonesForWorldCoordinates(x: number, z: number): Promise<ChunkZoneData | null> {
    const chunkX = Math.floor(x / 16);
    const chunkZ = Math.floor(z / 16);
    return this.getZonesForChunk(chunkX, chunkZ);
  }

  // ========== CLEANUP ==========
  async destroy(): Promise<void> {
    try {
      logger.info('🛑 Shutting down ZoneSyncService');
      
      this.serviceReady = false;
      this.keyspaceListener = false;
      
      // Close PostgreSQL listener
      if (this.postgresListener) {
        this.postgresListener.release();
        this.postgresListener = null;
        logger.info('✅ PostgreSQL listener closed');
      }
      
      // Clear cached data
      this.regions = [];
      this.nodes = [];
      this.cities = [];
      
      logger.info('✅ ZoneSyncService shutdown completed');
    } catch (error) {
      logger.error('❌ Error during ZoneSyncService shutdown', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }
}