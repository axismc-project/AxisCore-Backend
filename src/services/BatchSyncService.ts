// src/services/BatchSyncService.ts
import { RedisService, PlayerPosition } from './RedisService';
import { DatabaseService } from './DatabaseService';
import { logger } from '../utils/logger';

interface PlayerSyncData {
  server_uuid: string;  // ✅ FIX: Utiliser server_uuid au lieu de uuid
  position: PlayerPosition;
  zones: { regionId: number | null; nodeId: number | null; cityId: number | null };
  lastSync: number;
}

export class BatchSyncService {
  private syncInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isSyncing = false;
  
  private readonly SYNC_INTERVAL = parseInt(process.env.BATCH_SYNC_INTERVAL || '30000');
  private readonly BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200'); // ✅ Réduit pour optimiser
  
  private stats = {
    totalSyncs: 0,
    totalPlayers: 0,
    lastSyncTime: 0,
    lastSyncDuration: 0,
    errors: 0,
    lastErrorTime: 0,
    averagePlayersPerSync: 0
  };

  constructor(
    private redis: RedisService,
    private db: DatabaseService
  ) {}

  async start(): Promise<void> {
    try {
      logger.info('⚡ Starting Batch Sync Service...', {
        interval: `${this.SYNC_INTERVAL}ms`,
        batchSize: this.BATCH_SIZE,
        architecture: 'Redis (server_uuid) → PostgreSQL optimized batch updates'
      });
      
      this.isRunning = true;
      
      // Sync initial pour tester la connectivité
      await this.performSync();
      
      // Démarrer l'interval
      this.syncInterval = setInterval(async () => {
        if (!this.isSyncing && this.isRunning) {
          await this.performSync();
        }
      }, this.SYNC_INTERVAL);
      
      logger.info('✅ Batch Sync Service started successfully');
      
    } catch (error) {
      logger.error('❌ Failed to start Batch Sync Service', { error });
      throw error;
    }
  }

  private async performSync(): Promise<void> {
    if (this.isSyncing || !this.isRunning) return;
    
    this.isSyncing = true;
    const startTime = Date.now();
    let syncedPlayers = 0;
    
    try {
      logger.debug('🔄 Starting Redis → PostgreSQL batch sync...');
      
      // ✅ FIX: Récupérer toutes les positions depuis Redis (server_uuid comme clé)
      const playerPositions = await this.redis.getAllPlayerPositions();
      
      if (playerPositions.size === 0) {
        logger.debug('➖ No players to sync from Redis');
        return;
      }
      
      logger.debug('📊 Redis positions found', { 
        playersCount: playerPositions.size,
        sampleKeys: Array.from(playerPositions.keys()).slice(0, 3).map(k => k.substring(0, 8) + '...')
      });
      
      // ✅ Enrichir avec les données de zones
      const enrichedData = await this.enrichWithZoneData(playerPositions);
      
      if (enrichedData.length === 0) {
        logger.debug('➖ No enriched data to sync');
        return;
      }
      
      // ✅ Sync par batches optimisés
      syncedPlayers = await this.syncInOptimizedBatches(enrichedData);
      
      // ✅ Mettre à jour les statuts de synchronisation
      await this.updateSyncStatuses(enrichedData);
      
      const duration = Date.now() - startTime;
      this.stats.totalSyncs++;
      this.stats.totalPlayers += syncedPlayers;
      this.stats.lastSyncTime = startTime;
      this.stats.lastSyncDuration = duration;
      this.stats.averagePlayersPerSync = Math.round(this.stats.totalPlayers / this.stats.totalSyncs);
      
      logger.info('✅ Batch sync completed successfully', {
        playersCount: syncedPlayers,
        durationMs: duration,
        avgPerPlayer: syncedPlayers > 0 ? Math.round(duration / syncedPlayers * 100) / 100 : 0,
        batchesUsed: Math.ceil(syncedPlayers / this.BATCH_SIZE),
        efficiency: `${Math.round((syncedPlayers / playerPositions.size) * 100)}% synced`
      });
      
    } catch (error) {
      this.stats.errors++;
      this.stats.lastErrorTime = Date.now();
      logger.error('❌ Batch sync failed', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        syncedPlayers,
        duration: Date.now() - startTime
      });
    } finally {
      this.isSyncing = false;
    }
  }

  // ✅ FIX: Enrichir les données avec les zones en utilisant server_uuid
  private async enrichWithZoneData(
    playerPositions: Map<string, PlayerPosition>
  ): Promise<PlayerSyncData[]> {
    
    const enrichedData: PlayerSyncData[] = [];
    const enrichmentErrors: string[] = [];
    
    logger.debug('🔍 Enriching player data with zone information...');
    
    for (const [server_uuid, position] of playerPositions) {
      try {
        // ✅ Récupérer les zones pour ce chunk
        const zones = await this.redis.getChunkZone(position.chunk_x, position.chunk_z);
        
        enrichedData.push({
          server_uuid, // ✅ FIX: Utiliser server_uuid
          position,
          zones: {
            regionId: zones?.regionId || null,
            nodeId: zones?.nodeId || null,
            cityId: zones?.cityId || null
          },
          lastSync: Date.now()
        });
        
      } catch (error) {
        enrichmentErrors.push(server_uuid);
        logger.warn('⚠️ Failed to enrich player data', { 
          server_uuid: server_uuid.substring(0, 8) + '...', 
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        
        // ✅ Ajouter quand même avec zones nulles pour ne pas perdre la position
        enrichedData.push({
          server_uuid,
          position,
          zones: { regionId: null, nodeId: null, cityId: null },
          lastSync: Date.now()
        });
      }
    }
    
    if (enrichmentErrors.length > 0) {
      logger.warn('⚠️ Zone enrichment had errors', { 
        errorCount: enrichmentErrors.length, 
        totalPlayers: playerPositions.size,
        errorRate: `${Math.round((enrichmentErrors.length / playerPositions.size) * 100)}%`
      });
    }
    
    logger.debug('✅ Data enrichment completed', {
      totalPlayers: enrichedData.length,
      withZones: enrichedData.filter(p => p.zones.regionId || p.zones.nodeId || p.zones.cityId).length,
      wilderness: enrichedData.filter(p => !p.zones.regionId && !p.zones.nodeId && !p.zones.cityId).length
    });
    
    return enrichedData;
  }

  // ✅ FIX: Sync optimisé par batches avec PostgreSQL VALUES technique
  private async syncInOptimizedBatches(data: PlayerSyncData[]): Promise<number> {
    const totalBatches = Math.ceil(data.length / this.BATCH_SIZE);
    let totalSyncedPlayers = 0;
    
    logger.debug('📦 Starting optimized batch sync', {
      totalPlayers: data.length,
      batchSize: this.BATCH_SIZE,
      totalBatches
    });
    
    for (let i = 0; i < data.length; i += this.BATCH_SIZE) {
      const batch = data.slice(i, i + this.BATCH_SIZE);
      const batchNumber = Math.floor(i / this.BATCH_SIZE) + 1;
      
      try {
        const syncedCount = await this.syncBatchOptimized(batch, batchNumber, totalBatches);
        totalSyncedPlayers += syncedCount;
        
        logger.debug('✅ Batch synced', {
          batch: `${batchNumber}/${totalBatches}`,
          playersCount: batch.length,
          syncedCount,
          progress: `${Math.round((batchNumber / totalBatches) * 100)}%`
        });
        
        // ✅ Petit délai entre batches pour éviter la surcharge DB
        if (batchNumber < totalBatches) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
      } catch (error) {
        logger.error('❌ Batch sync failed', {
          batch: `${batchNumber}/${totalBatches}`,
          playersCount: batch.length,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        
        // ✅ Continuer avec les autres batches même si celui-ci échoue
        continue;
      }
    }
    
    return totalSyncedPlayers;
  }

  // ✅ FIX: Sync de batch optimisé avec la technique PostgreSQL VALUES
  private async syncBatchOptimized(batch: PlayerSyncData[], batchNumber: number, totalBatches: number): Promise<number> {
    
    // ✅ Préparer les données pour l'update batch optimisé
    const updates = batch.map(player => ({
      server_uuid: player.server_uuid, // ✅ FIX: Utiliser server_uuid
      name: `Player_${player.server_uuid.substring(0, 8)}`, // Nom temporaire, sera mis à jour par les logs
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
    
    // ✅ Utiliser la nouvelle méthode batch optimisée
    await this.db.batchUpdatePlayerPositions(updates);
    
    return batch.length;
  }

  // ✅ FIX: Mise à jour des statuts de synchronisation avec server_uuid
  private async updateSyncStatuses(data: PlayerSyncData[]): Promise<void> {
    const updatePromises = data.map(async player => {
      try {
        await this.redis.setEx(`player:sync:${player.server_uuid}`, 3600, 'true');
      } catch (error) {
        logger.warn('⚠️ Failed to update sync status in Redis', { 
          server_uuid: player.server_uuid.substring(0, 8) + '...',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    const results = await Promise.allSettled(updatePromises);
    const failures = results.filter(r => r.status === 'rejected').length;
    
    if (failures > 0) {
      logger.warn('⚠️ Some sync status updates failed', { 
        total: data.length, 
        failures,
        successRate: `${Math.round(((data.length - failures) / data.length) * 100)}%`
      });
    } else {
      logger.debug('✅ All sync statuses updated', { count: data.length });
    }
  }

  // ✅ FIX: Force sync avec retry logic
  async forceSync(): Promise<{ success: boolean; playersCount: number; duration: number; retries?: number }> {
    if (this.isSyncing) {
      throw new Error('Sync already in progress - cannot force sync');
    }
    
    const startTime = Date.now();
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
      try {
        logger.info('🚀 Force sync initiated', { attempt: retries + 1, maxRetries });
        
        await this.performSync();
        
        const result = {
          success: true,
          playersCount: this.stats.totalPlayers,
          duration: Date.now() - startTime,
          retries
        };
        
        logger.info('✅ Force sync completed successfully', result);
        return result;
        
      } catch (error) {
        retries++;
        logger.warn('⚠️ Force sync attempt failed', { 
          attempt: retries, 
          maxRetries, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        
        if (retries < maxRetries) {
          const delay = retries * 2000; // Délai croissant: 2s, 4s, 6s
          logger.info(`⏳ Retrying force sync in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    const result = {
      success: false,
      playersCount: 0,
      duration: Date.now() - startTime,
      retries
    };
    
    logger.error('❌ Force sync failed after all retries', result);
    return result;
  }

  // ✅ Statistiques enrichies
  getStats(): {
    isRunning: boolean;
    isSyncing: boolean;
    totalSyncs: number;
    totalPlayers: number;
    lastSyncTime: number;
    lastSyncDuration: number;
    errors: number;
    lastErrorTime: number;
    averagePlayersPerSync: number;
    nextSyncIn: number;
    syncInterval: number;
    batchSize: number;
    healthStatus: 'healthy' | 'warning' | 'error';
  } {
    const nextSyncIn = this.stats.lastSyncTime + this.SYNC_INTERVAL - Date.now();
    const timeSinceLastError = this.stats.lastErrorTime ? Date.now() - this.stats.lastErrorTime : null;
    
    // ✅ Déterminer le statut de santé
    let healthStatus: 'healthy' | 'warning' | 'error' = 'healthy';
    if (this.stats.errors > 0) {
      if (timeSinceLastError && timeSinceLastError < 300000) { // 5 minutes
        healthStatus = 'error';
      } else if (this.stats.errors > this.stats.totalSyncs * 0.1) { // Plus de 10% d'erreurs
        healthStatus = 'warning';
      }
    }
    
    return {
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
      totalSyncs: this.stats.totalSyncs,
      totalPlayers: this.stats.totalPlayers,
      lastSyncTime: this.stats.lastSyncTime,
      lastSyncDuration: this.stats.lastSyncDuration,
      errors: this.stats.errors,
      lastErrorTime: this.stats.lastErrorTime,
      averagePlayersPerSync: this.stats.averagePlayersPerSync,
      nextSyncIn: Math.max(0, nextSyncIn),
      syncInterval: this.SYNC_INTERVAL,
      batchSize: this.BATCH_SIZE,
      healthStatus
    };
  }

  // ✅ Stop amélioré avec cleanup
  async stop(): Promise<void> {
    logger.info('🛑 Stopping Batch Sync Service...');
    
    this.isRunning = false;
    
    // Arrêter l'interval
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      logger.debug('⏹️ Sync interval cleared');
    }
    
    // Attendre que le sync en cours se termine (max 30 secondes)
    let waitTime = 0;
    const maxWaitTime = 30000;
    while (this.isSyncing && waitTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      waitTime += 1000;
      
      if (waitTime % 5000 === 0) { // Log toutes les 5 secondes
        logger.info('⏳ Waiting for current sync to complete...', { 
          waitTime: `${waitTime / 1000}s`,
          maxWait: `${maxWaitTime / 1000}s`
        });
      }
    }
    
    if (this.isSyncing) {
      logger.warn('⚠️ Batch Sync Service stopped while sync was still in progress');
    }
    
    logger.info('✅ Batch Sync Service stopped successfully', {
      finalStats: {
        totalSyncs: this.stats.totalSyncs,
        totalPlayers: this.stats.totalPlayers,
        errors: this.stats.errors,
        averagePlayersPerSync: this.stats.averagePlayersPerSync
      }
    });
  }

  // ✅ Méthode pour vérifier la santé du service
  async healthCheck(): Promise<{
    healthy: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];
    
    try {
      // Vérifier Redis
      const ping = await this.redis.ping();
      if (!ping) {
        issues.push('Redis connection failed');
        recommendations.push('Check Redis connectivity');
      }
      
      // Vérifier Database
      const dbTest = await this.db.executeQuery('SELECT 1');
      if (!dbTest) {
        issues.push('Database connection failed');
        recommendations.push('Check PostgreSQL connectivity');
      }
      
      // Vérifier les erreurs récentes
      if (this.stats.errors > this.stats.totalSyncs * 0.2) {
        issues.push(`High error rate: ${this.stats.errors}/${this.stats.totalSyncs}`);
        recommendations.push('Check application logs for recurring errors');
      }
      
      // Vérifier si le service est bloqué
      const timeSinceLastSync = Date.now() - this.stats.lastSyncTime;
      if (this.isRunning && timeSinceLastSync > this.SYNC_INTERVAL * 3) {
        issues.push('Sync service appears to be stuck');
        recommendations.push('Consider restarting the batch sync service');
      }
      
    } catch (error) {
      issues.push(`Health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      recommendations.push('Investigate system resources and dependencies');
    }
    
    return {
      healthy: issues.length === 0,
      issues,
      recommendations
    };
  }
}