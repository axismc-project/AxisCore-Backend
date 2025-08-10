import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import dotenv from 'dotenv';

// Services
import { DatabaseService } from './services/DatabaseService';
import { RedisService } from './services/RedisService';
import { ZoneSyncService } from './services/ZoneSyncService';
import { ChunkCalculatorService } from './services/ChunkCalculatorService';
import { ApiKeyService } from './services/ApiKeyService';

// Controllers
import { ZoneController } from './controllers/ZoneController';
import { PlayerController } from './controllers/PlayerController';

// WebSocket
import { ZoneWebSocketServer } from './websocket/ZoneWebSocketServer';

// Utils
import { logger } from './utils/logger';
import { SecurityUtils } from './utils/security';
import { RedisConfig } from './config/redis';
import { DatabaseConfig } from './config/database';

// Load environment variables
dotenv.config();

class Application {
  private app: express.Application;
  private server: any;
  private wsServer: ZoneWebSocketServer | null = null;
  
  // Services
  private dbService!: DatabaseService;
  private redisService!: RedisService;
  private calculatorService!: ChunkCalculatorService;
  private syncService!: ZoneSyncService;
  private apiKeyService!: ApiKeyService;
  
  // Controllers
  private zoneController!: ZoneController;
  private playerController!: PlayerController;

  // Application state
  private isShuttingDown = false;

  constructor() {
    this.app = express();
    this.initializeServices();
    this.initializeControllers();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private initializeServices(): void {
    try {
      this.dbService = new DatabaseService();
      this.redisService = new RedisService();
      this.calculatorService = new ChunkCalculatorService();
      this.apiKeyService = new ApiKeyService();
      this.syncService = new ZoneSyncService(
        this.dbService,
        this.redisService,
        this.calculatorService
      );
      logger.info('Services initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize services', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private initializeControllers(): void {
    try {
      this.zoneController = new ZoneController(
        this.redisService,
        this.dbService,
        this.syncService,
        this.calculatorService
      );
      
      this.playerController = new PlayerController(
        this.redisService,
        this.dbService
      );
      logger.info('Controllers initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize controllers', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private setupMiddleware(): void {
    // Check if app is shutting down
    this.app.use((req, res, next) => {
      if (this.isShuttingDown) {
        res.status(503).json({
          error: 'Service unavailable',
          message: 'Application is shutting down',
          timestamp: new Date().toISOString()
        });
        return;
      }
      next();
    });

    // Security
    this.app.use(helmet({
      contentSecurityPolicy: false, // Disabled for WebSocket
      crossOriginEmbedderPolicy: false
    }));
    
    // CORS
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
    }));
    
    // Parsing with limits
    this.app.use(express.json({ 
      limit: '10mb',
      strict: true,
      type: 'application/json'
    }));
    this.app.use(express.urlencoded({ 
      extended: true,
      limit: '10mb'
    }));
    
    // Request logging with more details
    this.app.use((req, res, next) => {
      const start = Date.now();
      const originalSend = res.send;
      
      res.send = function(data) {
        const duration = Date.now() - start;
        const apiKey = (req as any).apiKey;
        
        logger.info('HTTP request', {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: duration,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          apiKeyName: apiKey?.keyName || 'anonymous'
        });
        return originalSend.call(this, data);
      };
      
      next();
    });

    // Additional security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('X-Powered-By', 'Minecraft-Zones-Backend');
      next();
    });

    // ✅ API Key Authentication Middleware (appliqué à /api/*)
    this.app.use('/api', this.authenticateApiKey.bind(this));
  }

  // ✅ Middleware d'authentification API Key
  private async authenticateApiKey(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
    // Endpoints publics (pas d'authentification requise)
    const publicEndpoints = [
      '/api/',              // Route racine
      '/api/health'         // Health check public
    ];

    if (publicEndpoints.includes(req.path)) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'] as string;
    
    let apiKey: string | null = null;

    // Supporter Authorization: Bearer <key> et X-API-Key: <key>
    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.replace('Bearer ', '');
    } else if (apiKeyHeader) {
      apiKey = apiKeyHeader;
    }

    if (!apiKey) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'API key required in Authorization header (Bearer <key>) or X-API-Key header',
        documentation: 'https://docs.example.com/authentication'
      });
      return;
    }

    try {
      // Valider l'API key
      const validatedKey = await this.apiKeyService.validateApiKey(apiKey);
      
      if (!validatedKey) {
        res.status(401).json({
          error: 'Invalid API key',
          message: 'The provided API key is invalid, expired, or inactive'
        });
        return;
      }

      // Vérifier les permissions pour cet endpoint
      const requiredPermission = this.getRequiredPermission(req.method, req.path);
      
      if (!this.apiKeyService.hasPermission(validatedKey, requiredPermission)) {
        res.status(403).json({
          error: 'Insufficient permissions',
          message: `This API key does not have permission: ${requiredPermission}`,
          required: requiredPermission,
          available: validatedKey.permissions
        });
        return;
      }

      // Vérifier le rate limiting
      const rateLimitOk = await this.apiKeyService.checkRateLimit(
        validatedKey.id, 
        req.path, 
        validatedKey.rateLimitPerMinute
      );

      if (!rateLimitOk) {
        res.status(429).json({
          error: 'Rate limit exceeded',
          message: `Too many requests. Limit: ${validatedKey.rateLimitPerMinute} requests per minute`,
          retryAfter: 60,
          keyName: validatedKey.keyName
        });
        return;
      }

      // Enregistrer l'utilisation (async, ne pas bloquer la requête)
      this.apiKeyService.recordUsage(validatedKey.id, req.path).catch(error => {
        logger.error('Failed to record API usage', { 
          keyId: validatedKey.id, 
          endpoint: req.path, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      });

      // Attacher les infos de l'API key à la requête
      (req as any).apiKey = validatedKey;

      next();
    } catch (error) {
      logger.error('Authentication error', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({
        error: 'Authentication error',
        message: 'Unable to validate API key'
      });
    }
  }

  // ✅ Mapping des permissions par endpoint
  private getRequiredPermission(method: string, path: string): string {
    // Endpoints d'administration
    if (path.startsWith('/api/admin/')) {
      return 'admin:*';
    }

    // Endpoints de gestion des zones
    if (path.includes('/api/zone/') && method === 'POST') {
      return 'zone:write';
    }
    if (path.includes('/api/zone/') || path.includes('/api/chunk/')) {
      return 'zone:read';
    }

    // Endpoints des joueurs
    if (path.includes('/api/player/') && (method === 'POST' || method === 'PUT')) {
      return 'player:write';
    }
    if (path.includes('/api/player/')) {
      return 'player:read';
    }

    // Endpoints de monitoring
    if (path.includes('/api/stats') || path.includes('/api/system')) {
      return 'stats:read';
    }
    if (path.includes('/api/batch/')) {
      return 'batch:manage';
    }

    // Zones hiérarchiques
    if (path.includes('/api/zones/')) {
      return 'zone:read';
    }

    // Par défaut, permission de lecture
    return 'api:read';
  }

  private setupRoutes(): void {
    // ========== ROUTES PUBLIQUES ==========
    
    // Root route (public)
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Minecraft Zones Backend',
        version: '1.0.0',
        status: 'running',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        authentication: {
          required: true,
          methods: ['Bearer Token', 'X-API-Key header'],
          documentation: 'https://docs.example.com/authentication'
        },
        endpoints: {
          zones: '/api/zone/*',
          players: '/api/player/*',
          chunks: '/api/chunk/*',
          stats: '/api/stats',
          health: '/api/health',
          admin: '/api/admin/*'
        },
        websocket: {
          url: 'ws://localhost:3000/ws/zones',
          authentication: 'API Key required (query param: ?api_key=xxx)',
          permissions: 'zone:read required',
          description: 'Real-time zone events broadcast (read-only)'
        }
      });
    });

    // Health check public (pas d'auth requise)
    this.app.get('/api/health', async (req, res) => {
      try {
        const health = await this.syncService.getHealthStatus();
        const statusCode = health.isHealthy ? 200 : 503;
        
        res.status(statusCode).json({
          message: health.isHealthy ? 'Service healthy' : 'Issues detected',
          timestamp: new Date().toISOString(),
          data: health
        });
      } catch (error) {
        res.status(500).json({
          error: 'Health check failed',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
    });

    // ========== ROUTES PROTÉGÉES PAR API KEY ==========

    // ========== API KEY MANAGEMENT (Admin uniquement) ==========
    this.app.post('/api/admin/api-keys', this.createApiKey.bind(this));
    this.app.delete('/api/admin/api-keys/:keyName', this.revokeApiKey.bind(this));
    this.app.get('/api/admin/api-keys/stats', this.getApiKeyStats.bind(this));
    this.app.get('/api/admin/api-keys', this.listApiKeys.bind(this));

    // ========== ZONE ENDPOINTS ==========
    
    // Chunk zones
    this.app.get('/api/chunk/:chunkX/:chunkZ', 
      this.validateChunkParams.bind(this),
      this.zoneController.getChunkZone.bind(this.zoneController)
    );
    
    // Zone hierarchy
    this.app.get('/api/zones/hierarchy', 
      this.zoneController.getZoneHierarchy.bind(this.zoneController)
    );
    
    // Zone par ID
    this.app.get('/api/zone/:zoneType/:zoneId', 
      this.validateZoneParams.bind(this),
      this.zoneController.getZoneById.bind(this.zoneController)
    );
    
    // Joueurs dans une zone
    this.app.get('/api/zone/:zoneType/:zoneId/players', 
      this.validateZoneParams.bind(this),
      this.zoneController.getPlayersInZone.bind(this.zoneController)
    );

    // Zone creation and editing (Admin)
    this.app.post('/api/zone/:zoneType/create',
      this.zoneController.createZone.bind(this.zoneController)
    );

    this.app.post('/api/zone/:zoneType/:zoneId/add-point',
      this.zoneController.addZonePoint.bind(this.zoneController)
    );

    // ========== PLAYER ENDPOINTS ==========
    
    // Player creation
this.app.post('/api/player/connection', this.playerController.handlePlayerConnection.bind(this.playerController));


    // Player info
    this.app.get('/api/player/:uuid', 
      this.validateUUIDParam.bind(this),
      this.playerController.getPlayerInfo.bind(this.playerController)
    );
    
    // Position updates
    this.app.post('/api/player/:uuid/position', 
      this.validateUUIDParam.bind(this),
      this.validatePositionBody.bind(this),
      this.playerController.updatePlayerPosition.bind(this.playerController)
    );

    // Chunk updates (optimisé)
    this.app.post('/api/player/:uuid/chunk', 
      this.validateUUIDParam.bind(this),
      this.validateChunkBody.bind(this),
      this.playerController.updatePlayerChunk.bind(this.playerController)
    );
    
    // Player zones
    this.app.get('/api/player/:uuid/zones', 
      this.validateUUIDParam.bind(this),
      this.playerController.getPlayerCurrentZones.bind(this.playerController)
    );

    // ========== MONITORING & STATS ==========
    
    // Statistiques générales
    this.app.get('/api/stats', 
      this.zoneController.getStats.bind(this.zoneController)
    );

    // System info détaillé
    this.app.get('/api/system', this.getSystemInfo.bind(this));

    // ========== BATCH SERVICE ==========
    
    // Batch statistics
    this.app.get('/api/batch/stats',
      this.playerController.getBatchStats.bind(this.playerController)
    );

    // Force flush batch
    this.app.post('/api/batch/flush',
      this.playerController.forceFlushBatch.bind(this.playerController)
    );

    // ========== ADMIN OPERATIONS ==========
    
    // Force sync
    this.app.post('/api/admin/sync', 
      this.zoneController.forceSync.bind(this.zoneController)
    );
    
    // Cleanup
    this.app.post('/api/admin/cleanup', 
      this.zoneController.performCleanup.bind(this.zoneController)
    );

    // ========== 404 HANDLER ==========
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint not found',
        message: `${req.method} ${req.originalUrl} does not exist`,
        timestamp: new Date().toISOString(),
        suggestion: 'Check the API documentation for available endpoints',
        availableEndpoints: {
          zones: ['GET /api/chunk/:x/:z', 'GET /api/zones/hierarchy', 'GET /api/zone/:type/:id'],
          players: ['POST /api/player/connection', 'GET /api/player/:uuid', 'POST /api/player/:uuid/position'],
          monitoring: ['GET /api/stats', 'GET /api/health', 'GET /api/system'],
          admin: ['POST /api/admin/sync', 'GET /api/admin/api-keys/stats'],
          websocket: 'ws://localhost:3000/ws/zones?api_key=your_key'
        }
      });
    });
  }

  // ========== API KEY MANAGEMENT ENDPOINTS ==========

  private async createApiKey(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { keyName, permissions, description, expiresAt, rateLimitPerHour, rateLimitPerMinute } = req.body;

      // Validation
      if (!keyName || !permissions || !Array.isArray(permissions)) {
        res.status(400).json({
          error: 'Invalid request',
          message: 'keyName and permissions array are required',
          example: {
            keyName: 'my_plugin_key',
            permissions: ['player:read', 'zone:read'],
            description: 'Optional description',
            rateLimitPerMinute: 60
          }
        });
        return;
      }

      // Vérifier que les permissions sont valides
      const validPermissions = [
        'player:read', 'player:write', 'player:*',
        'zone:read', 'zone:write', 'zone:*',
        'chunk:read', 'stats:read', 'batch:manage',
        'admin:*', 'api:read', '*'
      ];

      const invalidPermissions = permissions.filter((p: string) => !validPermissions.includes(p));
      if (invalidPermissions.length > 0) {
        res.status(400).json({
          error: 'Invalid permissions',
          message: `Invalid permissions: ${invalidPermissions.join(', ')}`,
          validPermissions
        });
        return;
      }

      const apiKey = await this.apiKeyService.createApiKey(
        keyName,
        permissions,
        description,
        expiresAt ? new Date(expiresAt) : undefined,
        rateLimitPerHour || 1000,
        rateLimitPerMinute || 60
      );

      res.status(201).json({
        message: 'API key created successfully',
        data: {
          keyName,
          apiKey, // ⚠️ Ne sera affiché qu'une seule fois !
          permissions,
          description,
          rateLimitPerMinute: rateLimitPerMinute || 60,
          rateLimitPerHour: rateLimitPerHour || 1000,
          expiresAt
        },
        warning: 'This API key will only be shown once. Please save it securely.',
        websocketUsage: `ws://localhost:3000/ws/zones?api_key=${apiKey}`
      });

    } catch (error) {
      logger.error('Failed to create API key', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to create API key'
      });
    }
  }

  private async revokeApiKey(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { keyName } = req.params;
      
      if (!keyName) {
        res.status(400).json({
          error: 'Invalid request',
          message: 'keyName parameter is required'
        });
        return;
      }

      const revoked = await this.apiKeyService.revokeApiKey(keyName);

      if (revoked) {
        res.json({
          message: 'API key revoked successfully',
          keyName,
          timestamp: new Date().toISOString()
        });
      } else {
        res.status(404).json({
          error: 'API key not found',
          message: `No active API key found with name: ${keyName}`
        });
      }

    } catch (error) {
      logger.error('Failed to revoke API key', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to revoke API key'
      });
    }
  }

  private async getApiKeyStats(req: express.Request, res: express.Response): Promise<void> {
    try {
      const { keyName } = req.query;
      const stats = await this.apiKeyService.getUsageStats(keyName as string);

      res.json({
        message: 'API key statistics',
        timestamp: new Date().toISOString(),
        data: stats
      });

    } catch (error) {
      logger.error('Failed to get API key stats', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to get API key statistics'
      });
    }
  }

  private async listApiKeys(req: express.Request, res: express.Response): Promise<void> {
    try {
      const keys = await this.apiKeyService.getUsageStats();

      // Ne pas exposer les clés réelles, seulement les métadonnées
      const safeKeys = keys.map((key: any) => ({
        keyName: key.key_name,
        usageCount: key.usage_count,
        lastUsedAt: key.last_used_at,
        createdAt: key.created_at,
        recentRequests: key.recent_requests
      }));

      res.json({
        message: 'API keys list',
        count: safeKeys.length,
        data: safeKeys
      });

    } catch (error) {
      logger.error('Failed to list API keys', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({
        error: 'Server error',
        message: 'Unable to list API keys'
      });
    }
  }

  // ========== VALIDATION MIDDLEWARES ==========

  private validateChunkParams(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const { chunkX, chunkZ } = req.params;
    
    const x = parseInt(chunkX);
    const z = parseInt(chunkZ);
    
    if (!SecurityUtils.isValidChunkCoordinate(x) || !SecurityUtils.isValidChunkCoordinate(z)) {
      res.status(400).json({
        error: 'Invalid chunk coordinates',
        message: 'chunkX and chunkZ must be valid integers within bounds',
        received: { chunkX, chunkZ },
        limits: {
          min: process.env.CHUNK_MIN || -2000,
          max: process.env.CHUNK_MAX || 2000
        }
      });
      return;
    }
    
    next();
  }

  private validateZoneParams(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const { zoneType, zoneId } = req.params;
    
    if (!['region', 'node', 'city'].includes(zoneType)) {
      res.status(400).json({
        error: 'Invalid zone type',
        message: 'Type must be: region, node, or city',
        received: zoneType,
        allowed: ['region', 'node', 'city']
      });
      return;
    }
    
    const id = parseInt(zoneId);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({
        error: 'Invalid zone ID',
        message: 'ID must be a positive integer',
        received: zoneId
      });
      return;
    }
    
    next();
  }

  private validateUUIDParam(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const { uuid } = req.params;
    
    if (!SecurityUtils.isValidUUID(uuid)) {
      res.status(400).json({
        error: 'Invalid UUID',
        message: 'UUID must be in valid format (e.g. 123e4567-e89b-12d3-a456-426614174000)',
        received: uuid
      });
      return;
    }
    
    next();
  }

  private validatePositionBody(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const { name, x, y, z } = req.body;
    
    if (!name || typeof name !== 'string' || name.length === 0 || name.length > 16) {
      res.status(400).json({
        error: 'Invalid name',
        message: 'Name must be a string with 1 to 16 characters',
        received: { name, type: typeof name, length: name?.length }
      });
      return;
    }
    
    if (!SecurityUtils.isValidCoordinate(x) || !SecurityUtils.isValidCoordinate(y) || !SecurityUtils.isValidCoordinate(z)) {
      res.status(400).json({
        error: 'Invalid coordinates',
        message: 'x, y, z must be valid finite numbers within bounds',
        received: { x, y, z }
      });
      return;
    }
    
    next();
  }

  private validateChunkBody(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const { chunkX, chunkZ } = req.body;
    
    if (!SecurityUtils.isValidChunkCoordinate(chunkX) || !SecurityUtils.isValidChunkCoordinate(chunkZ)) {
      res.status(400).json({
        error: 'Invalid chunk coordinates',
        message: 'chunkX and chunkZ must be valid integers within bounds',
        received: { chunkX, chunkZ }
      });
      return;
    }
    
    next();
  }

  // ========== SYSTEM INFO ==========

  private async getSystemInfo(req: express.Request, res: express.Response): Promise<void> {
    try {
      const [dbStats, redisStats] = await Promise.all([
        DatabaseConfig.getPoolStats(),
        this.redisService.getStats().catch(() => ({ 
          connectionStatus: 'error', 
          activePlayers: 0, 
          cachedChunks: 0, 
          memoryUsage: 'Unknown' 
        }))
      ]);

      const apiKey = (req as any).apiKey;

      res.json({
        system: {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage()
        },
        database: {
          ...dbStats,
          connectionTest: await DatabaseConfig.testConnection()
        },
        redis: redisStats,
        sync: {
          isReady: this.syncService.isReady(),
          lastSync: this.syncService.getLastSyncTime(),
          inProgress: this.syncService.isSyncInProgress()
        },
        websocket: {
          connected: this.wsServer?.getConnectedClientsCount() || 0,
          clients: this.wsServer?.getConnectedClients() || [],
          endpoint: 'ws://localhost:3000/ws/zones',
          authenticationRequired: true,
          requiredPermission: 'zone:read'
        },
        authentication: {
          currentKey: apiKey?.keyName,
          permissions: apiKey?.permissions,
          usageCount: apiKey?.usageCount,
          lastUsed: apiKey?.lastUsedAt
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to get system info', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      res.status(500).json({
        error: 'Failed to get system information',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // ========== ERROR HANDLING ==========

  private setupErrorHandling(): void {
    // Global error handler
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      const errorId = Date.now().toString(36) + Math.random().toString(36).substr(2);
      const apiKey = (req as any).apiKey;
      
      logger.error('Unhandled error', {
        errorId,
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        apiKeyName: apiKey?.keyName || 'anonymous'
      });
      
      const isDevelopment = process.env.NODE_ENV === 'development';
      
      res.status(500).json({
        error: 'Internal server error',
        message: isDevelopment ? error.message : 'An error occurred',
        errorId,
        timestamp: new Date().toISOString(),
        ...(isDevelopment && { stack: error.stack })
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled promise rejection', {
        reason,
        promise: promise.toString()
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack
      });
      
      this.gracefulShutdown('UNCAUGHT_EXCEPTION');
    });

    // Handle warnings
    process.on('warning', (warning) => {
      logger.warn('Node.js warning', {
        name: warning.name,
        message: warning.message,
        stack: warning.stack
      });
    });
  }

async start(): Promise<void> {
   try {
     const port = process.env.PORT || 3000;
     
     logger.info('Starting Minecraft Zones Backend');
     
     // 1. Validate environment
     this.validateEnvironment();
     
     // 2. Initialize Redis
     await this.redisService.init();
     logger.info('Redis initialized successfully');
     
     // 3. Test PostgreSQL
     const dbConnected = await DatabaseConfig.testConnection();
     if (!dbConnected) {
       throw new Error('Unable to connect to PostgreSQL');
     }
     logger.info('PostgreSQL connected successfully');
     
     // 4. Initialize sync service
     await this.syncService.init();
     logger.info('Synchronization service initialized successfully');
     
     // 5. Start HTTP server
     this.server = createServer(this.app);
     
     // 6. Initialize WebSocket with API Key service
     this.wsServer = new ZoneWebSocketServer(
       this.server, 
       this.redisService,
       this.apiKeyService // ✅ Ajout du service API Key
     );
     logger.info('WebSocket server initialized successfully');
     
     // 7. Start listening
     await new Promise<void>((resolve, reject) => {
       this.server.listen(port, (err?: Error) => {
         if (err) {
           reject(err);
         } else {
           resolve();
         }
       });
     });
     
     logger.info('🚀 Minecraft Zones Backend started successfully', { 
       port,
       environment: process.env.NODE_ENV || 'development'
     });
     
     logger.info('📡 WebSocket Zone Events available', { 
       endpoint: `ws://localhost:${port}/ws/zones`,
       authentication: 'API Key required (?api_key=xxx)',
       permissions: 'zone:read required',
       description: 'Read-only zone events broadcast'
     });
     
     logger.info('🌐 REST API available', { 
       endpoint: `http://localhost:${port}/api`,
       documentation: 'Check GET / for endpoint list'
     });
     
     logger.info('🔐 Authentication', {
       method: 'API Key required for all endpoints (except health)',
       headers: ['Authorization: Bearer <key>', 'X-API-Key: <key>'],
       management: `POST /api/admin/api-keys (admin required)`,
       websocket: 'Query param: ?api_key=<key> OR Authorization header'
     });
     
     // 8. Setup graceful shutdown
     this.setupGracefulShutdown();
     
   } catch (error) {
     logger.error('❌ Failed to start application', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     await this.cleanup();
     process.exit(1);
   }
 }

 private validateEnvironment(): void {
   const required = ['DATABASE_URL', 'REDIS_URL'];
   const missing = required.filter(key => !process.env[key]);
   
   if (missing.length > 0) {
     throw new Error(`Missing environment variables: ${missing.join(', ')}`);
   }
   
   // Optionnel mais recommandé
   const recommended = ['ADMIN_TOKEN', 'CORS_ORIGIN'];
   const missingRecommended = recommended.filter(key => !process.env[key]);
   
   if (missingRecommended.length > 0) {
     logger.warn('⚠️ Missing recommended environment variables', { 
       missing: missingRecommended,
       suggestion: 'Set these for enhanced security and functionality'
     });
   }
   
   logger.info('✅ Environment variables validated successfully');
 }

 private setupGracefulShutdown(): void {
   const signals = ['SIGTERM', 'SIGINT'];
   
   signals.forEach(signal => {
     process.on(signal, () => this.gracefulShutdown(signal));
   });
   
   logger.info('🛡️ Graceful shutdown handlers registered');
 }

 private async gracefulShutdown(signal: string): Promise<void> {
   if (this.isShuttingDown) {
     logger.warn('⚠️ Shutdown signal ignored - already shutting down', { signal });
     return;
   }
   
   this.isShuttingDown = true;
   logger.info('🔄 Graceful shutdown initiated', { signal });
   
   try {
     // 1. Stop accepting new connections
     if (this.server) {
       logger.info('📡 Closing HTTP server...');
       this.server.close();
     }
     
     // 2. Wait for ongoing requests to complete (max 5s)
     logger.info('⏳ Waiting for ongoing requests to complete...');
     await new Promise(resolve => setTimeout(resolve, 5000));
     
     // 3. Cleanup services
     await this.cleanup();
     
     logger.info('✅ Graceful shutdown completed successfully');
     process.exit(0);
   } catch (error) {
     logger.error('❌ Error during shutdown', { 
       error: error instanceof Error ? error.message : 'Unknown error' 
     });
     process.exit(1);
   }
 }

 private async cleanup(): Promise<void> {
   logger.info('🧹 Starting cleanup process...');
   
   const cleanupPromises: Promise<void>[] = [];
   
   // Close WebSocket
   if (this.wsServer) {
     logger.info('🔌 Closing WebSocket server...');
     cleanupPromises.push(
       new Promise(resolve => {
         this.wsServer!.close();
         resolve();
       })
     );
   }
   
   // Stop synchronization service
   if (this.syncService) {
     logger.info('⏹️ Stopping synchronization service...');
     cleanupPromises.push(this.syncService.destroy());
   }

   // Stop player controller (batch service)
   if (this.playerController) {
     logger.info('👥 Stopping player controller...');
     cleanupPromises.push(this.playerController.destroy());
   }
   
   // Close Redis
   if (this.redisService) {
     logger.info('🔴 Closing Redis connections...');
     cleanupPromises.push(this.redisService.destroy());
   }
   
   // Close PostgreSQL pool
   logger.info('🐘 Closing PostgreSQL pool...');
   cleanupPromises.push(DatabaseConfig.closeAll());
   
   // Wait for all cleanups (max 10s)
   await Promise.race([
     Promise.allSettled(cleanupPromises),
     new Promise(resolve => setTimeout(resolve, 10000))
   ]);
   
   logger.info('✅ Cleanup completed');
 }

 // ========== PUBLIC API FOR TESTS ==========

 getApp(): express.Application {
   return this.app;
 }

 getWSServer(): ZoneWebSocketServer | null {
   return this.wsServer;
 }

 getServices() {
   return {
     database: this.dbService,
     redis: this.redisService,
     calculator: this.calculatorService,
     sync: this.syncService,
     apiKey: this.apiKeyService
   };
 }

 getControllers() {
   return {
     zone: this.zoneController,
     player: this.playerController
   };
 }

 async stop(): Promise<void> {
   await this.gracefulShutdown('MANUAL_STOP');
 }

 isReady(): boolean {
   return !this.isShuttingDown && 
          this.syncService?.isReady() && 
          this.redisService !== null && 
          this.dbService !== null;
 }
}

// ========== APPLICATION STARTUP ==========

const app = new Application();

// Start only if this is not an import (for tests)
if (require.main === module) {
 app.start().catch(error => {
   logger.error('💥 Fatal startup error', { 
     error: error instanceof Error ? error.message : 'Unknown error',
     stack: error instanceof Error ? error.stack : undefined
   });
   process.exit(1);
 });
}

export default Application;