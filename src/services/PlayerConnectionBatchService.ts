import { DatabaseService } from './DatabaseService';
import { logger } from '../utils/logger';

interface PlayerConnection {
  uuid: string;
  name: string;
  isOnline: boolean;
  timestamp: number;
}

export class PlayerConnectionBatchService {
  private pendingConnections = new Map<string, PlayerConnection>();
  private batchInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly batchSize: number;
  private readonly flushInterval: number;

  constructor(
    private db: DatabaseService,
    batchSize: number = 500,
    flushIntervalMs: number = 10000 // 10 seconds
  ) {
    this.batchSize = batchSize;
    this.flushInterval = flushIntervalMs;
    this.startBatchProcessor();
  }

  private startBatchProcessor(): void {
    this.batchInterval = setInterval(async () => {
      await this.flushBatch();
    }, this.flushInterval);

    logger.info('Player connection batch service started', {
      batchSize: this.batchSize,
      flushInterval: this.flushInterval
    });
  }

  queuePlayerConnection(connection: Omit<PlayerConnection, 'timestamp'>): void {
    const playerConnection: PlayerConnection = {
      ...connection,
      timestamp: Date.now()
    };

    // Remplacer la connexion précédente pour ce joueur (plus récente)
    this.pendingConnections.set(connection.uuid, playerConnection);

    // Force flush if batch size reached (gestion des pics de trafic)
    if (this.pendingConnections.size >= this.batchSize) {
      setImmediate(() => this.flushBatch());
    }
  }

  private async flushBatch(): Promise<void> {
    if (this.isProcessing || this.pendingConnections.size === 0) {
      return;
    }

    this.isProcessing = true;
    const connections = Array.from(this.pendingConnections.values());
    this.pendingConnections.clear();

    const startTime = Date.now();
    
    try {
      await this.db.batchUpdatePlayerConnections(connections);
      
      const duration = Date.now() - startTime;
      logger.info('Player connection batch processed successfully', {
        playersProcessed: connections.length,
        durationMs: duration,
        avgPerPlayer: Math.round(duration / connections.length * 100) / 100
      });

    } catch (error) {
      logger.error('Player connection batch processing failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        playersAffected: connections.length,
        retrying: true
      });

      // Re-queue failed connections (simple retry strategy)
      connections.forEach(connection => {
        this.pendingConnections.set(connection.uuid, connection);
      });
    } finally {
      this.isProcessing = false;
    }
  }

  async forceFlush(): Promise<void> {
    await this.flushBatch();
  }

  getQueueSize(): number {
    return this.pendingConnections.size;
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
    
    logger.info('Player connection batch service stopped');
  }
}