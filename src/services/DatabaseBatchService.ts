import { DatabaseService } from './DatabaseService';
import { logger } from '../utils/logger';

interface PlayerUpdate {
  uuid: string;
  name: string;
  x: number;
  y: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  regionId?: number;
  nodeId?: number;
  cityId?: number;
  // ✅ FIX: timestamp is automatically added in queuePlayerUpdate
}

export class DatabaseBatchService {
  private pendingUpdates = new Map<string, PlayerUpdate & { timestamp: number }>();
  private batchInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly batchSize: number;
  private readonly flushInterval: number;

  constructor(
    private db: DatabaseService,
    batchSize: number = 1000,
    flushIntervalMs: number = 30000 // 30 seconds
  ) {
    this.batchSize = batchSize;
    this.flushInterval = flushIntervalMs;
    this.startBatchProcessor();
  }

  private startBatchProcessor(): void {
    this.batchInterval = setInterval(async () => {
      await this.flushBatch();
    }, this.flushInterval);

    logger.info('Database batch service started', {
      batchSize: this.batchSize,
      flushInterval: this.flushInterval
    });
  }

  // ✅ FIX: timestamp is added automatically here
  queuePlayerUpdate(update: PlayerUpdate): void {
    const playerUpdate = {
      ...update,
      timestamp: Date.now() // ✅ Add timestamp automatically
    };

    this.pendingUpdates.set(update.uuid, playerUpdate);

    // Force flush if batch size reached
    if (this.pendingUpdates.size >= this.batchSize) {
      setImmediate(() => this.flushBatch());
    }
  }

  private async flushBatch(): Promise<void> {
    if (this.isProcessing || this.pendingUpdates.size === 0) {
      return;
    }

    this.isProcessing = true;
    const updates = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();

    const startTime = Date.now();
    
    try {
      await this.db.batchUpdatePlayers(updates);
      
      const duration = Date.now() - startTime;
      logger.info('Database batch processed successfully', {
        playersUpdated: updates.length,
        durationMs: duration,
        avgPerPlayer: Math.round(duration / updates.length * 100) / 100
      });

    } catch (error) {
      logger.error('Database batch processing failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        playersAffected: updates.length,
        retrying: true
      });

      // Re-queue failed updates (simple retry strategy)
      updates.forEach(update => {
        this.pendingUpdates.set(update.uuid, update);
      });
    } finally {
      this.isProcessing = false;
    }
  }

  async forceFlush(): Promise<void> {
    await this.flushBatch();
  }

  getQueueSize(): number {
    return this.pendingUpdates.size;
  }

  isQueueProcessing(): boolean {
    return this.isProcessing;
  }

  async destroy(): Promise<void> {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }

    // Final flush
    await this.flushBatch();
    
    logger.info('Database batch service stopped');
  }
}