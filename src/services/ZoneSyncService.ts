import { DatabaseService } from './DatabaseService';
import { RedisService } from './RedisService';
import { ChunkCalculatorService } from './ChunkCalculatorService';
import { DatabaseBatchService } from './DatabaseBatchService';
import { Region, Node, City, PostgresNotification } from '../models/Zone';
import { PlayerPosition, PlayerZones } from '../models/Player';
import { logger } from '../utils/logger';

export class ZoneSyncService {
  private isInitialized = false;
  private lastSyncTime: Date | null = null;
  private syncInProgress = false;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private postgresListener: any = null;

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private calculator: ChunkCalculatorService,
    private batchService?: DatabaseBatchService
  ) {}

async init(): Promise<void> {
  if (this.isInitialized) return;

  logger.info('🚀 Initializing REAL-TIME zone sync service');
  
  try {
    // 1. Complete initial synchronization
    await this.fullSync();
    logger.info('✅ Full sync completed - continuing...'); // ✅ AJOUT
    
    // 2. Bidirectional sync: Database to Redis
    await this.syncPlayersFromDatabase();
    logger.info('✅ Bidirectional sync completed - continuing...'); // ✅ AJOUT
    
    // 3. Start PostgreSQL change listener (auto-recalcul zones)
    logger.info('🔄 About to start PostgreSQL listener...'); // ✅ AJOUT
    await this.startPostgresListener();
    logger.info('✅ PostgreSQL listener started - continuing...'); // ✅ AJOUT
    
    // 4. ✅ Start Redis keyspace notifications (REAL-TIME positions)
    logger.info('🔥 About to start Redis keyspace listener...'); // ✅ AJOUT
    await this.startRedisKeyspaceListener();
    logger.info('✅ Redis keyspace listener started - continuing...'); // ✅ AJOUT
    
    // 5. Schedule automatic cleanup
    this.scheduleCleanup();
    logger.info('✅ Cleanup scheduled - continuing...'); // ✅ AJOUT
    
    this.isInitialized = true;
    logger.info('✅ REAL-TIME zone sync service initialized successfully');
    logger.info('🔥 Plugin Minecraft → Redis → WebSocket (< 5ms latency)');
  } catch (error) {
    logger.error('❌ Failed to initialize zone sync service', { 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
    throw new Error('Unable to initialize synchronization service');
  }
}

  // ========== ✅ REAL-TIME REDIS KEYSPACE LISTENER ==========
  private async startRedisKeyspaceListener(): Promise<void> {
    logger.info('🔥 Starting Redis keyspace notifications - REAL-TIME MODE');
    
    try {
      await this.redis.subscribeToKeyspaceEvents(async (uuid: string, operation: string) => {
        // ⚡ INSTANT processing when plugin writes to Redis
        await this.handlePlayerPositionChange(uuid);
      });
      
      logger.info('✅ Redis keyspace notifications active - Plugin → Redis → WebSocket < 5ms');
    } catch (error) {
      logger.error('Failed to setup Redis keyspace listener', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ⚡ INSTANT zone change detection
  private async handlePlayerPositionChange(uuid: string): Promise<void> {
    try {
      // Get latest position from Redis (set by Minecraft plugin)
      const position = await this.redis.getPlayerPosition(uuid);
      if (!position) return;

      // Check for zone changes
      await this.checkZoneChanges(uuid, position);
    } catch (error) {
      logger.error('Error handling position change', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  private async checkZoneChanges(uuid: string, position: PlayerPosition): Promise<void> {
    try {
      // 1. Calculate new zone
      const newZoneData = await this.redis.getChunkZone(position.chunk_x, position.chunk_z);
      
      // 2. Get old zones
      const oldZones = await this.redis.getPlayerZones(uuid);
      
      // 3. Detect changes
      if (this.hasZoneChanged(oldZones, newZoneData)) {
        logger.info('⚡ Zone change detected - INSTANT', { 
          uuid, 
          oldZones, 
          newZones: newZoneData 
        });
        
        // 🚀 INSTANT WebSocket broadcast
        await this.publishZoneChangeEvents(uuid, oldZones, newZoneData);
        
        // 📝 Async database update (can be slow, no problem)
        this.queueDatabaseUpdate(uuid, position, newZoneData);
      }
    } catch (error) {
      logger.error('Error checking zone changes', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  // ✅ FIX: Proper null checking
  private hasZoneChanged(oldZones: PlayerZones | null, newZoneData: any): boolean {
    // No old zones, no new zones = no change
    if (!oldZones && !newZoneData) return false;
    
    // No old zones, new zones = entering zones
    if (!oldZones && newZoneData) return true;
    
    // Old zones, no new zones = leaving zones  
    if (oldZones && !newZoneData) return true;
    
    // ✅ FIX: Null check before accessing properties
    if (!oldZones) return false;
    
    // Compare zones
    return (
      oldZones.region_id !== newZoneData?.regionId ||
      oldZones.node_id !== newZoneData?.nodeId ||
      oldZones.city_id !== newZoneData?.cityId
    );
  }

  private async publishZoneChangeEvents(
    uuid: string, 
    oldZones: PlayerZones | null, 
    newZoneData: any
  ): Promise<void> {
    try {
      // Publish LEAVE events for old zones
      if (oldZones) {
        if (oldZones.city_id && oldZones.city_id !== newZoneData?.cityId) {
          await this.publishZoneEvent(uuid, 'city', oldZones.city_id, 'leave');
        }
        if (oldZones.node_id && oldZones.node_id !== newZoneData?.nodeId) {
          await this.publishZoneEvent(uuid, 'node', oldZones.node_id, 'leave');
        }
        if (oldZones.region_id && oldZones.region_id !== newZoneData?.regionId) {
          await this.publishZoneEvent(uuid, 'region', oldZones.region_id, 'leave');
        }
      }
      
      // Publish ENTER events for new zones
      if (newZoneData) {
        if (newZoneData.regionId && newZoneData.regionId !== oldZones?.region_id) {
          await this.publishZoneEvent(uuid, 'region', newZoneData.regionId, 'enter', newZoneData.regionName);
        }
        if (newZoneData.nodeId && newZoneData.nodeId !== oldZones?.node_id) {
          await this.publishZoneEvent(uuid, 'node', newZoneData.nodeId, 'enter', newZoneData.nodeName);
        }
        if (newZoneData.cityId && newZoneData.cityId !== oldZones?.city_id) {
          await this.publishZoneEvent(uuid, 'city', newZoneData.cityId, 'enter', newZoneData.cityName);
        }
      }
      
      // Update player zones in Redis
      if (newZoneData) {
        await this.redis.setPlayerZones(uuid, {
          region_id: newZoneData.regionId,
          node_id: newZoneData.nodeId,
          city_id: newZoneData.cityId,
          last_update: Date.now()
        });
      }
    } catch (error) {
      logger.error('Error publishing zone change events', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  private async publishZoneEvent(
    uuid: string, 
    zoneType: 'region' | 'node' | 'city', 
    zoneId: number, 
    eventType: 'enter' | 'leave',
    zoneName?: string
  ): Promise<void> {
    try {
      const event = {
        playerUuid: uuid,
        zoneType,
        zoneId,
        zoneName: zoneName || `${zoneType}_${zoneId}`,
        eventType,
        timestamp: Date.now()
      };
      
      await this.redis.publishZoneEvent(event);
      logger.debug('🔥 Zone event published', { event });
    } catch (error) {
      logger.error('Error publishing zone event', { 
        uuid, 
        zoneType, 
        zoneId, 
        eventType,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  // ✅ FIX: Remove timestamp from interface
  private queueDatabaseUpdate(uuid: string, position: PlayerPosition, zoneData: any): void {
    if (this.batchService) {
      this.batchService.queuePlayerUpdate({
        uuid,
        name: 'Unknown', // Could get from Redis if needed
        x: position.x,
        y: position.y,
        z: position.z,
        chunkX: position.chunk_x,
        chunkZ: position.chunk_z,
        regionId: zoneData?.regionId,
        nodeId: zoneData?.nodeId,
        cityId: zoneData?.cityId
        // ✅ FIX: Remove timestamp - it's added automatically in the batch service
      });
      logger.debug('📝 Database update queued (async)', { uuid });
    }
  }

  // ========== BIDIRECTIONAL SYNC ==========
  private async syncPlayersFromDatabase(): Promise<void> {
    logger.info('Starting bidirectional sync: Database → Redis');
    
    try {
      const players = await this.db.getAllOnlinePlayers();
      
      if (players.length === 0) {
        logger.info('No online players to sync');
        return;
      }

      // Convert null values to undefined for Redis sync
      const playersForSync = players.map(player => ({
        player_uuid: player.player_uuid,
        x: player.x,
        y: player.y,
        z: player.z,
        chunk_x: player.chunk_x,
        chunk_z: player.chunk_z,
        last_updated: player.last_updated,
        region_id: player.region_id ?? undefined,
        node_id: player.node_id ?? undefined,
        city_id: player.city_id ?? undefined
      }));

      const syncedCount = await this.redis.syncPlayersFromDatabase(playersForSync);
      
      logger.info('Database → Redis sync completed', { 
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

  // ========== ✅ AUTO-RECALCUL ZONES (PostgreSQL Listener) ==========
  private async startPostgresListener(): Promise<void> {
    logger.info('🔄 Starting PostgreSQL zone change listener - AUTO-RECALCUL');
    
    try {
      this.postgresListener = await this.db.listenToChanges(async (notification: PostgresNotification) => {
        logger.info('🔄 Database zone change detected - Auto-recalculating', { 
          operation: notification.operation, 
          table: notification.table, 
          id: notification.id 
        });
        
        try {
          await this.handlePostgresNotification(notification);
        } catch (error) {
          logger.error('Failed to handle zone change notification', { 
            notification, 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      });
      
      logger.info('✅ PostgreSQL listener active - Zones auto-recalculated on changes');
    } catch (error) {
      logger.error('Failed to start PostgreSQL listener', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to start PostgreSQL zone change listener');
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
      // 1. ✅ Invalidate Redis cache for this zone
      const zoneType = table.slice(0, -1) as 'region' | 'node' | 'city';
      await this.redis.invalidateZoneCache(zoneType, zoneId);
      
      // 2. Reload zone from database
      const zone = await this.db.getZoneById(zoneType, zoneId);
      if (!zone) {
        logger.warn('Zone not found after UPDATE', { table, zoneId });
        return;
      }

      // 3. ✅ Recalculate affected chunks + delete old chunks
      await this.recalculateZoneChunks(zoneType, zone);
      
      // 4. Update zone metadata cache
      await this.updateZoneMetadataCache(zoneType, zone);
      
      logger.info('✅ Zone updated and recalculated', { table, zoneId });
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
      
      // 2. ✅ Remove chunks that referenced this zone + recalculate
      if (zoneType === 'region') {
        // Region deleted = recalculate everything
        logger.info('🔄 Region deleted - Full recalculation');
        await this.recalculateAllChunks();
      } else if (zoneType === 'node') {
        // Node deleted = recalculate parent region
        logger.info('🔄 Node deleted - Recalculating parent region');
        await this.recalculateParentRegionChunks(zoneId);
      } else if (zoneType === 'city') {
        // City deleted = recalculate parent node
        logger.info('🔄 City deleted - Recalculating parent node');
        await this.recalculateParentNodeChunks(zoneId);
      }
      
      logger.info('✅ Zone deleted and chunks recalculated', { table, zoneId });
    } catch (error) {
      logger.error('Failed to handle zone delete', { 
        table, 
        zoneId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ✅ Recalculate zone chunks + delete old chunks
  private async recalculateZoneChunks(
    zoneType: 'region' | 'node' | 'city', 
    zone: Region | Node | City
  ): Promise<void> {
    logger.info('🔄 Recalculating chunks for zone', { zoneType, zoneId: zone.id });
    
    try {
      // 1. ✅ Delete old chunks for this zone first
      await this.deleteOldZoneChunks(zoneType, zone.id);
      
      // 2. Get new chunks in this zone's polygon
      const chunks = this.calculator.getChunksInPolygon(zone.chunk_boundary);
      let successCount = 0;
      let errorCount = 0;
      
      if (zoneType === 'region') {
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
            if (zoneData.regionId) {
              await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
            }
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
            if (zoneData.regionId) {
              await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
            }
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
        // City recalculation
        const [regions, nodes, cities] = await Promise.all([
          this.db.getAllRegions(),
          this.db.getAllNodes(),
          this.db.getAllCities()
        ]);
        
        for (const chunk of chunks) {
          try {
            const zoneData = this.calculator.calculateChunkZones(
              chunk.x, chunk.z, regions, nodes, cities
            );
            if (zoneData.regionId) {
              await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
            }
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
      
      logger.info('✅ Zone chunks recalculated', { 
        zoneType, 
        zoneId: zone.id, 
        successCount, 
        errorCount 
      });
    } catch (error) {
      logger.error('Failed to recalculate zone chunks', { 
        zoneType, 
        zoneId: zone.id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  // ✅ FIX: Use Redis service method instead of accessing private getClient
  private async deleteOldZoneChunks(zoneType: 'region' | 'node' | 'city', zoneId: number): Promise<void> {
    try {
      const pattern = 'chunk:zone:*';
      const keys = await this.redis.keys(pattern);
      
      let deletedCount = 0;
      
      for (const key of keys) {
        try {
          const chunkData = await this.redis.getChunkZone(
            parseInt(key.split(':')[2]), 
            parseInt(key.split(':')[3])
          );
          
          if (!chunkData) continue;
          
          const shouldDelete = 
            (zoneType === 'region' && chunkData.regionId === zoneId) ||
            (zoneType === 'node' && chunkData.nodeId === zoneId) ||
            (zoneType === 'city' && chunkData.cityId === zoneId);
          
          if (shouldDelete) {
            await this.redis.deleteChunkZone(
              parseInt(key.split(':')[2]), 
              parseInt(key.split(':')[3])
            );
            deletedCount++;
          }
        } catch (error) {
          logger.debug('Error checking chunk for deletion', { key, error });
        }
      }
      
      logger.info('✅ Old zone chunks deleted', { zoneType, zoneId, deletedCount });
    } catch (error) {
      logger.error('Failed to delete old zone chunks', { 
        zoneType, 
        zoneId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
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
    logger.warn('🔄 Starting full chunk recalculation');
    
    try {
      // Delete all chunk zones first
      await this.redis.deleteChunkZonesByPattern('chunk:zone:*');
      
      const [regions, nodes, cities] = await Promise.all([
        this.db.getAllRegions(),
        this.db.getAllNodes(),
        this.db.getAllCities()
      ]);
      
      const result = await this.precomputeAllChunks(regions, nodes, cities);
      logger.info('✅ Full chunk recalculation completed', { 
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

  private async recalculateParentRegionChunks(nodeId: number): Promise<void> {
    // For now, full recalculation (future optimization possible)
    await this.recalculateAllChunks();
  }

  private async recalculateParentNodeChunks(cityId: number): Promise<void> {
    // For now, full recalculation (future optimization possible)
    await this.recalculateAllChunks();
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
    if (regions.length === 0 && nodes.length === 0 && cities.length === 0) {
      logger.info('No zones defined, skipping chunk pre-computation');
      return { chunksProcessed: 0, errors: 0 };
    }

    const batchSize = parseInt(process.env.PRECOMPUTE_BATCH_SIZE || '1000');
    
    let processedChunks = 0;
    let errorCount = 0;
    const errors: string[] = [];
    
    logger.info('Starting chunk computation for zones', { regionsCount: regions.length });

    const relevantChunks = this.getRelevantChunks(regions, nodes, cities);
    
    if (relevantChunks.length === 0) {
      logger.info('No relevant chunks found, skipping pre-computation');
      return { chunksProcessed: 0, errors: 0 };
    }

    logger.info('Optimized chunk computation', { 
      relevantChunks: relevantChunks.length 
    });

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

 private getRelevantChunks(regions: Region[], nodes: Node[], cities: City[]): Array<{x: number, z: number}> {
   const chunks = new Set<string>();
   
   for (const region of regions) {
     const regionChunks = this.calculator.getChunksInPolygon(region.chunk_boundary);
     for (const chunk of regionChunks) {
       chunks.add(`${chunk.x},${chunk.z}`);
     }
   }
   
   for (const node of nodes) {
     const nodeChunks = this.calculator.getChunksInPolygon(node.chunk_boundary);
     for (const chunk of nodeChunks) {
       chunks.add(`${chunk.x},${chunk.z}`);
     }
   }
   
   for (const city of cities) {
     const cityChunks = this.calculator.getChunksInPolygon(city.chunk_boundary);
     for (const chunk of cityChunks) {
       chunks.add(`${chunk.x},${chunk.z}`);
     }
   }
   
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

   for (const city of cities) {
     const promise = this.redis.cacheZoneMetadata('city', city.id, {
       name: city.name,
       description: city.description || '',
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

 // ========== NETTOYAGE ET MAINTENANCE ==========
 private scheduleCleanup(): void {
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
     await this.redis.getStats();
   } catch (error) {
     issues.push('Redis inaccessible');
   }
   
   try {
     await this.db.getZoneStats();
   } catch (error) {
     issues.push('PostgreSQL inaccessible');
   }
   
   if (this.lastSyncTime) {
     const timeSinceLastSync = Date.now() - this.lastSyncTime.getTime();
     if (timeSinceLastSync > 24 * 60 * 60 * 1000) {
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
   
   if (this.postgresListener) {
     try {
       this.postgresListener.release();
       this.postgresListener = null;
     } catch (error) {
       logger.error('Error releasing PostgreSQL listener', { error });
     }
   }
   
   this.isInitialized = false;
   logger.info('Zone sync service shut down successfully');
 }
}