import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { DatabaseBatchService } from '../services/DatabaseBatchService';
import { PlayerConnectionBatchService } from '../services/PlayerConnectionBatchService';
import { MojangApiService } from '../services/MojangApiService';
import { SecurityUtils } from '../utils/security';
import { logger } from '../utils/logger';

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

  async handleUserLog(req: Request, res: Response): Promise<void> {
    try {
      const { server_uuid, name, is_online } = req.body;

      if (!SecurityUtils.isValidUUID(server_uuid)) {
        res.status(400).json({
          error: 'Invalid server_uuid',
          message: 'server_uuid must be in valid UUID format'
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

      if (typeof is_online !== 'boolean') {
        res.status(400).json({
          error: 'Invalid is_online',
          message: 'is_online must be a boolean'
        });
        return;
      }

      const result = await this.handlePlayerIdentification(server_uuid, name, is_online);

      res.json({
        message: `Player ${is_online ? 'connection' : 'disconnection'} processed successfully`,
        data: result
      });

    } catch (error) {
      logger.error('Failed to handle user log', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to process user log'
      });
    }
  }

// ✅ FIX: Méthode handlePlayerIdentification corrigée
private async handlePlayerIdentification(server_uuid: string, name: string, is_online: boolean): Promise<any> {
  try {
    // 1. Chercher le joueur par server_uuid
    const existingPlayer = await this.db.getPlayerByServerUuid(server_uuid);
    
    if (existingPlayer) {
      logger.info('👤 Existing player found by server_uuid', { 
        server_uuid, 
        player_uuid: existingPlayer.player_uuid,
        name 
      });
      
      await this.updateExistingPlayer(existingPlayer, name, is_online);
      
      return {
        server_uuid,
        player_uuid: existingPlayer.player_uuid,
        name,
        is_online,
        action: 'updated'
      };
    }

    // 2. Nouveau server_uuid - chercher d'abord par nom pour voir si on a déjà l'UUID Mojang
    const existingPlayerByName = await this.db.getPlayerByPlayerName(name);
    
    if (existingPlayerByName) {
      // On connaît déjà ce joueur (changement de server_uuid/pseudo)
      const player_uuid = existingPlayerByName.player_uuid;
      
      logger.info('🔄 Player found by name with existing Mojang UUID', { 
        server_uuid,
        player_uuid,
        name,
        old_server_uuid: existingPlayerByName.server_uuid
      });
      
      // Mettre à jour avec le nouveau server_uuid
      await this.updatePlayerServerUuid(existingPlayerByName, server_uuid, name, is_online);
      
      return {
        server_uuid,
        player_uuid,
        name,
        is_online,
        action: 'server_uuid_updated'
      };
    }

    // 3. Complètement nouveau - récupérer UUID Mojang
    logger.info('🆕 New player, fetching Mojang UUID', { server_uuid, name });
    
    // ✅ FIX: Gestion correcte du type nullable
    const mojangUuid = await MojangApiService.getPlayerUUIDByUsername(name);
    
    if (!mojangUuid) {
      throw new Error(`Player "${name}" not found on Mojang servers`);
    }
    
    // ✅ FIX: mojangUuid est maintenant garantie non-null
    const player_uuid: string = mojangUuid;

    // 4. Vérifier si ce player_uuid existe déjà (changement de pseudo complet)
    const existingMojangPlayer = await this.db.getPlayerByPlayerUuid(player_uuid);
    
    if (existingMojangPlayer) {
      logger.info('🔄 Player changed username (found by Mojang UUID)', { 
        old_server_uuid: existingMojangPlayer.server_uuid,
        new_server_uuid: server_uuid,
        player_uuid,
        old_name: existingMojangPlayer.player_name,
        new_name: name
      });
      
      await this.updatePlayerServerUuid(existingMojangPlayer, server_uuid, name, is_online);
      
      return {
        server_uuid,
        player_uuid,
        name,
        is_online,
        action: 'username_changed'
      };
    }

    // 5. Complètement nouveau joueur
    logger.info('✨ Creating new player', { server_uuid, player_uuid, name });
    
    await this.createNewPlayer(server_uuid, player_uuid, name, is_online);
    
    return {
      server_uuid,
      player_uuid,
      name,
      is_online,
      action: 'created'
    };

  } catch (error) {
    if (error instanceof Error && error.message.includes('not found on Mojang')) {
      throw error;
    }
    
    logger.error('Error in player identification', {
      server_uuid,
      name,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw new Error('Failed to identify player');
  }
}

  private async updateExistingPlayer(player: any, name: string, is_online: boolean): Promise<void> {
    const updateData = {
      uuid: player.server_uuid,
      name,
      x: player.x || 0,
      y: player.y || 0,
      z: player.z || 0,
      chunkX: player.chunk_x || 0,
      chunkZ: player.chunk_z || 0,
      regionId: player.region_id,
      nodeId: player.node_id,
      cityId: player.city_id
    };

    this.batchService.queuePlayerUpdate(updateData);
    
    this.connectionBatchService.queuePlayerConnection({
      uuid: player.server_uuid,
      name,
      isOnline: is_online
    });
  }

  private async updatePlayerServerUuid(player: any, new_server_uuid: string, name: string, is_online: boolean): Promise<void> {
    await this.db.updatePlayerServerUuid(player.player_uuid, new_server_uuid, name, is_online);
    
    this.connectionBatchService.queuePlayerConnection({
      uuid: new_server_uuid,
      name,
      isOnline: is_online
    });
  }

  private async createNewPlayer(server_uuid: string, player_uuid: string, name: string, is_online: boolean): Promise<void> {
    await this.db.createPlayerWithUuids(server_uuid, player_uuid, name, is_online);
    
    this.connectionBatchService.queuePlayerConnection({
      uuid: server_uuid,
      name,
      isOnline: is_online
    });
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

      const player = await this.db.getPlayerByServerUuid(uuid);

      if (!player) {
        res.status(404).json({
          error: 'Player not found',
          message: `No player with server UUID ${uuid}`
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

      const zoneData = await this.redis.getChunkZone(chunkX, chunkZ);

      this.batchService.queuePlayerUpdate({
        uuid,
        name,
        x,
        y,
        z,
        chunkX,
        chunkZ,
        regionId: zoneData?.regionId || null,
        nodeId: zoneData?.nodeId || null,
        cityId: zoneData?.cityId || null
      });

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
          region_id: zoneData.regionId ?? null,
          node_id: zoneData.nodeId ?? null,
          city_id: zoneData.cityId ?? null,
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

      await this.redis.setPlayerChunk(uuid, chunkX, chunkZ);

      const zoneData = await this.redis.getChunkZone(chunkX, chunkZ);

      if (zoneData?.regionId || zoneData?.nodeId || zoneData?.cityId) {
        await this.redis.setPlayerZones(uuid, {
          region_id: zoneData.regionId ?? null,
          node_id: zoneData.nodeId ?? null,
          city_id: zoneData.cityId ?? null,
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

  async destroy(): Promise<void> {
    await Promise.all([
      this.batchService.destroy(),
      this.connectionBatchService.destroy()
    ]);
  }
}

export { PlayerController };