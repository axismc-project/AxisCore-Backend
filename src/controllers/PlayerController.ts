// src/controllers/PlayerController.ts
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

      if (!SecurityUtils.isValidUUID(server_uuid) || 
          !SecurityUtils.isValidPlayerName(name) || 
          typeof is_online !== 'boolean') {
        res.status(400).json({
          error: 'Invalid parameters',
          message: 'server_uuid, name (3-16 chars), and is_online (boolean) required'
        });
        return;
      }

      await this.handlePlayerIdentification(server_uuid, name, is_online);

      res.json({
        message: `Player ${is_online ? 'connected' : 'disconnected'} successfully`,
        data: { server_uuid, name, is_online }
      });

    } catch (error) {
      logger.error('❌ Failed to handle user log', { error });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to process user log'
      });
    }
  }

  private async handlePlayerIdentification(server_uuid: string, name: string, is_online: boolean): Promise<void> {
    try {
      // Vérifier si le joueur existe par server_uuid
      const existingPlayer = await this.db.getPlayerByServerUuid(server_uuid);
      
      if (existingPlayer) {
        // Mise à jour du joueur existant
        await this.db.updatePlayerServerUuid(existingPlayer.player_uuid, server_uuid, name, is_online);
        logger.info('👤 Player updated', { server_uuid, name, is_online });
        return;
      }

      // Nouveau server_uuid - chercher par nom
      const existingPlayerByName = await this.db.getPlayerByPlayerName(name);
      
      if (existingPlayerByName) {
        // Joueur existant avec nouveau server_uuid
        await this.db.updatePlayerServerUuid(existingPlayerByName.player_uuid, server_uuid, name, is_online);
        logger.info('🔄 Player server_uuid updated', { 
          old_server_uuid: existingPlayerByName.server_uuid,
          new_server_uuid: server_uuid,
          name 
        });
        return;
      }

      // Complètement nouveau - récupérer UUID Mojang
      const mojangUuid = await MojangApiService.getPlayerUUIDByUsername(name);
      
      if (!mojangUuid) {
        throw new Error(`Player "${name}" not found on Mojang servers`);
      }

      // Vérifier si ce player_uuid existe déjà (changement de nom)
      const existingMojangPlayer = await this.db.getPlayerByPlayerUuid(mojangUuid);
      
      if (existingMojangPlayer) {
        // Changement de nom
        await this.db.updatePlayerServerUuid(mojangUuid, server_uuid, name, is_online);
        logger.info('🏷️ Player name changed', { 
          player_uuid: mojangUuid,
          old_name: existingMojangPlayer.player_name,
          new_name: name,
          server_uuid 
        });
        return;
      }

      // Créer nouveau joueur
      await this.db.createPlayerWithUuids(server_uuid, mojangUuid, name, is_online);
      logger.info('✨ New player created', { server_uuid, player_uuid: mojangUuid, name });

    } catch (error) {
      logger.error('❌ Player identification failed', { server_uuid, name, error });
      throw error;
    }
  }

  // ========== POSITION UPDATE (appelé par le plugin Jedis) ==========
  
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

      // ⚠️ IMPORTANT: Le plugin Jedis écrit directement dans Redis
      // Cette route est juste pour compatibilité/monitoring
      // Les vraies données viennent via HSET direct de Jedis

      res.json({
        message: 'Position update acknowledged',
        note: 'Real updates handled via Redis keyspace notifications',
        data: {
          uuid,
          name,
          x, y, z,
          chunkX, chunkZ
        }
      });

      logger.debug('📍 Position update acknowledged (via REST)', { 
        uuid: uuid.substring(0, 8) + '...',
        name,
        chunk: `${chunkX},${chunkZ}`
      });

    } catch (error) {
      logger.error('❌ Failed to acknowledge position update', { error });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to acknowledge position update'
      });
    }
  }

  // ========== PLAYER INFO ==========
  
  async getPlayerInfo(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;

      if (!SecurityUtils.isValidUUID(uuid)) {
        res.status(400).json({
          error: 'Invalid UUID',
          message: 'Valid UUID required'
        });
        return;
      }

      // Chercher dans la base ET Redis
      const [dbPlayer, redisPosition] = await Promise.all([
        this.db.getPlayerByServerUuid(uuid),
        this.redis.getPlayerPosition(uuid)
      ]);

      if (!dbPlayer) {
        res.status(404).json({
          error: 'Player not found',
          message: `No player with server UUID ${uuid}`
        });
        return;
      }

      res.json({
        message: 'Player found',
        data: {
          ...dbPlayer,
          redis_position: redisPosition,
          last_seen_redis: redisPosition?.timestamp ? new Date(redisPosition.timestamp) : null
        }
      });

    } catch (error) {
      logger.error('❌ Failed to get player info', { uuid: req.params.uuid, error });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to get player info'
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
        message: zoneData ? 'Zone found' : 'Wilderness',
        chunk: { x, z },
        zones: zoneData
      });

    } catch (error) {
      logger.error('❌ Failed to get chunk info', { 
        chunkX: req.params.chunkX, 
        chunkZ: req.params.chunkZ, 
        error 
      });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to get chunk info'
      });
    }
  }
}