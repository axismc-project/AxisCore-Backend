import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { ZoneSyncService } from '../services/ZoneSyncService';
import { ChunkZoneDataSchema } from '../models/Zone';
import { SecurityUtils } from '../utils/security';
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
      
      const x = parseInt(chunkX);
      const z = parseInt(chunkZ);
      
      if (!SecurityUtils.isValidChunkCoordinate(x) || !SecurityUtils.isValidChunkCoordinate(z)) {
        res.status(400).json({ 
          error: 'Invalid chunk coordinates',
          message: 'chunkX and chunkZ must be valid integers within bounds'
        });
        return;
      }
      
      // Get from Redis
      const zoneData = await this.redis.getChunkZone(x, z);
      
      if (!zoneData) {
        res.json({ 
          message: 'Wilderness',
          chunk: { x, z },
          zones: null
        });
        return;
      }
      
      // Validate data
      const validatedData = ChunkZoneDataSchema.parse(zoneData);
      
      res.json({
        message: 'Zone found',
        chunk: { x, z },
        zones: validatedData
      });
      
    } catch (error) {
      logger.error('Failed to get chunk zone', { 
        chunkX: req.params.chunkX, 
        chunkZ: req.params.chunkZ,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get chunk zones'
      });
    }
  }

  async getZoneHierarchy(req: Request, res: Response): Promise<void> {
    try {
      const hierarchy = await this.db.getZoneHierarchy();
      
      res.json({
        message: 'Zone hierarchy retrieved',
        count: hierarchy.length,
        data: hierarchy
      });
      
    } catch (error) {
      logger.error('Failed to get zone hierarchy', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get zone hierarchy'
      });
    }
  }

  async getZoneById(req: Request, res: Response): Promise<void> {
    try {
      const { zoneType, zoneId } = req.params;
      
      if (!['region', 'node', 'city'].includes(zoneType)) {
        res.status(400).json({ 
          error: 'Invalid zone type',
          message: 'Type must be: region, node, or city'
        });
        return;
      }
      
      const id = parseInt(zoneId);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ 
          error: 'Invalid zone ID',
          message: 'ID must be a positive integer'
        });
        return;
      }
      
      const zone = await this.db.getZoneById(zoneType as any, id);
      
      if (!zone) {
        res.status(404).json({ 
          error: 'Zone not found',
          message: `No zone ${zoneType} with ID ${id}`
        });
        return;
      }
      
      res.json({
        message: 'Zone found',
        data: zone
      });
      
    } catch (error) {
      logger.error('Failed to get zone by ID', { 
        zoneType: req.params.zoneType, 
        zoneId: req.params.zoneId,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get zone'
      });
    }
  }

  async getPlayersInZone(req: Request, res: Response): Promise<void> {
    try {
      const { zoneType, zoneId } = req.params;
      
      if (!['region', 'node', 'city'].includes(zoneType)) {
        res.status(400).json({ 
          error: 'Invalid zone type',
          message: 'Type must be: region, node, or city'
        });
        return;
      }
      
      const id = parseInt(zoneId);
      if (isNaN(id) || id <= 0) {
        res.status(400).json({ 
          error: 'Invalid zone ID',
          message: 'ID must be a positive integer'
        });
        return;
      }
      
      // Get from Redis (faster) with database fallback
      let playerUuids: string[] = [];
      
      try {
        playerUuids = await this.redis.getPlayersInZone(zoneType as any, id);
      } catch (redisError) {
        logger.warn('Redis unavailable, falling back to database', { 
          zoneType, 
          zoneId: id,
          error: redisError instanceof Error ? redisError.message : 'Unknown error' 
        });
        const players = await this.db.getPlayersInZone(zoneType as any, id);
        playerUuids = players.map(p => p.player_uuid);
      }
      
      res.json({
        message: `Players in ${zoneType} ${id}`,
        zoneType,
        zoneId: id,
        playerCount: playerUuids.length,
        players: playerUuids
      });
      
    } catch (error) {
      logger.error('Failed to get players in zone', { 
        zoneType: req.params.zoneType, 
        zoneId: req.params.zoneId,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get players in zone'
      });
    }
  }

  // ========== ENDPOINTS STATISTIQUES ==========
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await this.syncService.getDetailedStats();
      
      res.json({
        message: 'Statistics retrieved',
        timestamp: new Date().toISOString(),
        data: stats
      });
      
    } catch (error) {
      logger.error('Failed to get statistics', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get statistics'
      });
    }
  }

  async getHealth(req: Request, res: Response): Promise<void> {
    try {
      const health = await this.syncService.getHealthStatus();
      
      const statusCode = health.isHealthy ? 200 : 503;
      
      res.status(statusCode).json({
        message: health.isHealthy ? 'Service healthy' : 'Issues detected',
        timestamp: new Date().toISOString(),
        data: health
      });
      
    } catch (error) {
      logger.error('Failed to get health status', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to check service health',
        timestamp: new Date().toISOString(),
        data: {
          isHealthy: false,
          issues: ['Internal health service error']
        }
      });
    }
  }

  // ========== ENDPOINTS ADMINISTRATION ==========
  async forceSync(req: Request, res: Response): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !this.isValidAdminToken(authHeader)) {
        res.status(401).json({ 
          error: 'Unauthorized',
          message: 'Admin token required'
        });
        return;
      }
      
      if (this.syncService.isSyncInProgress()) {
        res.status(409).json({ 
          error: 'Conflict',
          message: 'Synchronization already in progress'
        });
        return;
      }
      
      // Start sync in background
      this.syncService.forceFreshSync().catch(error => {
        logger.error('Forced sync error', { error: error instanceof Error ? error.message : 'Unknown error' });
      });
      
      res.json({
        message: 'Forced synchronization started',
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      logger.error('Failed to force sync', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to start synchronization'
      });
    }
  }

  async performCleanup(req: Request, res: Response): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !this.isValidAdminToken(authHeader)) {
        res.status(401).json({ 
          error: 'Unauthorized',
          message: 'Admin token required'
        });
        return;
      }
      
      const result = await this.syncService.performCleanup();
      
      res.json({
        message: 'Cleanup performed',
        timestamp: new Date().toISOString(),
        data: result
      });
      
    } catch (error) {
      logger.error('Failed to perform cleanup', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to perform cleanup'
      });
    }
  }

  private isValidAdminToken(authHeader: string): boolean {
    const token = authHeader.replace('Bearer ', '');
    const validToken = process.env.ADMIN_TOKEN;
    
    if (!validToken) {
      return false;
    }
    
    return SecurityUtils.timingSafeEqual(token, validToken);
  }
}
export default ZoneController;
