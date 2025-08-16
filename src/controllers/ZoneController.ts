// src/controllers/ZoneController.ts
import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { OptimizedSyncService } from '../services/OptimizedSyncService';
import { ChunkCalculatorService } from '../services/ChunkCalculatorService';
import { ChunkZoneDataSchema } from '../models/Zone';
import { SecurityUtils } from '../utils/security';
import { logger } from '../utils/logger';

export class ZoneController {
  constructor(
    private redis: RedisService,
    private db: DatabaseService,
    private syncService: OptimizedSyncService,
    private calculator: ChunkCalculatorService
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

  async createZone(req: Request, res: Response): Promise<void> {
    try {
      const { zoneType } = req.params;
      const { name, description, polygon, parentId } = req.body;
      
      if (!['region', 'node', 'city'].includes(zoneType)) {
        res.status(400).json({
          error: 'Invalid zone type',
          message: 'Type must be: region, node, or city'
        });
        return;
      }

      if (!name || typeof name !== 'string' || name.length === 0 || name.length > 100) {
        res.status(400).json({
          error: 'Invalid name',
          message: 'Name must be a string with 1 to 100 characters'
        });
        return;
      }

      if (!Array.isArray(polygon) || polygon.length < 3) {
        res.status(400).json({
          error: 'Invalid polygon',
          message: 'Polygon must be an array with at least 3 points'
        });
        return;
      }

      // Validate polygon
      const validation = this.calculator.validatePolygon(polygon);
      if (!validation.valid) {
        res.status(400).json({
          error: 'Invalid polygon',
          message: validation.error
        });
        return;
      }

      // Create zone
      const newZoneId = await this.db.createZone(
        zoneType as any, 
        name, 
        description || null, 
        polygon, 
        parentId
      );

      res.status(201).json({
        message: 'Zone created successfully',
        data: {
          id: newZoneId,
          type: zoneType,
          name,
          description,
          polygon,
          parentId,
          polygonStats: this.calculator.getPolygonStats(polygon)
        }
      });
      
    } catch (error) {
      logger.error('Failed to create zone', { 
        zoneType: req.params.zoneType,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to create zone'
      });
    }
  }

  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = this.syncService.getStats();
      
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
      
      if (!this.syncService.isReady()) {
        res.status(409).json({ 
          error: 'Conflict',
          message: 'Synchronization service not ready'
        });
        return;
      }
      
      // Start sync in background
      this.syncService.forceFullSync().catch((error: Error) => {
        logger.error('Forced sync error', { 
          error: error.message 
        });
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