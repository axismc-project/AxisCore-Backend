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

  // ========== ZONE CREATION & EDITING ==========
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

      // Validate parent-child relationships
      if (zoneType === 'node' && !parentId) {
        res.status(400).json({
          error: 'Missing parent',
          message: 'Node must have a region_id'
        });
        return;
      }

      if (zoneType === 'city' && !parentId) {
        res.status(400).json({
          error: 'Missing parent', 
          message: 'City must have a node_id'
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

  async addZonePoint(req: Request, res: Response): Promise<void> {
    try {
      const { zoneType, zoneId } = req.params;
      const { chunkX, chunkZ, insertAfter } = req.body;
      
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
      
      if (!SecurityUtils.isValidChunkCoordinate(chunkX) || !SecurityUtils.isValidChunkCoordinate(chunkZ)) {
        res.status(400).json({
          error: 'Invalid chunk coordinates',
          message: 'chunkX and chunkZ must be valid integers within bounds'
        });
        return;
      }

      // Get current zone
      const zone = await this.db.getZoneById(zoneType as any, id);
      if (!zone) {
        res.status(404).json({
          error: 'Zone not found',
          message: `Zone ${zoneType}:${id} not found`
        });
        return;
      }

      // Add point to polygon
      const newPolygon = [...zone.chunk_boundary];
      const insertIndex = insertAfter !== undefined ? insertAfter + 1 : newPolygon.length;
      newPolygon.splice(insertIndex, 0, [chunkX, chunkZ]);

      // Validate new polygon
      const validation = this.calculator.validatePolygon(newPolygon);
      if (!validation.valid) {
        res.status(400).json({
          error: 'Invalid polygon',
          message: validation.error
        });
        return;
      }

      // Update zone
      await this.db.updateZonePolygon(zoneType as any, id, newPolygon);

      res.json({
        message: 'Point added successfully',
        data: {
          zoneType,
          zoneId: id,
          newPoint: [chunkX, chunkZ],
          insertedAt: insertIndex,
          newPolygon: newPolygon,
          polygonStats: this.calculator.getPolygonStats(newPolygon)
        }
      });
      
    } catch (error) {
      logger.error('Failed to add zone point', { 
        zoneType: req.params.zoneType, 
        zoneId: req.params.zoneId,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to add zone point'
      });
    }
  }

  // ========== DIAGNOSTICS ==========
  async getDiagnostics(req: Request, res: Response): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !this.isValidAdminToken(authHeader)) {
        res.status(401).json({ 
          error: 'Unauthorized',
          message: 'Admin token required'
        });
        return;
      }

      // Get zone data with polygon analysis
      const [regions, nodes, cities] = await Promise.all([
        this.db.getAllRegions(),
        this.db.getAllNodes(), 
        this.db.getAllCities()
      ]);

      const regionAnalysis = regions.map(region => {
        const chunks = this.calculator.getChunksInPolygon(region.chunk_boundary);
        const bounds = this.getPolygonBounds(region.chunk_boundary);
        
        return {
          id: region.id,
          name: region.name,
          polygonPoints: region.chunk_boundary.length,
          chunksGenerated: chunks.length,
          bounds: bounds,
          polygonArea: Math.abs(this.calculatePolygonArea(region.chunk_boundary)),
          polygonCoordinates: region.chunk_boundary
        };
      });

      const nodeAnalysis = nodes.map(node => {
        const chunks = this.calculator.getChunksInPolygon(node.chunk_boundary);
        return {
          id: node.id,
          name: node.name,
          regionId: node.region_id,
          chunksGenerated: chunks.length
        };
      });

      const cityAnalysis = cities.map(city => {
        const chunks = this.calculator.getChunksInPolygon(city.chunk_boundary);
        return {
          id: city.id,
          name: city.name,
          nodeId: city.node_id,
          chunksGenerated: chunks.length
        };
      });

      const totalChunks = regionAnalysis.reduce((sum, r) => sum + r.chunksGenerated, 0) +
                         nodeAnalysis.reduce((sum, n) => sum + n.chunksGenerated, 0) +
                         cityAnalysis.reduce((sum, c) => sum + c.chunksGenerated, 0);

      res.json({
        message: 'Zone diagnostics',
        summary: {
          totalRegions: regions.length,
          totalNodes: nodes.length, 
          totalCities: cities.length,
          totalChunksGenerated: totalChunks
        },
        regions: regionAnalysis,
        nodes: nodeAnalysis,
        cities: cityAnalysis
      });

    } catch (error) {
      logger.error('Failed to get diagnostics', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({ 
        error: 'Server error',
        message: 'Unable to get diagnostics'
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

  // ========== HELPER METHODS ==========
  private getPolygonBounds(polygon: any[]): any {
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const point of polygon) {
      if (!point || !Array.isArray(point) || point.length < 2) continue;
      
      const [x, z] = point;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }

    return { 
      minX: Math.floor(minX), 
      maxX: Math.ceil(maxX),
      minZ: Math.floor(minZ), 
      maxZ: Math.ceil(maxZ),
      width: Math.ceil(maxX) - Math.floor(minX),
      height: Math.ceil(maxZ) - Math.floor(minZ)
    };
  }

  private calculatePolygonArea(polygon: any[]): number {
    let area = 0;
    const numPoints = polygon.length;

    for (let i = 0; i < numPoints; i++) {
      const j = (i + 1) % numPoints;
      const pointI = polygon[i];
      const pointJ = polygon[j];
      
      if (!pointI || !pointJ || !Array.isArray(pointI) || !Array.isArray(pointJ)) continue;
      
      area += pointI[0] * pointJ[1];
      area -= pointJ[0] * pointI[1];
    }

    return area / 2;
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
export default PlayerController;