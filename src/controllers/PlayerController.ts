import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { MojangApiService } from '../services/MojangApiService';
import { SecurityUtils } from '../utils/security';
import { logger } from '../utils/logger';

export class PlayerController {
  constructor(
    private redis: RedisService,
    private db: DatabaseService
  ) {}

  // ========== USER LOG (connexion/déconnexion) ==========
  
  async handleUserLog(req: Request, res: Response): Promise<void> {
    try {
      const { server_uuid, name, is_online } = req.body;

      if (!server_uuid || !name || typeof is_online !== 'boolean') {
        res.status(400).json({
          error: 'Missing required parameters',
          message: 'server_uuid, name, and is_online are required',
          received: { 
            server_uuid: !!server_uuid, 
            name: !!name, 
            is_online: typeof is_online
          }
        });
        return;
      }

      if (!SecurityUtils.isValidUUID(server_uuid)) {
        res.status(400).json({
          error: 'Invalid server_uuid',
          message: 'server_uuid must be a valid UUID format'
        });
        return;
      }

      if (!SecurityUtils.isValidPlayerName(name)) {
        res.status(400).json({
          error: 'Invalid player name',
          message: 'Player name must be 3-16 characters, alphanumeric and underscore only'
        });
        return;
      }

      await this.handlePlayerIdentification(server_uuid, name, is_online);

      res.json({
        success: true,
        message: `Player ${is_online ? 'connected' : 'disconnected'} successfully`,
        data: { 
          server_uuid, 
          name, 
          is_online,
          timestamp: new Date().toISOString()
        }
      });

      logger.info('✅ User log processed', { 
        server_uuid: server_uuid.substring(0, 8) + '...',
        name, 
        is_online 
      });

    } catch (error) {
      logger.error('❌ Failed to handle user log', { 
        body: req.body,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to process user log'
      });
    }
  }

  private async handlePlayerIdentification(server_uuid: string, name: string, is_online: boolean): Promise<void> {
    try {
      const existingPlayer = await this.db.getPlayerByServerUuid(server_uuid);
      
      if (existingPlayer) {
        await this.db.updatePlayerServerUuid(existingPlayer.player_uuid, server_uuid, name, is_online);
        await this.updateRedisSync(existingPlayer.player_uuid, true);
        
        logger.info('👤 Player updated', { server_uuid: server_uuid.substring(0, 8) + '...', name, is_online });
        return;
      }

      const existingPlayerByName = await this.db.getPlayerByPlayerName(name);
      
      if (existingPlayerByName) {
        await this.db.updatePlayerServerUuid(existingPlayerByName.player_uuid, server_uuid, name, is_online);
        await this.updateRedisSync(existingPlayerByName.player_uuid, true);
        
        logger.info('🔄 Player server_uuid updated', { 
          old_server_uuid: existingPlayerByName.server_uuid?.substring(0, 8) + '...',
          new_server_uuid: server_uuid.substring(0, 8) + '...',
          name 
        });
        return;
      }

      const mojangUuid = await MojangApiService.getPlayerUUIDByUsername(name);
      
      if (!mojangUuid) {
        throw new Error(`Player "${name}" not found on Mojang servers`);
      }

      const existingMojangPlayer = await this.db.getPlayerByPlayerUuid(mojangUuid);
      
      if (existingMojangPlayer) {
        await this.db.updatePlayerServerUuid(mojangUuid, server_uuid, name, is_online);
        await this.updateRedisSync(mojangUuid, true);
        
        logger.info('🏷️ Player name changed', { 
          player_uuid: mojangUuid.substring(0, 8) + '...',
          old_name: existingMojangPlayer.player_name,
          new_name: name,
          server_uuid: server_uuid.substring(0, 8) + '...'
        });
        return;
      }

      await this.db.createPlayerWithUuids(server_uuid, mojangUuid, name, is_online);
      await this.updateRedisSync(mojangUuid, true);
      
      logger.info('✨ New player created', { 
        server_uuid: server_uuid.substring(0, 8) + '...',
        player_uuid: mojangUuid.substring(0, 8) + '...',
        name 
      });

    } catch (error) {
      logger.error('❌ Player identification failed', { 
        server_uuid: server_uuid.substring(0, 8) + '...',
        name, 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  // ========== WHOIS ENDPOINT ==========
  
  async whoIs(req: Request, res: Response): Promise<void> {
    try {
      const { uuid, name } = req.body;

      if (!uuid && !name) {
        res.status(400).json({
          error: 'Missing identifier',
          message: 'Either uuid (server UUID) or name (player name) must be provided',
          example: {
            byServerUuid: { uuid: "550e8400-e29b-41d4-a716-446655440000" },
            byName: { name: "PlayerName" }
          }
        });
        return;
      }

      if (uuid && name) {
        res.status(400).json({
          error: 'Too many identifiers',
          message: 'Provide either uuid OR name, not both'
        });
        return;
      }

      let player = null;

      if (uuid) {
        if (!SecurityUtils.isValidUUID(uuid)) {
          res.status(400).json({
            error: 'Invalid UUID format',
            message: 'UUID must be in valid format'
          });
          return;
        }

        player = await this.db.getPlayerByServerUuid(uuid);
        
        if (!player) {
          res.status(404).json({
            error: 'Player not found',
            message: `No player found with server UUID: ${uuid}`,
            searchedBy: 'server_uuid',
            hint: 'This UUID should be the server-side UUID used in Redis keys'
          });
          return;
        }
      }

      if (name) {
        if (!SecurityUtils.isValidPlayerName(name)) {
          res.status(400).json({
            error: 'Invalid player name',
            message: 'Player name must be 3-16 characters, alphanumeric and underscore only'
          });
          return;
        }

        player = await this.db.getPlayerByPlayerName(name);
        
        if (!player) {
          res.status(404).json({
            error: 'Player not found',
            message: `No player found with name: ${name}`,
            searchedBy: 'player_name'
          });
          return;
        }
      }

      const [redisPosition, redisSync] = await Promise.all([
        this.redis.getPlayerPosition(player!.server_uuid),
        this.getRedisSync(player!.player_uuid)
      ]);

      const isRedisNewer = redisPosition && 
                          redisPosition.timestamp > new Date(player!.last_updated).getTime();

      const response = {
        success: true,
        message: 'Player found',
        searchedBy: uuid ? 'server_uuid' : 'player_name',
        data: {
          id: player!.id,
          server_uuid: player!.server_uuid,
          player_uuid: player!.player_uuid,
          player_name: player!.player_name,
          is_online: player!.is_online,
          last_updated: player!.last_updated,
          
          database_position: {
            x: player!.x,
            y: player!.y,
            z: player!.z,
            chunk_x: player!.chunk_x,
            chunk_z: player!.chunk_z,
            last_updated: player!.last_updated
          },
          
          redis_position: redisPosition ? {
            x: redisPosition.x,
            y: redisPosition.y,
            z: redisPosition.z,
            chunk_x: redisPosition.chunk_x,
            chunk_z: redisPosition.chunk_z,
            timestamp: new Date(redisPosition.timestamp).toISOString()
          } : null,
          
          current_position: isRedisNewer ? {
            source: 'redis',
            x: redisPosition!.x,
            y: redisPosition!.y,
            z: redisPosition!.z,
            chunk_x: redisPosition!.chunk_x,
            chunk_z: redisPosition!.chunk_z,
            last_updated: new Date(redisPosition!.timestamp).toISOString()
          } : {
            source: 'database',
            x: player!.x,
            y: player!.y,
            z: player!.z,
            chunk_x: player!.chunk_x,
            chunk_z: player!.chunk_z,
            last_updated: player!.last_updated
          },
          
          zones: {
            region: {
              id: player!.region_id,
              name: player!.region_name || null
            },
            node: {
              id: player!.node_id,
              name: player!.node_name || null
            },
            city: {
              id: player!.city_id,
              name: player!.city_name || null
            }
          },
          
          sync_status: {
            redis_synced: redisSync,
            has_redis_data: !!redisPosition,
            redis_is_newer: isRedisNewer,
            data_source_priority: isRedisNewer ? 'redis' : 'database',
            last_redis_update: redisPosition?.timestamp ? new Date(redisPosition.timestamp).toISOString() : null
          }
        }
      };

      res.json(response);

      logger.info('🔍 Player lookup completed', {
        searchedBy: uuid ? 'server_uuid' : 'player_name',
        identifier: uuid ? uuid.substring(0, 8) + '...' : name,
        found: true,
        player_name: player!.player_name,
        hasRedisData: !!redisPosition
      });

    } catch (error) {
      logger.error('❌ Failed to lookup player', { 
        body: req.body,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to lookup player information'
      });
    }
  }

  // ========== POSITION UPDATE ==========
  
  async updatePlayerPosition(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      const { name, x, y, z } = req.body;

      if (!SecurityUtils.isValidUUID(uuid) || 
          !SecurityUtils.isValidPlayerName(name) ||
          !SecurityUtils.isValidCoordinate(x) || 
          !SecurityUtils.isValidCoordinate(y) || 
          !SecurityUtils.isValidCoordinate(z)) {
        res.status(400).json({
          error: 'Invalid parameters',
         message: 'Valid UUID, name, and coordinates required'
       });
       return;
     }

     const chunkX = Math.floor(x / 16);
     const chunkZ = Math.floor(z / 16);

     const timestamp = Date.now();
     await this.redis.hSet(`player:pos:${uuid}`, {
       x: x.toString(),
       y: y.toString(),
       z: z.toString(),
       chunk_x: chunkX.toString(),
       chunk_z: chunkZ.toString(),
       timestamp: timestamp.toString(),
       name: name
     });

     await this.redis.hSet(`player:chunk:${uuid}`, {
       chunk_x: chunkX.toString(),
       chunk_z: chunkZ.toString(),
       timestamp: timestamp.toString()
     });

     await this.updateRedisSync(uuid, false);

     res.json({
       success: true,
       message: 'Position updated successfully',
       data: {
         server_uuid: uuid,
         name,
         position: { x, y, z },
         chunk: { x: chunkX, z: chunkZ },
         timestamp: new Date(timestamp).toISOString()
       }
     });

     logger.debug('📍 Position updated', { 
       server_uuid: uuid.substring(0, 8) + '...',
       name,
       position: `${x},${y},${z}`,
       chunk: `${chunkX},${chunkZ}`
     });

   } catch (error) {
     logger.error('❌ Failed to update position', { 
       uuid: req.params.uuid, 
       body: req.body,
       error: error instanceof Error ? error.message : 'Unknown error'
     });
     res.status(500).json({
       error: 'Server error',
       message: 'Unable to update position'
     });
   }
 }

 // ========== CHUNK INFO ==========
 
 async getChunkInfo(req: Request, res: Response): Promise<void> {
   try {
     const { chunkX, chunkZ } = req.params;
     
     const x = parseInt(chunkX);
     const z = parseInt(chunkZ);
     
     if (!SecurityUtils.isValidChunkCoordinate(x) || !SecurityUtils.isValidChunkCoordinate(z)) {
       res.status(400).json({
         error: 'Invalid chunk coordinates',
         message: 'Valid chunk coordinates required'
       });
       return;
     }

     const zoneData = await this.redis.getChunkZone(x, z);

     res.json({
       success: true,
       message: zoneData ? 'Zone found' : 'Wilderness area',
       chunk: { x, z },
       world_coordinates: {
         min: { x: x * 16, z: z * 16 },
         max: { x: x * 16 + 15, z: z * 16 + 15 },
         center: { x: x * 16 + 8, z: z * 16 + 8 }
       },
       zones: zoneData || null
     });

   } catch (error) {
     logger.error('❌ Failed to get chunk info', { 
       chunkX: req.params.chunkX, 
       chunkZ: req.params.chunkZ, 
       error: error instanceof Error ? error.message : 'Unknown error'
     });
     res.status(500).json({
       error: 'Server error',
       message: 'Unable to get chunk info'
     });
   }
 }

 // ========== REDIS SYNC UTILITIES ==========
 
 private async updateRedisSync(playerUuid: string, synced: boolean): Promise<void> {
   try {
     await this.redis.setEx(`player:sync:${playerUuid}`, 3600, synced ? 'true' : 'false');
   } catch (error) {
     logger.warn('⚠️ Failed to update Redis sync status', { 
       playerUuid: playerUuid.substring(0, 8) + '...',
       synced,
       error: error instanceof Error ? error.message : 'Unknown error'
     });
   }
 }

 private async getRedisSync(playerUuid: string): Promise<boolean> {
   try {
     const syncStatus = await this.redis.get(`player:sync:${playerUuid}`);
     return syncStatus === 'true';
   } catch (error) {
     logger.warn('⚠️ Failed to get Redis sync status', { 
       playerUuid: playerUuid.substring(0, 8) + '...',
       error: error instanceof Error ? error.message : 'Unknown error'
     });
     return false;
   }
 }
}