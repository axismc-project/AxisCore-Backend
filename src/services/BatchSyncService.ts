// src/services/BatchSyncService.ts
import { RedisService, PlayerPosition } from './RedisService';
import { DatabaseService } from './DatabaseService';
import { logger } from '../utils/logger';

interface PlayerSyncData {
  uuid: string;
  position: PlayerPosition;
  zones: { regionId: number | null; nodeId: number | null; cityId: number | null };
  lastSync: number;
}

export class BatchSyncService {
  private syncInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isSyncing = false;
  
  private readonly SYNC_INTERVAL = parseInt(process.env.BATCH_SYNC_INTERVAL || '30000');
  private readonly BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100');
  
  private stats = {
    totalSyncs: 0,
    totalPlayers: 0,
    lastSyncTime: 0,
    lastSyncDuration: 0,
    errors: 0
  };

  constructor(
    private redis: RedisService,
    private db: DatabaseService
  ) {}

  async start(): Promise<void> {
    try {
      logger.info('⚡ Starting Batch Sync Service...', {
        interval: `${this.SYNC_INTERVAL}ms`,
        batchSize: this.BATCH_SIZE
      });
      
      this.isRunning = true;
      
      // Sync initial
      await this.performSync();
      
      // Démarrer l'interval
      this.syncInterval = setInterval(async () => {
        if (!this.isSyncing) {
          await this.performSync();
        }
      }, this.SYNC_INTERVAL);
      
      logger.info('✅ Batch Sync Service started');
      
    } catch (error) {
      logger.error('❌ Failed to start Batch Sync Service', { error });
      throw error;
    }
  }

  private async performSync(): Promise<void> {
    if (this.isSyncing || !this.isRunning) return;
    
    this.isSyncing = true;
    const startTime = Date.now();
    
    try {
      logger.info('🔄 Starting batch sync Redis → PostgreSQL...');
      
      // Récupérer toutes les positions depuis Redis
      const playerPositions = await this.redis.getAllPlayerPositions();
      
      if (playerPositions.size === 0) {
        logger.debug('➖ No players to sync');
        return;
      }
      
      // Enrichir avec les données de zones
      const enrichedData = await this.enrichWithZoneData(playerPositions);
      
      // Sync par batches
      await this.syncInBatches(enrichedData);
      
      // Mettre à jour les statuts de synchronisation
      await this.updateSyncStatuses(enrichedData);
      
      const duration = Date.now() - startTime;
      this.stats.totalSyncs++;
      this.stats.totalPlayers += enrichedData.length;
      this.stats.lastSyncTime = startTime;
      this.stats.lastSyncDuration = duration;
      
      logger.info('✅ Batch sync completed', {
        playersCount: enrichedData.length,
        durationMs: duration,
        avgPerPlayer: enrichedData.length > 0 ? Math.round(duration / enrichedData.length * 100) / 100 : 0
      });
      
    } catch (error) {
      this.stats.errors++;
      logger.error('❌ Batch sync failed', { error });
    } finally {
      this.isSyncing = false;
    }
  }

  private async enrichWithZoneData(
    playerPositions: Map<string, PlayerPosition>
  ): Promise<PlayerSyncData[]> {
    
    const enrichedData: PlayerSyncData[] = [];
    
    for (const [uuid, position] of playerPositions) {
      try {
        // Récupérer les zones pour ce chunk
        const zones = await this.redis.getChunkZone(position.chunk_x, position.chunk_z);
        
        enrichedData.push({
          uuid,
          position,
          zones: {
            regionId: zones?.regionId || null,
            nodeId: zones?.nodeId || null,
            cityId: zones?.cityId || null
          },
          lastSync: Date.now()
        });
        
      } catch (error) {
        logger.error('❌ Failed to enrich player data', { uuid: uuid.substring(0, 8) + '...', error });
        enrichedData.push({
          uuid,
          position,
          zones: { regionId: null, nodeId: null, cityId: null },
          lastSync: Date.now()
        });
      }
    }
    
    return enrichedData;
  }

  private async syncInBatches(data: PlayerSyncData[]): Promise<void> {
    const totalBatches = Math.ceil(data.length / this.BATCH_SIZE);
    
    for (let i = 0; i < data.length; i += this.BATCH_SIZE) {
      const batch = data.slice(i, i + this.BATCH_SIZE);
      const batchNumber = Math.floor(i / this.BATCH_SIZE) + 1;
      
      try {
        await this.syncBatch(batch);
        
        logger.debug('✅ Batch synced', {
          batch: `${batchNumber}/${totalBatches}`,
          playersCount: batch.length
        });
        
      } catch (error) {
        logger.error('❌ Batch sync failed', {
          batch: `${batchNumber}/${totalBatches}`,
          playersCount: batch.length,
          error
        });
      }
    }
  }

  private async syncBatch(batch: PlayerSyncData[]): Promise<void> {
    const updates = batch.map(player => ({
      uuid: player.uuid,
      name: `Player_${player.uuid.substring(0, 8)}`,
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      chunkX: player.position.chunk_x,
      chunkZ: player.position.chunk_z,
      regionId: player.zones.regionId,
      nodeId: player.zones.nodeId,
      cityId: player.zones.cityId,
      timestamp: player.position.timestamp
    }));
    
    await this.db.batchUpdatePlayerPositions(updates);
  }

  private async updateSyncStatuses(data: PlayerSyncData[]): Promise<void> {
    const promises = data.map(async player => {
      try {
        await this.redis.setEx(`player:sync:${player.uuid}`, 3600, 'true');
      } catch (error) {
        logger.warn('⚠️ Failed to update sync status', { 
          uuid: player.uuid.substring(0, 8) + '...',
          error 
        });
      }
    });

    await Promise.allSettled(promises);
  }

  async forceSync(): Promise<{ success: boolean; playersCount: number; duration: number }> {
    if (this.isSyncing) {
      throw new Error('Sync already in progress');
    }
    
    const startTime = Date.now();
    
    try {
      await this.performSync();
      
      return {
        success: true,
        playersCount: this.stats.totalPlayers,
        duration: Date.now() - startTime
      };
      
    } catch (error) {
      logger.error('❌ Force sync failed', { error });
      return {
        success: false,
        playersCount: 0,
        duration: Date.now() - startTime
      };
    }
  }

  getStats(): {
    isRunning: boolean;
    isSyncing: boolean;
    totalSyncs: number;
    totalPlayers: number;
    lastSyncTime: number;
    lastSyncDuration: number;
    errors: number;
    nextSyncIn: number;
  } {
    const nextSyncIn = this.stats.lastSyncTime + this.SYNC_INTERVAL - Date.now();
    
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
      nextSyncIn: Math.max(0, nextSyncIn)
    };
  }

  async stop(): Promise<void> {
    logger.info('🛑 Stopping Batch Sync Service...');
    
    this.isRunning = false;
    
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    
    let retries = 0;
    while (this.isSyncing && retries < 30) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      retries++;
    }
    
    logger.info('✅ Batch Sync Service stopped', {
      finalStats: this.stats
    });
  }
}