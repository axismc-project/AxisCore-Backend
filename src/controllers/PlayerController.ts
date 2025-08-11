import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { DatabaseBatchService } from '../services/DatabaseBatchService';
import { PlayerConnectionBatchService } from '../services/PlayerConnectionBatchService';
import { SecurityUtils } from '../utils/security';
import { logger } from '../utils/logger';

// ✅ FIX: Suppression du mot-clé export de la déclaration de classe
class PlayerController {
  private batchService: DatabaseBatchService;
  private connectionBatchService: PlayerConnectionBatchService;

  constructor(
    private redis: RedisService,
    private db: DatabaseService
  ) {
    this.batchService = new DatabaseBatchService(this.db);
    this.connectionBatchService = new PlayerConnectionBatchService(this.db);
  }

  // ========== PLAYER CONNECTION/DISCONNECTION ==========
  async handlePlayerConnection(req: Request, res: Response): Promise<void> {
    try {
      const { uuid, name, isOnline } = req.body;
      
      if (!SecurityUtils.isValidUUID(uuid)) {
        res.status(400).json({
          error: 'Invalid UUID',
          message: 'UUID must be in valid format'
        });
        return;
      }

      if (!name || typeof name !== 'string' || name.length === 0 || name.length > 16) {
        res.status(400).json({
          error: 'Invalid name',
          message: 'Name must be a string with 1 to 16 characters'
        });
        return;
      }

      if (typeof isOnline !== 'boolean') {
        res.status(400).json({
          error: 'Invalid isOnline',
          message: 'isOnline must be a boolean'
        });
        return;
      }

      // Ajouter à la file d'attente de connexions
      this.connectionBatchService.queuePlayerConnection({
        uuid,
        name,
        isOnline
      });

      res.json({
        message: `Player ${isOnline ? 'connection' : 'disconnection'} queued successfully`,
        data: {
          uuid,
          name,
          isOnline,
          queued: true
        }
      });

    } catch (error) {
      logger.error('Failed to handle player connection', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to handle player connection'
      });
    }
  }

  async getPlayerInfo(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      
      if (!SecurityUtils.isValidUUID(uuid)) {
        res.status(400).json({ 
          error: 'Invalid UUID',
          message: 'UUID must be in valid format'
        });
        return;
      }
      
      const player = await this.db.getPlayerByUuid(uuid);
      
      if (!player) {
        res.status(404).json({ 
          error: 'Player not found',
          message: `No player with UUID ${uuid}`
        });
        return;
      }
      
      res.json({
        message: 'Player found',
        data: player
      });
      
    } catch (error) {
      logger.error('Failed to get player info', { 
        uuid: req.params.uuid,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get player info'
      });
    }
  }

  async updatePlayerPosition(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      const { name, x, y, z } = req.body;
      
      if (!SecurityUtils.isValidUUID(uuid)) {
        res.status(400).json({ 
          error: 'Invalid UUID',
          message: 'UUID must be in valid format'
        });
        return;
      }

      if (!name || typeof name !== 'string' || name.length === 0 || name.length > 16) {
        res.status(400).json({
          error: 'Invalid name',
          message: 'Name must be a string with 1 to 16 characters'
        });
        return;
      }
      
      if (!SecurityUtils.isValidCoordinate(x) || !SecurityUtils.isValidCoordinate(y) || !SecurityUtils.isValidCoordinate(z)) {
        res.status(400).json({
          error: 'Invalid coordinates',
          message: 'x, y, z must be valid finite numbers within bounds'
        });
        return;
      }

      const chunkX = Math.floor(x / 16);
      const chunkZ = Math.floor(z / 16);

      // Get zone information for this chunk
      const zoneData = await this.redis.getChunkZone(chunkX, chunkZ);

      // ✅ FIX: Conversion explicite null → undefined avec gestion propre
      this.batchService.queuePlayerUpdate({
        uuid,
        name,
        x,
        y,
        z,
        chunkX,
        chunkZ,
        regionId: zoneData?.regionId || undefined,  // ✅ null ou number → undefined si null
        nodeId: zoneData?.nodeId || undefined,      // ✅ null ou number → undefined si null
        cityId: zoneData?.cityId || undefined       // ✅ null ou number → undefined si null
      });

      // Update Redis cache
      await this.redis.setPlayerPosition(uuid, {
        x,
        y,
        z,
        chunk_x: chunkX,
        chunk_z: chunkZ,
        timestamp: Date.now()
      });

      if (zoneData?.regionId || zoneData?.nodeId || zoneData?.cityId) {
        await this.redis.setPlayerZones(uuid, {
          region_id: zoneData.regionId || undefined,   // ✅ null → undefined
          node_id: zoneData.nodeId || undefined,       // ✅ null → undefined
          city_id: zoneData.cityId || undefined,       // ✅ null → undefined
          last_update: Date.now()
        });
      }

      res.json({
        message: 'Position updated successfully',
        data: {
          uuid,
          name,
          x,
          y,
          z,
          chunkX,
          chunkZ,
          zones: zoneData
        }
      });
      
    } catch (error) {
      logger.error('Failed to update player position', { 
        uuid: req.params.uuid,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to update player position'
      });
    }
  }

  async updatePlayerChunk(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      const { chunkX, chunkZ } = req.body;
      
      if (!SecurityUtils.isValidUUID(uuid)) {
        res.status(400).json({ 
          error: 'Invalid UUID',
          message: 'UUID must be in valid format'
        });
        return;
      }
      
      if (!SecurityUtils.isValidChunkCoordinate(chunkX) || !SecurityUtils.isValidChunkCoordinate(chunkZ)) {
        res.status(400).json({
          error: 'Invalid chunk coordinates',
          message: 'chunkX and chunkZ must be valid integers within bounds'
        });
        return;
      }

      // Update chunk in Redis
      await this.redis.setPlayerChunk(uuid, chunkX, chunkZ);

      // Get zone information for this chunk
      const zoneData = await this.redis.getChunkZone(chunkX, chunkZ);

      if (zoneData?.regionId || zoneData?.nodeId || zoneData?.cityId) {
        await this.redis.setPlayerZones(uuid, {
          region_id: zoneData.regionId || undefined,   // ✅ null → undefined
          node_id: zoneData.nodeId || undefined,       // ✅ null → undefined
          city_id: zoneData.cityId || undefined,       // ✅ null → undefined
          last_update: Date.now()
        });
      }

      res.json({
        message: 'Chunk updated successfully',
        data: {
          uuid,
          chunkX,
          chunkZ,
          zones: zoneData
        }
      });
      
    } catch (error) {
      logger.error('Failed to update player chunk', { 
        uuid: req.params.uuid,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to update player chunk'
      });
    }
  }

  async getPlayerCurrentZones(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      
      if (!SecurityUtils.isValidUUID(uuid)) {
        res.status(400).json({ 
          error: 'Invalid UUID',
          message: 'UUID must be in valid format'
        });
        return;
      }
      
      const zones = await this.redis.getPlayerZones(uuid);
      
      if (!zones) {
        res.status(404).json({ 
          error: 'Player zones not found',
          message: `No zone data for player ${uuid}`
        });
        return;
      }
      
      res.json({
        message: 'Player zones retrieved',
        data: zones
      });
      
    } catch (error) {
      logger.error('Failed to get player zones', { 
        uuid: req.params.uuid,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get player zones'
      });
    }
  }

  // ========== BATCH SERVICE ENDPOINTS ==========
  async getBatchStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = {
        positionQueue: this.batchService.getQueueSize(),
        positionProcessing: this.batchService.isQueueProcessing(),
        connectionQueue: this.connectionBatchService.getQueueSize(),
        connectionProcessing: this.connectionBatchService.isQueueProcessing()
      };
      
      res.json({
        message: 'Batch service statistics',
        data: stats
      });
      
    } catch (error) {
      logger.error('Failed to get batch stats', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get batch statistics'
      });
    }
  }

  async forceFlushBatch(req: Request, res: Response): Promise<void> {
    try {
      await Promise.all([
        this.batchService.forceFlush(),
        this.connectionBatchService.forceFlush()
      ]);
      
      res.json({
        message: 'All batches flushed successfully',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logger.error('Failed to flush batches', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to flush batches'
      });
    }
  }

  // ========== CLEANUP ==========
  async destroy(): Promise<void> {
    await Promise.all([
      this.batchService.destroy(),
      this.connectionBatchService.destroy()
    ]);
  }
}

// ✅ FIX: Export nommé uniquement à la fin
export { PlayerController };