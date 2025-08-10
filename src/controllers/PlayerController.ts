import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { logger } from '../utils/logger';

export class PlayerController {
  constructor(
    private redis: RedisService,
    private db: DatabaseService
  ) {}

  async getPlayerInfo(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      
      if (!uuid) {
        res.status(400).json({ 
          error: 'UUID manquant',
          message: 'L\'UUID du joueur est requis'
        });
        return;
      }
      
      // Validation UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(uuid)) {
        res.status(400).json({ 
          error: 'UUID invalide',
          message: 'L\'UUID doit être au format valide'
        });
        return;
      }
      
      // Récupérer depuis DB (données complètes)
      const player = await this.db.getPlayerByUuid(uuid);
      
      if (!player) {
        res.status(404).json({ 
          error: 'Joueur non trouvé',
          message: `Aucun joueur avec l\'UUID ${uuid}`
        });
        return;
      }
      
      // Récupérer position en temps réel depuis Redis
      let currentPosition = null;
      try {
        currentPosition = await this.redis.getPlayerPosition(uuid);
      } catch (redisError) {
        logger.warn('Redis indisponible pour position:', redisError);
      }
      
      res.json({
        message: 'Informations joueur récupérées',
        data: {
          ...player,
          currentPosition
        }
      });
      
    } catch (error) {
      logger.error('Erreur getPlayerInfo:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de récupérer les informations du joueur'
      });
    }
  }

  async updatePlayerPosition(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      const { name, x, y, z } = req.body;
      
      if (!uuid) {
        res.status(400).json({ 
          error: 'UUID manquant'
        });
        return;
      }
      
      // Validation
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(uuid)) {
        res.status(400).json({ 
          error: 'UUID invalide'
        });
        return;
      }
      
      if (!name || typeof name !== 'string' || name.length > 16) {
        res.status(400).json({ 
          error: 'Nom invalide',
          message: 'Le nom doit être une chaîne de 16 caractères maximum'
        });
        return;
      }
      
      if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
        res.status(400).json({ 
          error: 'Coordonnées invalides',
          message: 'x, y, z doivent être des nombres'
        });
        return;
      }
      
      const chunkX = Math.floor(x / 16);
      const chunkZ = Math.floor(z / 16);
      
      // Récupérer zones actuelles pour ce chunk
      const zoneData = await this.redis.getChunkZone(chunkX, chunkZ);
      
      // Mettre à jour position dans Redis
      await this.redis.setPlayerPosition(uuid, {
        x, y, z,
        chunk_x: chunkX,
        chunk_z: chunkZ,
        timestamp: Date.now()
      });
      
      // Mettre à jour zones du joueur
      if (zoneData) {
        await this.redis.setPlayerZones(uuid, {
          region_id: zoneData.regionId || undefined,
          node_id: zoneData.nodeId || undefined,
          city_id: zoneData.cityId || undefined,
          last_update: Date.now()
        });
      }
      
      // Mettre à jour en base (asynchrone)
      this.db.updatePlayerPosition(
        uuid, name, x, y, z,
        zoneData?.regionId || undefined,
        zoneData?.nodeId || undefined,
        zoneData?.cityId || undefined
      ).catch(error => {
        logger.error('Erreur mise à jour DB position:', error);
      });
      
      res.json({
        message: 'Position mise à jour',
        data: {
          uuid,
          name,
          position: { x, y, z },
          chunk: { x: chunkX, z: chunkZ },
          zones: zoneData
        }
      });
      
    } catch (error) {
      logger.error('Erreur updatePlayerPosition:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de mettre à jour la position'
      });
    }
  }

  async getPlayerCurrentZones(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      
      if (!uuid) {
        res.status(400).json({ 
          error: 'UUID manquant'
        });
        return;
      }
      
      // Validation UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(uuid)) {
        res.status(400).json({ 
          error: 'UUID invalide'
        });
        return;
      }
      
      // Récupérer depuis Redis
      const [position, zones] = await Promise.all([
        this.redis.getPlayerPosition(uuid),
        this.redis.getPlayerZones(uuid)
      ]);
      
      if (!position || !zones) {
        res.status(404).json({ 
          error: 'Données non trouvées',
          message: 'Aucune donnée de position/zone pour ce joueur'
        });
        return;
      }
      
      // Récupérer noms des zones depuis cache Redis
      const zoneNames: Record<string, string> = {};
      
      if (zones.region_id) {
        try {
          const regionMeta = await this.redis.getZoneMetadata('region', zones.region_id);
          if (regionMeta && regionMeta.name) {
            zoneNames.region = regionMeta.name;
          }
        } catch (error) {
          logger.warn('Erreur récupération nom région:', error);
        }
      }
      
      if (zones.node_id) {
        try {
          const nodeMeta = await this.redis.getZoneMetadata('node', zones.node_id);
          if (nodeMeta && nodeMeta.name) {
            zoneNames.node = nodeMeta.name;
          }
        } catch (error) {
          logger.warn('Erreur récupération nom node:', error);
        }
      }
      
      if (zones.city_id) {
        try {
          const cityMeta = await this.redis.getZoneMetadata('city', zones.city_id);
          if (cityMeta && cityMeta.name) {
            zoneNames.city = cityMeta.name;
          }
        } catch (error) {
          logger.warn('Erreur récupération nom ville:', error);
        }
      }
      
      res.json({
        message: 'Zones actuelles du joueur',
        data: {
          uuid,
          position,
          zones: {
            region_id: zones.region_id || null,
            region_name: zoneNames.region || null,
            node_id: zones.node_id || null,
            node_name: zoneNames.node || null,
            city_id: zones.city_id || null,
            city_name: zoneNames.city || null,
            last_update: new Date(zones.last_update).toISOString()
          }
        }
      });
      
    } catch (error) {
      logger.error('Erreur getPlayerCurrentZones:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de récupérer les zones du joueur'
      });
    }
  }
}