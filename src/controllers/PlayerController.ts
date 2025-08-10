import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { DatabaseBatchService } from '../services/DatabaseBatchService';
import { SecurityUtils } from '../utils/security';
import { logger } from '../utils/logger';

export class PlayerController {
  private batchService: DatabaseBatchService;

  constructor(
    private redis: RedisService,
    private db: DatabaseService
  ) {
    this.batchService = new DatabaseBatchService(this.db);
  }

  // ========== PLAYER ENDPOINTS ==========
  async createPlayer(req: Request, res: Response): Promise<void> {
    try {
      const { uuid, name, x, y, z } = req.body;
      
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

      await this.db.createPlayer(uuid, name, x, y, z);

      res.status(201).json({
        message: 'Player created successfully',
        data: {
          uuid,
          name,
          x,
          y,
          z,
          chunkX: Math.floor(x / 16),
          chunkZ: Math.floor(z / 16)
        }
      });

    } catch (error) {
      logger.error('Failed to create player', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to create player'
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

      // ✅ Correction: Conversion explicite null → undefined pour TypeScript
      this.batchService.queuePlayerUpdate({
        uuid,
        name,
        x,
        y,
        z,
        chunkX,
        chunkZ,
        regionId: zoneData?.regionId ?? undefined,  // null → undefined
        nodeId: zoneData?.nodeId ?? undefined,      // null → undefined
        cityId: zoneData?.cityId ?? undefined       // null → undefined
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
          region_id: zoneData.regionId ?? undefined,   // ✅ null → undefined
          node_id: zoneData.nodeId ?? undefined,       // ✅ null → undefined
          city_id: zoneData.cityId ?? undefined,       // ✅ null → undefined
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
         region_id: zoneData.regionId ?? undefined,   // ✅ null → undefined
         node_id: zoneData.nodeId ?? undefined,       // ✅ null → undefined
         city_id: zoneData.cityId ?? undefined,       // ✅ null → undefined
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
       queueSize: this.batchService.getQueueSize(),
       isProcessing: this.batchService.isQueueProcessing()
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
     await this.batchService.forceFlush();
     
     res.json({
       message: 'Batch flushed successfully',
       timestamp: new Date().toISOString()
     });
     
   } catch (error) {
     logger.error('Failed to flush batch', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     res.status(500).json({ 
       error: 'Server error',
       message: 'Unable to flush batch'
     });
   }
 }

 // ========== CLEANUP ==========
 async destroy(): Promise<void> {
   await this.batchService.destroy();
 }
}

export default PlayerController;