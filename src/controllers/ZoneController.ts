import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { ZoneSyncService } from '../services/ZoneSyncService';
import { ChunkZoneDataSchema } from '../models/Zone';
import { logger } from '../utils/logger';

export class ZoneController {
  constructor(
    private redis: RedisService,
    private db: DatabaseService,
    private syncService: ZoneSyncService
  ) {}

  // ========== ENDPOINTS ZONES ==========
  async getChunkZone(req: Request, res: Response): Promise<void> {
    try {
      const { chunkX, chunkZ } = req.params;
      
      // Validation
      const x = parseInt(chunkX);
      const z = parseInt(chunkZ);
      
      if (isNaN(x) || isNaN(z)) {
        res.status(400).json({ 
          error: 'Coordonnées de chunk invalides',
          message: 'chunkX et chunkZ doivent être des entiers'
        });
        return;
      }
      
      // Récupérer depuis Redis
      const zoneData = await this.redis.getChunkZone(x, z);
      
      if (!zoneData) {
        res.json({ 
          message: 'Wilderness',
          chunk: { x, z },
          zones: null
        });
        return;
      }
      
      // Valider les données
      const validatedData = ChunkZoneDataSchema.parse(zoneData);
      
      res.json({
        message: 'Zone found',
        chunk: { x, z },
        zones: validatedData
      });
      
    } catch (error) {
      logger.error('Erreur getChunkZone:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de récupérer les zones du chunk'
      });
    }
  }

  async getZoneHierarchy(req: Request, res: Response): Promise<void> {
    try {
      const hierarchy = await this.db.getZoneHierarchy();
      
      res.json({
        message: 'Hiérarchie des zones récupérée',
        count: hierarchy.length,
        data: hierarchy
      });
      
    } catch (error) {
      logger.error('Erreur getZoneHierarchy:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de récupérer la hiérarchie des zones'
      });
    }
  }

  async getZoneById(req: Request, res: Response): Promise<void> {
    try {
      const { zoneType, zoneId } = req.params;
      
      // Validation
      if (!['region', 'node', 'city'].includes(zoneType)) {
        res.status(400).json({ 
          error: 'Type de zone invalide',
          message: 'Type doit être: region, node, ou city'
        });
        return;
      }
      
      const id = parseInt(zoneId);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ 
          error: 'ID de zone invalide',
          message: 'L\'ID doit être un entier positif'
        });
        return;
      }
      
      // Récupérer depuis DB
      const zone = await this.db.getZoneById(zoneType as any, id);
      
      if (!zone) {
        res.status(404).json({ 
          error: 'Zone non trouvée',
          message: `Aucune zone ${zoneType} avec l'ID ${id}`
        });
        return;
      }
      
      res.json({
        message: 'Zone trouvée',
        data: zone
      });
      
    } catch (error) {
      logger.error('Erreur getZoneById:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de récupérer la zone'
      });
    }
  }

  async getPlayersInZone(req: Request, res: Response): Promise<void> {
    try {
      const { zoneType, zoneId } = req.params;
      
      // Validation
      if (!['region', 'node', 'city'].includes(zoneType)) {
        res.status(400).json({ 
          error: 'Type de zone invalide',
          message: 'Type doit être: region, node, ou city'
        });
        return;
      }
      
      const id = parseInt(zoneId);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ 
          error: 'ID de zone invalide',
          message: 'L\'ID doit être un entier positif'
        });
        return;
      }
      
      // Récupérer depuis Redis (plus rapide) avec fallback DB
      let playerUuids: string[] = [];
      
      try {
        playerUuids = await this.redis.getPlayersInZone(zoneType as any, id);
      } catch (redisError) {
        logger.warn('Redis indisponible, fallback vers DB:', redisError);
        const players = await this.db.getPlayersInZone(zoneType as any, id);
        playerUuids = players.map(p => p.player_uuid);
      }
      
      res.json({
        message: `Joueurs dans ${zoneType} ${id}`,
        zoneType,
        zoneId: id,
        playerCount: playerUuids.length,
        players: playerUuids
      });
      
    } catch (error) {
      logger.error('Erreur getPlayersInZone:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de récupérer les joueurs de la zone'
      });
    }
  }

  // ========== ENDPOINTS STATISTIQUES ==========
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.syncService.getDetailedStats();
      
      res.json({
        message: 'Statistiques récupérées',
        timestamp: new Date().toISOString(),
        data: stats
      });
      
    } catch (error) {
      logger.error('Erreur getStats:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de récupérer les statistiques'
      });
    }
  }

  async getHealth(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.syncService.getHealthStatus();
      
      const statusCode = health.isHealthy ? 200 : 503;
      
      res.status(statusCode).json({
        message: health.isHealthy ? 'Service en bonne santé' : 'Problèmes détectés',
        timestamp: new Date().toISOString(),
        data: health
      });
      
    } catch (error) {
      logger.error('Erreur getHealth:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de vérifier l\'état du service',
        timestamp: new Date().toISOString(),
        data: {
          isHealthy: false,
          issues: ['Erreur interne du service de santé']
        }
      });
    }
  }

  // ========== ENDPOINTS ADMINISTRATION ==========
  async forceSync(req: Request, res: Response): Promise<void> {
    try {
      // Vérification de sécurité (à adapter selon votre système d'auth)
      const authHeader = req.headers.authorization;
      if (!authHeader || !this.isValidAdminToken(authHeader)) {
        res.status(401).json({ 
          error: 'Non autorisé',
          message: 'Token d\'administration requis'
        });
        return;
      }
      
      if (this.syncService.isSyncInProgress()) {
        res.status(409).json({ 
          error: 'Conflit',
          message: 'Une synchronisation est déjà en cours'
        });
        return;
      }
      
      // Lancer sync en arrière-plan
      this.syncService.forceFreshSync().catch(error => {
        logger.error('Erreur sync forcée:', error);
      });
      
      res.json({
        message: 'Synchronisation forcée démarrée',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logger.error('Erreur forceSync:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible de démarrer la synchronisation'
      });
    }
  }

  async performCleanup(req: Request, res: Response): Promise<void> {
    try {
      // Vérification de sécurité
      const authHeader = req.headers.authorization;
      if (!authHeader || !this.isValidAdminToken(authHeader)) {
        res.status(401).json({ 
          error: 'Non autorisé',
          message: 'Token d\'administration requis'
        });
        return;
      }
      
      const result = await this.syncService.performCleanup();
      
      res.json({
        message: 'Nettoyage effectué',
        timestamp: new Date().toISOString(),
        data: result
      });
      
    } catch (error) {
      logger.error('Erreur performCleanup:', error);
      res.status(500).json({ 
        error: 'Erreur serveur',
        message: 'Impossible d\'effectuer le nettoyage'
      });
    }
  }

  private isValidAdminToken(authHeader: string): boolean {
    const token = authHeader.replace('Bearer ', '');
    const validToken = process.env.ADMIN_TOKEN;
    
    return validToken && token === validToken;
  }
}