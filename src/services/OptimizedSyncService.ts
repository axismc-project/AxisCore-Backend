// src/services/OptimizedSyncService.ts
import { RedisService } from './RedisService';
import { DatabaseService } from './DatabaseService';
import { ChunkCalculatorService } from './ChunkCalculatorService';
import { ZoneTransitionDetector } from './ZoneTransitionDetector';
import { Region, Node, City, ChunkZoneData } from '../models/Zone';
import { logger } from '../utils/logger';

interface SyncQueueItem {
  id: string;
  type: 'player_position' | 'chunk_calculation' | 'zone_update' | 'database_sync';
  priority: number; // 1 = highest, 5 = lowest
  data: any;
  attempts: number;
  maxAttempts: number;
  lastAttempt: number;
  createdAt: number;
}

interface SyncStats {
  isReady: boolean;
  lastFullSync: Date | null;
  lastRedisToDbSync: Date | null;
  lastDbToRedisSync: Date | null;
  pendingItems: number;
  processedItems: number;
  errors: number;
  retries: number;
  performance: {
    avgProcessingTime: number;
    chunksCalculated: number;
    playersSync: number;
    transitionsDetected: number;
  };
}

export class OptimizedSyncService {
  private serviceReady = false;
  private syncQueue: SyncQueueItem[] = [];
  private isProcessingQueue = false;
  private queueProcessor: NodeJS.Timeout | null = null;
  private periodicSync: NodeJS.Timeout | null = null;
  private postgresListener: any = null;
  
  // Cached zone data
  private regions: Region[] = [];
  private nodes: Node[] = [];
  private cities: City[] = [];
  
  // Statistics
  private stats: SyncStats = {
    isReady: false,
    lastFullSync: null,
    lastRedisToDbSync: null,
    lastDbToRedisSync: null,
    pendingItems: 0,
    processedItems: 0,
    errors: 0,
    retries: 0,
    performance: {
      avgProcessingTime: 0,
      chunksCalculated: 0,
      playersSync: 0,
      transitionsDetected: 0
    }
  };

  constructor(
    private databaseService: DatabaseService,
    private redisService: RedisService,
    private calculatorService: ChunkCalculatorService,
    private transitionDetector: ZoneTransitionDetector
  ) {
    logger.info('🚀 OptimizedSyncService initialized');
  }

  // ========== INITIALIZATION ==========
  
  async init(): Promise<void> {
    try {
      logger.info('🔧 Initializing OptimizedSyncService...');
      
      // 1. Load zones from database
      await this.loadZonesFromDatabase();
      
      // 2. Perform initial chunk calculation
      await this.performInitialChunkCalculation();
      
      // 3. Setup bidirectional synchronization
      await this.setupBidirectionalSync();
      
      // 4. Start queue processor
      this.startQueueProcessor();
      
      // 5. Setup periodic sync
      this.startPeriodicSync();
      
      // 6. Setup PostgreSQL listener
      await this.setupPostgresListener();
      
      this.serviceReady = true;
      this.stats.isReady = true;
      this.stats.lastFullSync = new Date();
      
      logger.info('✅ OptimizedSyncService ready', {
        regions: this.regions.length,
        nodes: this.nodes.length,
        cities: this.cities.length,
        chunksCalculated: this.stats.performance.chunksCalculated
      });
      
    } catch (error) {
      logger.error('❌ Failed to initialize OptimizedSyncService', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      this.serviceReady = false;
      throw error;
    }
  }

  // ========== ZONE LOADING ==========
  
  private async loadZonesFromDatabase(): Promise<void> {
    try {
      logger.info('📊 Loading zones from database...');

      const [regions, nodes, cities] = await Promise.all([
        this.databaseService.getAllRegions(),
        this.databaseService.getAllNodes(),
        this.databaseService.getAllCities()
      ]);

      this.regions = regions.filter(r => this.validateZoneData(r, 'region'));
      this.nodes = nodes.filter(n => this.validateZoneData(n, 'node'));
      this.cities = cities.filter(c => this.validateZoneData(c, 'city'));

      logger.info('✅ Zones loaded and validated', {
        regions: this.regions.length,
        nodes: this.nodes.length,
        cities: this.cities.length
      });

    } catch (error) {
      logger.error('❌ Failed to load zones from database', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private validateZoneData(zone: any, type: string): boolean {
    try {
      if (!zone.chunk_boundary || !Array.isArray(zone.chunk_boundary)) {
        logger.warn(`Invalid ${type} zone: missing or invalid chunk_boundary`, { 
          zoneId: zone.id, 
          zoneName: zone.name 
        });
        return false;
      }

      if (zone.chunk_boundary.length < 3) {
        logger.warn(`Invalid ${type} zone: insufficient polygon points`, { 
          zoneId: zone.id, 
          points: zone.chunk_boundary.length 
        });
        return false;
      }

      return true;
    } catch (error) {
      logger.warn(`Error validating ${type} zone`, { 
        zoneId: zone.id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // ========== CHUNK CALCULATION ==========
  
  private async performInitialChunkCalculation(): Promise<void> {
    logger.info('🧮 Starting optimized chunk calculation...');
    
    const startTime = Date.now();
    let totalChunks = 0;
    
    try {
      // Clear existing chunk cache
      const existingChunks = await this.redisService.keys('chunk:zone:*');
      if (existingChunks.length > 0) {
        logger.info(`🧹 Clearing ${existingChunks.length} existing chunk entries`);
        await this.redisService.del(existingChunks);
      }
      
      // Process zones in batches
      const allZones = [
        ...this.regions.map(r => ({ ...r, type: 'region' as const })),
        ...this.nodes.map(n => ({ ...n, type: 'node' as const })),
        ...this.cities.map(c => ({ ...c, type: 'city' as const }))
      ];
      
      logger.info(`🔄 Processing ${allZones.length} zones for chunk calculation`);
      
      for (const zone of allZones) {
        try {
          const chunks = this.calculatorService.getChunksInPolygonOptimized(zone.chunk_boundary);
          
          // Queue chunk calculations in batches
          const batchSize = 500;
          for (let i = 0; i < chunks.length; i += batchSize) {
            const batchChunks = chunks.slice(i, i + batchSize);
            
            this.addToQueue({
              id: `chunk_calc_${zone.type}_${zone.id}_${i}`,
              type: 'chunk_calculation',
              priority: 3,
              data: { chunks: batchChunks, zone },
              attempts: 0,
              maxAttempts: 3,
              lastAttempt: 0,
              createdAt: Date.now()
            });
          }
          
          totalChunks += chunks.length;
          
          logger.debug(`✅ Zone "${zone.name}" (${zone.type}): ${chunks.length} chunks queued`);
          
        } catch (error) {
          logger.error(`❌ Failed to process zone "${zone.name}"`, { 
            zoneId: zone.id,
            zoneType: zone.type,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
      
      const duration = Date.now() - startTime;
      this.stats.performance.chunksCalculated = totalChunks;
      
      logger.info('✅ Chunk calculation queued', {
        totalChunks,
        zonesProcessed: allZones.length,
        durationMs: duration,
        queuedItems: this.syncQueue.length
      });
      
    } catch (error) {
      logger.error('❌ Chunk calculation failed', { 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  // ========== BIDIRECTIONAL SYNC SETUP ==========
  
  private async setupBidirectionalSync(): Promise<void> {
    try {
      logger.info('🔄 Setting up bidirectional synchronization...');
      
      // Redis → Database sync (keyspace notifications)
      await this.setupRedisToDbSync();
      
      // Database → Redis sync (PostgreSQL triggers)
      await this.setupDbToRedisSync();
      
      logger.info('✅ Bidirectional sync configured');
      
    } catch (error) {
      logger.error('❌ Failed to setup bidirectional sync', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async setupRedisToDbSync(): Promise<void> {
    try {
      await this.redisService.subscribeToKeyspaceEvents((uuid, operation) => {
        logger.debug('🔔 Redis keyspace event', { uuid, operation });
        
        this.addToQueue({
          id: `redis_sync_${uuid}_${Date.now()}`,
          type: 'player_position',
          priority: 1, // High priority
          data: { uuid, operation },
          attempts: 0,
          maxAttempts: 3,
          lastAttempt: 0,
          createdAt: Date.now()
        });
      });
      
      logger.info('✅ Redis → Database sync activated');
      
    } catch (error) {
      logger.error('❌ Failed to setup Redis → Database sync', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async setupDbToRedisSync(): Promise<void> {
    try {
      // Initial sync from database to Redis
      await this.performDatabaseToRedisSync();
      
      logger.info('✅ Database → Redis initial sync completed');
      
    } catch (error) {
      logger.error('❌ Failed to setup Database → Redis sync', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private async performDatabaseToRedisSync(): Promise<void> {
    try {
      logger.info('🔄 Syncing database players to Redis...');
      
      const onlinePlayers = await this.databaseService.getAllOnlinePlayers();
      let syncedCount = 0;
      
      for (const player of onlinePlayers) {
        try {
          // Use server_uuid for Redis keys
          await this.redisService.setPlayerPosition(player.server_uuid, {
            x: player.x,
            y: player.y,
            z: player.z,
            chunk_x: player.chunk_x,
            chunk_z: player.chunk_z,
            timestamp: player.last_updated.getTime()
          });

          // Set zones if they exist
          if (player.region_id !== null || player.node_id !== null || player.city_id !== null) {
            await this.redisService.setPlayerZones(player.server_uuid, {
              region_id: player.region_id,
              node_id: player.node_id,
              city_id: player.city_id,
              last_update: player.last_updated.getTime()
            });
          }

          syncedCount++;
        } catch (error) {
          logger.error('Failed to sync individual player', { 
            serverUuid: player.server_uuid,
            playerUuid: player.player_uuid,
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      }
      
      this.stats.lastDbToRedisSync = new Date();
      
      logger.info('✅ Database → Redis sync completed', {
        totalPlayers: onlinePlayers.length,
        syncedPlayers: syncedCount
      });
      
    } catch (error) {
      logger.error('❌ Database → Redis sync failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ========== QUEUE MANAGEMENT ==========
  
  private addToQueue(item: SyncQueueItem): void {
    this.syncQueue.push(item);
    this.stats.pendingItems = this.syncQueue.length;
    
    // Sort by priority (1 = highest priority)
    this.syncQueue.sort((a, b) => a.priority - b.priority);
    
    logger.debug('📋 Item added to sync queue', { 
      id: item.id,
      type: item.type,
      priority: item.priority,
      queueSize: this.syncQueue.length
    });
  }

  private startQueueProcessor(): void {
    const interval = parseInt(process.env.SYNC_QUEUE_INTERVAL || '1000');
    
    this.queueProcessor = setInterval(async () => {
      await this.processQueue();
    }, interval);
    
    logger.info('⚡ Queue processor started', { interval: `${interval}ms` });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.syncQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;
    const batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '25');
    
    try {
      const batch = this.syncQueue.splice(0, batchSize);
      const startTime = Date.now();
      
      for (const item of batch) {
        try {
          await this.processQueueItem(item);
          this.stats.processedItems++;
        } catch (error) {
          item.attempts++;
          item.lastAttempt = Date.now();
          this.stats.retries++;
          
          if (item.attempts < item.maxAttempts) {
            // Re-queue with lower priority
            item.priority = Math.min(item.priority + 1, 5);
            this.syncQueue.push(item);
            
            logger.debug('🔄 Retrying queue item', { 
              id: item.id,
              attempt: item.attempts,
              maxAttempts: item.maxAttempts
            });
          } else {
            this.stats.errors++;
            logger.error('❌ Queue item failed after max attempts', { 
              id: item.id,
              attempts: item.attempts,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
          }
        }
      }
      
      const duration = Date.now() - startTime;
      this.stats.performance.avgProcessingTime = 
        (this.stats.performance.avgProcessingTime + duration) / 2;
      
      this.stats.pendingItems = this.syncQueue.length;
      
      if (batch.length > 0) {
        logger.debug('✅ Queue batch processed', {
          batchSize: batch.length,
          durationMs: duration,
          remaining: this.syncQueue.length,
          avgTime: Math.round(this.stats.performance.avgProcessingTime)
        });
      }
      
    } catch (error) {
      logger.error('❌ Queue processing error', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async processQueueItem(item: SyncQueueItem): Promise<void> {
    const startTime = Date.now();
    
    try {
      switch (item.type) {
        case 'player_position':
          await this.processPlayerPositionSync(item.data);
          break;
        case 'chunk_calculation':
          await this.processChunkCalculation(item.data);
          break;
        case 'zone_update':
          await this.processZoneUpdate(item.data);
          break;
        case 'database_sync':
          await this.processDatabaseSync(item.data);
          break;
        default:
          logger.warn('⚠️ Unknown queue item type', { 
            id: item.id,
            type: item.type 
          });
      }
      
      const duration = Date.now() - startTime;
      logger.debug('✅ Queue item processed', { 
        id: item.id,
        type: item.type,
        durationMs: duration
      });
      
    } catch (error) {
      logger.error('❌ Failed to process queue item', {
        id: item.id,
        type: item.type,
        attempts: item.attempts,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  // ========== QUEUE ITEM PROCESSORS ==========
  
private async processPlayerPositionSync(data: { uuid: string; operation: string }): Promise<void> {
    const { uuid, operation } = data;
    
    try {
      // Get current player data from Redis
      const [position, chunk, zones] = await Promise.all([
        this.redisService.getPlayerPosition(uuid),
        this.redisService.getPlayerChunk(uuid),
        this.redisService.getPlayerZones(uuid)
      ]);

      if (!chunk) {
        logger.debug('No chunk data for player', { uuid });
        return;
      }

      // Calculate current zones
      const currentZones = this.calculatorService.calculateChunkZones(
        chunk.chunk_x, chunk.chunk_z,
        this.regions, this.nodes, this.cities
      );

      // ✅ FIX: Convert zones to proper format with explicit null conversion
      const previousZones: ChunkZoneData | null = zones ? {
        regionId: zones.region_id ?? null,     // Convert undefined to null
        regionName: null,
        nodeId: zones.node_id ?? null,         // Convert undefined to null
        nodeName: null,
        cityId: zones.city_id ?? null,         // Convert undefined to null
        cityName: null
      } : null;

      // Detect transitions
      const transition = this.transitionDetector.detectTransitions(
        uuid,
        previousZones,
        currentZones
      );

      // Update Redis zones
      await this.redisService.setPlayerZones(uuid, {
        region_id: currentZones.regionId,
        node_id: currentZones.nodeId,
        city_id: currentZones.cityId,
        last_update: Date.now()
      });

      // ✅ FIX: Sync to database with proper undefined handling
      const player = await this.databaseService.getPlayerByServerUuid(uuid);
      if (player) {
        await this.databaseService.updatePlayerPosition(
          uuid,
          player.player_name,
          position?.x ?? chunk.chunk_x * 16,
          position?.y ?? 64,
          position?.z ?? chunk.chunk_z * 16,
          currentZones.regionId ?? undefined,     // Convert null to undefined for DB
          currentZones.nodeId ?? undefined,       // Convert null to undefined for DB
          currentZones.cityId ?? undefined        // Convert null to undefined for DB
        );
      }

      // Publish transition if detected
      if (transition) {
        await this.publishTransitionEvents(transition);
        this.stats.performance.transitionsDetected++;
      }

      this.stats.performance.playersSync++;
      this.stats.lastRedisToDbSync = new Date();
      
    } catch (error) {
      logger.error('Failed to process player position sync', {
        uuid,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }


  private async processChunkCalculation(data: { chunks: any[]; zone: any }): Promise<void> {
    const { chunks, zone } = data;
    
    try {
      const batchPromises = chunks.map(async (chunk) => {
        try {
          const zoneData = this.calculatorService.calculateChunkZones(
            chunk.x, chunk.z,
            this.regions, this.nodes, this.cities
          );

          if (zoneData.regionId !== null || zoneData.nodeId !== null || zoneData.cityId !== null) {
            await this.redisService.setChunkZone(chunk.x, chunk.z, zoneData);
          }
          
          return 1;
        } catch (error) {
          logger.debug('Failed to calculate individual chunk', {
            chunkX: chunk.x,
            chunkZ: chunk.z,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          return 0;
        }
      });

      const results = await Promise.allSettled(batchPromises);
      const successCount = results
        .filter(r => r.status === 'fulfilled')
        .reduce((sum, r) => sum + (r as PromiseFulfilledResult<number>).value, 0);

      logger.debug(`✅ Chunk batch calculated`, {
        zoneName: zone.name,
        zoneType: zone.type,
        chunksProcessed: chunks.length,
        successful: successCount
      });
      
    } catch (error) {
      logger.error('Failed to process chunk calculation batch', {
        zone: zone.name,
        chunksCount: chunks.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  private async processZoneUpdate(data: any): Promise<void> {
    try {
      logger.info('🔄 Processing zone update', { data });
      
      // Reload zones from database
      await this.loadZonesFromDatabase();
      
      // Invalidate chunk cache for affected zone
      if (data.table && data.id) {
        const pattern = `chunk:zone:*`;
        await this.redisService.deleteChunkZonesByPattern(pattern);
        
        // Re-queue chunk calculation
        await this.performInitialChunkCalculation();
      }
      
    } catch (error) {
      logger.error('Failed to process zone update', {
        data,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  private async processDatabaseSync(data: any): Promise<void> {
    try {
      await this.performDatabaseToRedisSync();
    } catch (error) {
      logger.error('Failed to process database sync', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  // ========== TRANSITION PUBLISHING ==========
  
  private async publishTransitionEvents(transition: any): Promise<void> {
    try {
      const { transitions, playerUuid } = transition;

      if (!transitions || Object.keys(transitions).length === 0) {
        return;
      }

      for (const [zoneType, transitionData] of Object.entries(transitions)) {
        if (!transitionData || typeof transitionData !== 'object') {
          continue;
        }

        const event = {
          playerUuid,
          zoneType: zoneType as 'region' | 'node' | 'city',
          zoneId: (transitionData as any).zoneId,
          zoneName: (transitionData as any).zoneName,
          eventType: (transitionData as any).type as 'enter' | 'leave',
          timestamp: Date.now()
        };

        await this.redisService.publishZoneEvent(event);
        
        logger.info('📡 Zone transition published', {
          playerUuid,
          event: `${zoneType}_${event.eventType}`,
          zoneName: event.zoneName
        });
      }
      
    } catch (error) {
      logger.error('Failed to publish transition events', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  // ========== PERIODIC SYNC ==========
  
  private startPeriodicSync(): void {
    const interval = parseInt(process.env.PERIODIC_SYNC_INTERVAL || '300000'); // 5 minutes
    
    this.periodicSync = setInterval(async () => {
      try {
        this.addToQueue({
          id: `periodic_sync_${Date.now()}`,
          type: 'database_sync',
          priority: 4, // Low priority
          data: {},
          attempts: 0,
          maxAttempts: 2,
          lastAttempt: 0,
          createdAt: Date.now()
        });
      } catch (error) {
        logger.error('Periodic sync scheduling failed', { 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    }, interval);
    
    logger.info('⏰ Periodic sync started', { interval: `${interval}ms` });
  }

  // ========== POSTGRESQL LISTENER ==========
  
  private async setupPostgresListener(): Promise<void> {
    try {
      this.postgresListener = await this.databaseService.listenToChanges((notification) => {
        logger.info('🔔 PostgreSQL notification received', { notification });
        
        this.addToQueue({
          id: `pg_notification_${Date.now()}`,
          type: 'zone_update',
          priority: 2, // Medium priority
          data: notification,
          attempts: 0,
          maxAttempts: 3,
          lastAttempt: 0,
          createdAt: Date.now()
        });
      });
      
      logger.info('✅ PostgreSQL listener activated');
    } catch (error) {
      logger.error('❌ Failed to setup PostgreSQL listener', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  // ========== PUBLIC API ==========
  
  isReady(): boolean {
    return this.serviceReady;
  }

  getStats(): SyncStats {
    return { ...this.stats };
  }

  async forceFullSync(): Promise<void> {
    if (!this.serviceReady) {
      throw new Error('Service not ready');
    }

    logger.info('🔄 Starting forced full synchronization...');
    
    try {
      // Clear current queue
      this.syncQueue = [];
      this.stats.pendingItems = 0;
      
      // Reload zones and recalculate chunks
      await this.loadZonesFromDatabase();
      await this.performInitialChunkCalculation();
      await this.performDatabaseToRedisSync();
      
      this.stats.lastFullSync = new Date();
      
      logger.info('✅ Forced full sync completed');
      
    } catch (error) {
      logger.error('❌ Forced full sync failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ========== CLEANUP ==========
  
  async destroy(): Promise<void> {
    try {
      logger.info('🛑 Shutting down OptimizedSyncService...');
      
      this.serviceReady = false;
      
      // Stop processors
      if (this.queueProcessor) {
        clearInterval(this.queueProcessor);
        this.queueProcessor = null;
      }
      
      if (this.periodicSync) {
        clearInterval(this.periodicSync);
        this.periodicSync = null;
      }
      
      // Close PostgreSQL listener
      if (this.postgresListener) {
        this.postgresListener.release();
        this.postgresListener = null;
      }
      
      // Process remaining queue items (with timeout)
      const maxWait = 10000; // 10 seconds
      const startTime = Date.now();
      
      while (this.syncQueue.length > 0 && !this.isProcessingQueue && (Date.now() - startTime) < maxWait) {
        await this.processQueue();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Clear data
      this.regions = [];
      this.nodes = [];
      this.cities = [];
      this.syncQueue = [];
      
      logger.info('✅ OptimizedSyncService shutdown completed', {
        finalStats: {
          processedItems: this.stats.processedItems,
          errors: this.stats.errors,
          transitionsDetected: this.stats.performance.transitionsDetected,
          chunksCalculated: this.stats.performance.chunksCalculated
        }
      });
      
    } catch (error) {
      logger.error('❌ Error during OptimizedSyncService shutdown', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }
}