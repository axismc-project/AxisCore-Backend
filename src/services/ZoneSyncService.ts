import { RedisService } from './RedisService';
import { DatabaseService } from './DatabaseService';
import { ChunkCalculatorService } from './ChunkCalculatorService';
import { DatabaseBatchService } from './DatabaseBatchService';
import { ZoneTransitionDetector } from './ZoneTransitionDetector';
import { Region, Node, City, ChunkZoneData } from '../models/Zone';
import { logger } from '../utils/logger';

interface ZoneSyncStats {
  isReady: boolean;
  lastSyncTime: Date | null;
  syncInProgress: boolean;
  zonesLoaded: number;
  chunksProcessed: number;
  errors: number;
  transitionsDetected: number;
  cacheCorrections: number;
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
    transitionDetector: boolean;
  };
}

export class ZoneSyncService {
  private serviceReady = false;
  private lastSyncTime: Date | null = null;
  private syncInProgress = false;
  private postgresListener: any = null;
  private keyspaceListener: boolean = false;
  
  // Services
  private transitionDetector: ZoneTransitionDetector;
  
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
    transitionsDetected: 0,
    cacheCorrections: 0,
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
    this.transitionDetector = new ZoneTransitionDetector();
    logger.info('🚀 ZoneSyncService initialized with optimized transition detection');
  }

  // ========== INITIALIZATION ==========
  
  async init(): Promise<void> {
    if (this.serviceReady) {
      logger.warn('ZoneSyncService already initialized');
      return;
    }

    try {
      logger.info('🚀 Initializing ZoneSyncService with smart filtering');
      
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
      
      logger.info('✅ ZoneSyncService ready with smart transition detection', {
        regions: this.regions.length,
        nodes: this.nodes.length,
        cities: this.cities.length,
        features: [
          'Smart transition detection',
          'Cache corruption prevention',
          'Wilderness filtering',
          'Enter/leave only events'
        ]
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
      
      logger.info('✅ Full synchronization completed', {
        durationMs: duration,
        regions: this.regions.length,
        nodes: this.nodes.length,
        cities: this.cities.length,
        chunksProcessed,
        errors
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
      if (!zone.chunk_boundary || !Array.isArray(zone.chunk_boundary)) {
        logger.warn(`❌ ${zoneType} ${zone.name} has invalid chunk_boundary`);
        return false;
      }

      if (zone.chunk_boundary.length < 3) {
        logger.warn(`❌ ${zoneType} ${zone.name} has insufficient points: ${zone.chunk_boundary.length}`);
        return false;
      }

      for (let i = 0; i < zone.chunk_boundary.length; i++) {
        const point = zone.chunk_boundary[i];
        
        if (!Array.isArray(point) || point.length !== 2) {
          logger.warn(`❌ ${zoneType} ${zone.name} point ${i} is invalid format`);
          return false;
        }

        const [x, z] = point;
        if (typeof x !== 'number' || typeof z !== 'number' || !isFinite(x) || !isFinite(z)) {
          logger.warn(`❌ ${zoneType} ${zone.name} point ${i} has invalid coordinates`);
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.warn(`❌ ${zoneType} ${zone.name} validation error: ${error}`);
      return false;
    }
  }

  private async preCalculateAllChunks(): Promise<number> {
    if (!this.calculatorService) {
      logger.warn('Calculator service not available');
      return 0;
    }

    logger.info('🧮 Starting chunk pre-calculation for all zones');

    let totalChunks = 0;
    const batchSize = 500;

    try {
      const allZones = [
        ...this.regions.map(r => ({ ...r, type: 'region' as const })),
        ...this.nodes.map(n => ({ ...n, type: 'node' as const })),
        ...this.cities.map(c => ({ ...c, type: 'city' as const }))
      ];

      logger.info(`🔄 Processing ${allZones.length} zones`);

      for (const zone of allZones) {
        try {
          let zoneChunks: Array<{ x: number; z: number }> = [];
          
          try {
            zoneChunks = this.calculatorService.getChunksInPolygonOptimized(zone.chunk_boundary);
          } catch (error) {
            logger.warn(`Optimized method failed for ${zone.name}, trying basic method`);
            zoneChunks = this.calculatorService.getChunksInPolygon(zone.chunk_boundary);
          }

          if (zoneChunks.length === 0) {
            logger.warn(`⚠️ No chunks found for ${zone.type} "${zone.name}"`);
            continue;
          }

          let zoneChunksProcessed = 0;
          for (let i = 0; i < zoneChunks.length; i += batchSize) {
            const batch = zoneChunks.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (chunk) => {
              try {
                const zoneData = this.calculatorService!.calculateChunkZones(
                  chunk.x, chunk.z, 
                  this.regions, this.nodes, this.cities
                );

                if (zoneData.regionId || zoneData.nodeId || zoneData.cityId) {
                  await this.redisService.setChunkZone(chunk.x, chunk.z, zoneData);
                  return 1;
                }
                return 0;
              } catch (error) {
                return 0;
              }
            });

            const batchResults = await Promise.allSettled(batchPromises);
            const batchCount = batchResults
              .filter(result => result.status === 'fulfilled')
              .reduce((sum, result) => sum + (result as PromiseFulfilledResult<number>).value, 0);

            zoneChunksProcessed += batchCount;
            totalChunks += batchCount;
          }

          logger.debug(`✅ ${zone.type} "${zone.name}": ${zoneChunksProcessed} chunks cached`);

        } catch (error) {
          logger.error(`❌ Failed to process ${zone.type} "${zone.name}"`, { 
            zoneId: zone.id,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      logger.info('✅ Chunk pre-calculation completed', {
        totalChunks,
        zonesProcessed: allZones.length
      });

      return totalChunks;

    } catch (error) {
      logger.error('❌ Chunk pre-calculation failed', { 
        error: error instanceof Error ? error.message : 'Unknown error'
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

      await this.redisService.setex('zones:metadata', 86400, JSON.stringify(metadata));
      logger.info('✅ Zone metadata cached successfully');

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
    }
  }

  private async setupRedisKeyspaceListener(): Promise<void> {
    try {
      logger.info('🔧 Setting up Redis keyspace listener...');
      
      await this.redisService.subscribeToKeyspaceEvents((uuid, operation) => {
        logger.debug('🔔 Keyspace event received', { uuid, operation });
        
        setImmediate(async () => {
          try {
            await this.handlePlayerPositionChange(uuid, operation);
          } catch (error) {
            logger.error('Error in position change handler', {
              uuid,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        });
      });
      
      this.keyspaceListener = true;
      logger.info('✅ Redis keyspace listener activated');
    } catch (error) {
      logger.error('❌ Failed to setup Redis keyspace listener', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  private handleZoneChange(notification: any): void {
    logger.info('🔄 Zone change detected, triggering resync', { notification });
    
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

  // ========== 🎯 MÉTHODE PRINCIPALE OPTIMISÉE ==========

private async handlePlayerPositionChange(uuid: string, operation: string): Promise<void> {
  if (!this.calculatorService || !this.serviceReady) {
    logger.info('⚠️ SERVICE NOT READY', { 
      uuid, 
      operation,
      calculatorService: !!this.calculatorService,
      serviceReady: this.serviceReady
    });
    return;
  }

  try {
    logger.info('🔄 POSITION CHANGE START', { 
      uuid, 
      operation,
      timestamp: Date.now()
    });

    // 1. Récupérer les données actuelles
    const [previousZones, chunkData] = await Promise.all([
      this.redisService.getPlayerZones(uuid),
      this.redisService.getPlayerChunk(uuid)
    ]);

    logger.info('📊 DATA RETRIEVED', {
      uuid,
      previousZones: previousZones ? {
        regionId: previousZones.region_id,
        nodeId: previousZones.node_id,
        cityId: previousZones.city_id,
        lastUpdate: new Date(previousZones.last_update).toISOString()
      } : null,
      chunkData: chunkData ? {
        chunkX: chunkData.chunk_x,
        chunkZ: chunkData.chunk_z,
        timestamp: new Date(chunkData.timestamp).toISOString()
      } : null
    });

    if (!chunkData) {
      logger.info('❌ NO CHUNK DATA - Player disconnected?', { uuid });
      return;
    }

    // 2. Calculer les zones actuelles
    const currentZoneData = this.calculatorService.calculateChunkZones(
      chunkData.chunk_x, chunkData.chunk_z, 
      this.regions, this.nodes, this.cities
    );

    logger.info('🧮 ZONES CALCULATED', {
      uuid,
      chunk: `${chunkData.chunk_x},${chunkData.chunk_z}`,
      calculatedZones: {
        regionId: currentZoneData.regionId,
        regionName: currentZoneData.regionName,
        nodeId: currentZoneData.nodeId,
        nodeName: currentZoneData.nodeName,
        cityId: currentZoneData.cityId,
        cityName: currentZoneData.cityName
      },
      isWilderness: !currentZoneData.regionId && !currentZoneData.nodeId && !currentZoneData.cityId
    });

    // 3. Vérifier la cohérence du cache
    const cacheCoherent = this.isCacheCoherent(previousZones, currentZoneData);
    
    logger.info('🔍 CACHE COHERENCE CHECK', {
      uuid,
      cacheCoherent,
      comparison: {
        region: `${previousZones?.region_id || 'null'} === ${currentZoneData.regionId || 'null'}`,
        node: `${previousZones?.node_id || 'null'} === ${currentZoneData.nodeId || 'null'}`,
        city: `${previousZones?.city_id || 'null'} === ${currentZoneData.cityId || 'null'}`
      }
    });

    if (!cacheCoherent) {
      logger.info('🧹 CACHE CORRECTION NEEDED', {
        uuid,
        chunk: `${chunkData.chunk_x},${chunkData.chunk_z}`,
        cached: this.formatCachedZones(previousZones),
        reality: this.transitionDetector.zonesToString(currentZoneData),
        action: 'Correcting cache without events'
      });

      await this.correctPlayerCache(uuid, currentZoneData);
      this.stats.cacheCorrections++;
      return;
    }

    // 4. Détection de transitions
    const previousZoneData: ChunkZoneData | null = previousZones ? {
      regionId: previousZones.region_id || null,
      regionName: null,
      nodeId: previousZones.node_id || null,
      nodeName: null,
      cityId: previousZones.city_id || null,
      cityName: null
    } : null;

    logger.info('🎯 CALLING TRANSITION DETECTOR', {
      uuid,
      previousZoneData,
      currentZoneData,
      aboutToCallDetector: true
    });

    const transition = this.transitionDetector.detectTransitions(
      uuid,
      previousZoneData,
      currentZoneData
    );

    logger.info('📋 TRANSITION DETECTOR RESULT', {
      uuid,
      hasTransition: !!transition,
      transition: transition ? {
        transitionsCount: Object.keys(transition.transitions).length,
        transitions: transition.transitions
      } : null
    });

    // 5. Pas de transition → mise à jour silencieuse
    if (!transition) {
      logger.info('🔄 SILENT UPDATE - No transitions', { uuid });
      await this.updatePlayerCacheSilently(uuid, currentZoneData);
      await this.syncPlayerToDatabaseSilently(uuid, chunkData, currentZoneData);
      return;
    }

    // 6. Transition détectée → publier les événements
    logger.info('🎉 TRANSITION DETECTED - BROADCASTING', {
      uuid,
      transitionsCount: Object.keys(transition.transitions).length,
      from: this.transitionDetector.zonesToString(transition.previousZones),
      to: this.transitionDetector.zonesToString(transition.currentZones),
      willBroadcast: true
    });

    await this.updatePlayerCache(uuid, currentZoneData);
    await this.publishTransitionEvents(transition);
    await this.syncPlayerToDatabase(uuid, chunkData, currentZoneData);

    this.stats.transitionsDetected++;

  } catch (error) {
    logger.error('❌ POSITION CHANGE ERROR', { 
      uuid, 
      operation,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
  }
}

  // ========== MÉTHODES UTILITAIRES ==========

  /**
   * Vérifie si le cache Redis est cohérent avec la réalité calculée
   */
  private isCacheCoherent(cachedZones: any, realityZones: ChunkZoneData): boolean {
    if (!cachedZones) {
      // Pas de cache = cohérent si wilderness
      return !realityZones.regionId && !realityZones.nodeId && !realityZones.cityId;
    }

    return (cachedZones.region_id || null) === (realityZones.regionId || null) &&
           (cachedZones.node_id || null) === (realityZones.nodeId || null) &&
           (cachedZones.city_id || null) === (realityZones.cityId || null);
  }

  /**
   * Corrige le cache sans générer d'événements
   */
  private async correctPlayerCache(uuid: string, correctZoneData: ChunkZoneData): Promise<void> {
    try {
      const zones = {
        region_id: correctZoneData.regionId || undefined,
        node_id: correctZoneData.nodeId || undefined,
        city_id: correctZoneData.cityId || undefined,
        last_update: Date.now()
      };

      await this.redisService.setPlayerZones(uuid, zones);
      
      logger.debug('✅ Cache corrected', { 
        uuid, 
        correctedZones: zones
      });

    } catch (error) {
      logger.error('Failed to correct player cache', {
        uuid,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Met à jour le cache silencieusement (sans événements)
   */
  private async updatePlayerCacheSilently(uuid: string, zoneData: ChunkZoneData): Promise<void> {
    try {
      const zones = {
        region_id: zoneData.regionId || undefined,
        node_id: zoneData.nodeId || undefined,
        city_id: zoneData.cityId || undefined,
        last_update: Date.now()
      };

      await this.redisService.setPlayerZones(uuid, zones);

    } catch (error) {
      logger.error('Failed to update player cache silently', {
        uuid,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Met à jour le cache (pour les vraies transitions)
   */
  private async updatePlayerCache(uuid: string, zoneData: ChunkZoneData): Promise<void> {
    try {
      const zones = {
        region_id: zoneData.regionId || undefined,
        node_id: zoneData.nodeId || undefined,
        city_id: zoneData.cityId || undefined,
        last_update: Date.now()
      };

      await this.redisService.setPlayerZones(uuid, zones);

    } catch (error) {
      logger.error('Failed to update player cache', {
        uuid,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Publie les événements de transition via Redis
   */
  private async publishTransitionEvents(transition: any): Promise<void> {
    try {
      const { transitions, playerUuid } = transition;

      for (const [zoneType, transitionData] of Object.entries(transitions)) {
        if (transitionData && typeof transitionData === 'object') {
          const event = {
            playerUuid,
            zoneType: zoneType as 'region' | 'node' | 'city',
            zoneId: (transitionData as any).zoneId,
            zoneName: (transitionData as any).zoneName,
            eventType: (transitionData as any).type as 'enter' | 'leave',
            timestamp: Date.now()
          };

          await this.redisService.publishZoneEvent(event);
          
          logger.debug('📤 Event published', {
            playerUuid,
            event: `${zoneType}_${event.eventType}`,
            zoneName: event.zoneName
          });
        }
      }
    } catch (error) {
      logger.error('❌ Failed to publish transition events', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Synchronise vers la base de données silencieusement
   */
  private async syncPlayerToDatabaseSilently(uuid: string, chunkData: any, zoneData: ChunkZoneData): Promise<void> {
    if (!this.batchService) return;

    try {
      const playerName = await this.getPlayerName(uuid);
      const positionData = await this.redisService.getPlayerPosition(uuid);
      
      this.batchService.queuePlayerUpdate({
        uuid,
        name: playerName,
        x: positionData ? positionData.x : chunkData.chunk_x * 16,
        y: positionData ? positionData.y : 64,
        z: positionData ? positionData.z : chunkData.chunk_z * 16,
        chunkX: chunkData.chunk_x,
        chunkZ: chunkData.chunk_z,
        regionId: zoneData.regionId || undefined,
        nodeId: zoneData.nodeId || undefined,
        cityId: zoneData.cityId || undefined
      });
      
    } catch (error) {
      logger.error('Failed to sync player to database silently', {
        uuid,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Synchronise vers la base de données (pour les vraies transitions)
   */
  private async syncPlayerToDatabase(uuid: string, chunkData: any, zoneData: ChunkZoneData): Promise<void> {
    if (!this.batchService) return;

    try {
      const playerName = await this.getPlayerName(uuid);
      const positionData = await this.redisService.getPlayerPosition(uuid);
      
      this.batchService.queuePlayerUpdate({
        uuid,
        name: playerName,
        x: positionData ? positionData.x : chunkData.chunk_x * 16,
        y: positionData ? positionData.y : 64,
        z: positionData ? positionData.z : chunkData.chunk_z * 16,
        chunkX: chunkData.chunk_x,
        chunkZ: chunkData.chunk_z,
        regionId: zoneData.regionId || undefined,
        nodeId: zoneData.nodeId || undefined,
        cityId: zoneData.cityId || undefined
      });
      
    } catch (error) {
      logger.error('Failed to sync player to database', {
        uuid,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Récupère le nom du joueur
   */
  private async getPlayerName(uuid: string): Promise<string> {
    try {
      const player = await this.databaseService.getPlayerByUuid(uuid);
      if (player?.player_name) {
        return player.player_name;
      }
      return `Player_${uuid.substring(0, 8)}`;
    } catch (error) {
      return `Player_${uuid.substring(0, 8)}`;
    }
  }

  /**
   * Formate les zones en cache pour les logs
   */
  private formatCachedZones(cachedZones: any): string {
    if (!cachedZones) return 'none';
    
    const parts: string[] = [];
    if (cachedZones.region_id) parts.push(`R${cachedZones.region_id}`);
    if (cachedZones.node_id) parts.push(`N${cachedZones.node_id}`);
    if (cachedZones.city_id) parts.push(`C${cachedZones.city_id}`);
    
    return parts.length > 0 ? parts.join('→') : 'wilderness';
  }

  // ========== PUBLIC API METHODS ==========

  async forceResync(): Promise<void> {
    logger.info('🔄 Starting forced resynchronization');
    await this.performFullSync();
  }

  async forceFreshSync(): Promise<void> {
    logger.info('🔄 Starting forced fresh synchronization');
    
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
      const cleanup = await this.redisService.cleanupExpiredData();
      deletedChunks = cleanup.deletedChunks;
      deletedPlayers = cleanup.deletedPlayers;

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
    
    if (!this.serviceReady) {
      issues.push('Service not initialized');
    }

    const redisHealthy = await this.redisService.ping().catch(() => false);
    if (!redisHealthy) {
      issues.push('Redis connection failed');
    }
    if (this.lastSyncTime && Date.now() - this.lastSyncTime.getTime() > 24 * 60 * 60 * 1000) {
     issues.push('Last sync more than 24 hours ago');
   }

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
       database: true,
       calculator: !!this.calculatorService,
       transitionDetector: !!this.transitionDetector
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
     transitionsDetected: this.stats.transitionsDetected,
     cacheCorrections: this.stats.cacheCorrections,
     performance: this.stats.performance
   };
 }

 // ========== ZONE QUERY METHODS ==========

 async getZonesForChunk(chunkX: number, chunkZ: number): Promise<ChunkZoneData | null> {
   try {
     const cached = await this.redisService.getChunkZone(chunkX, chunkZ);
     if (cached) {
       return cached;
     }

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

 // ========== DEBUG METHODS ==========

 async debugPlayerState(uuid: string): Promise<void> {
   try {
     logger.info('🔍 DEBUGGING PLAYER STATE', { uuid });
     
     const [zones, chunk, position] = await Promise.all([
       this.redisService.getPlayerZones(uuid),
       this.redisService.getPlayerChunk(uuid),
       this.redisService.getPlayerPosition(uuid)
     ]);

     logger.info('📊 CURRENT REDIS CACHE', {
       uuid,
       zones: zones ? {
         regionId: zones.region_id,
         nodeId: zones.node_id,
         cityId: zones.city_id,
         lastUpdate: new Date(zones.last_update)
       } : null,
       chunk: chunk ? `${chunk.chunk_x},${chunk.chunk_z}` : null,
       position: position ? `${position.x},${position.y},${position.z}` : null
     });

     if (chunk && this.calculatorService) {
       const realityZones = this.calculatorService.calculateChunkZones(
         chunk.chunk_x, chunk.chunk_z,
         this.regions, this.nodes, this.cities
       );

       logger.info('🧮 CALCULATED ZONES (REALITY)', {
         uuid,
         chunk: `${chunk.chunk_x},${chunk.chunk_z}`,
         reality: {
           regionId: realityZones.regionId,
           nodeId: realityZones.nodeId,
           cityId: realityZones.cityId
         },
         cacheVsReality: {
           regionMatch: (zones?.region_id || null) === (realityZones.regionId || null),
           nodeMatch: (zones?.node_id || null) === (realityZones.nodeId || null),
           cityMatch: (zones?.city_id || null) === (realityZones.cityId || null)
         }
       });
     }

   } catch (error) {
     logger.error('Failed to debug player state', {
       uuid,
       error: error instanceof Error ? error.message : 'Unknown error'
     });
   }
 }

 // ========== CLEANUP ==========

 async destroy(): Promise<void> {
   try {
     logger.info('🛑 Shutting down ZoneSyncService');
     
     this.serviceReady = false;
     this.keyspaceListener = false;
     
     if (this.postgresListener) {
       this.postgresListener.release();
       this.postgresListener = null;
       logger.info('✅ PostgreSQL listener closed');
     }
     
     this.regions = [];
     this.nodes = [];
     this.cities = [];
     
     logger.info('✅ ZoneSyncService shutdown completed', {
       finalStats: {
         transitionsDetected: this.stats.transitionsDetected,
         cacheCorrections: this.stats.cacheCorrections,
         totalZonesProcessed: this.stats.zonesLoaded,
         totalChunksProcessed: this.stats.chunksProcessed
       }
     });
   } catch (error) {
     logger.error('❌ Error during ZoneSyncService shutdown', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
   }
 }
}