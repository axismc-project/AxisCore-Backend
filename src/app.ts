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
        this.syncService
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
      allowedHeaders: ['Content-Type', 'Authorization']
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
        logger.info('HTTP request', {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: duration,
          ip: req.ip,
          userAgent: req.get('User-Agent')
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
      next();
    });
  }

  private setupRoutes(): void {
    // Root route with more information
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Minecraft Zones Backend',
        version: '1.0.0',
        status: 'running',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        services: {
          sync: this.syncService.isReady(),
          lastSync: this.syncService.getLastSyncTime(),
          syncInProgress: this.syncService.isSyncInProgress()
        }
      });
    });

    // Zone API routes with validation
    this.app.get('/api/chunk/:chunkX/:chunkZ', 
      this.validateChunkParams.bind(this),
      this.zoneController.getChunkZone.bind(this.zoneController)
    );
    
    // Dans setupRoutes(), ajouter ces routes :

// Player creation
this.app.post('/api/player/create',
  this.playerController.createPlayer.bind(this.playerController)
);

// Zone creation and editing
this.app.post('/api/zone/:zoneType/create',
  this.validateAdminAuth.bind(this),
  this.zoneController.createZone.bind(this.zoneController)
);

this.app.post('/api/zone/:zoneType/:zoneId/add-point',
  this.validateAdminAuth.bind(this),
  this.zoneController.addZonePoint.bind(this.zoneController)
);
    this.app.get('/api/zones/hierarchy', 
      this.zoneController.getZoneHierarchy.bind(this.zoneController)
    );
    
    this.app.get('/api/zone/:zoneType/:zoneId', 
      this.validateZoneParams.bind(this),
      this.zoneController.getZoneById.bind(this.zoneController)
    );
    
    this.app.get('/api/zone/:zoneType/:zoneId/players', 
      this.validateZoneParams.bind(this),
      this.zoneController.getPlayersInZone.bind(this.zoneController)
    );

    // Player API routes with validation
    this.app.get('/api/player/:uuid', 
      this.validateUUIDParam.bind(this),
      this.playerController.getPlayerInfo.bind(this.playerController)
    );
    
    this.app.post('/api/player/:uuid/position', 
      this.validateUUIDParam.bind(this),
      this.validatePositionBody.bind(this),
      this.playerController.updatePlayerPosition.bind(this.playerController)
    );

    // NEW: Separate chunk update endpoint
    this.app.post('/api/player/:uuid/chunk', 
      this.validateUUIDParam.bind(this),
      this.validateChunkBody.bind(this),
      this.playerController.updatePlayerChunk.bind(this.playerController)
    );
    
    this.app.get('/api/player/:uuid/zones', 
      this.validateUUIDParam.bind(this),
      this.playerController.getPlayerCurrentZones.bind(this.playerController)
    );

    // Statistics and monitoring routes
    this.app.get('/api/stats', 
      this.zoneController.getStats.bind(this.zoneController)
    );
    
    this.app.get('/api/health', 
      this.zoneController.getHealth.bind(this.zoneController)
    );

    // NEW: Batch service routes
    this.app.get('/api/batch/stats',
      this.playerController.getBatchStats.bind(this.playerController)
    );

    this.app.post('/api/batch/flush',
      this.validateAdminAuth.bind(this),
      this.playerController.forceFlushBatch.bind(this.playerController)
    );

    // System diagnostic route
    this.app.get('/api/system', this.getSystemInfo.bind(this));

    // Admin routes with authentication
    this.app.post('/api/admin/sync', 
      this.validateAdminAuth.bind(this),
      this.zoneController.forceSync.bind(this.zoneController)
    );
    
    this.app.post('/api/admin/cleanup', 
      this.validateAdminAuth.bind(this),
      this.zoneController.performCleanup.bind(this.zoneController)
    );

    // 404 route with more details
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint not found',
        message: `${req.method} ${req.originalUrl} does not exist`,
        timestamp: new Date().toISOString(),
        availableEndpoints: [
          'GET /',
          'GET /api/chunk/:chunkX/:chunkZ',
          'GET /api/zones/hierarchy',
          'GET /api/zone/:type/:id',
          'GET /api/player/:uuid',
          'POST /api/player/:uuid/position',
          'POST /api/player/:uuid/chunk',
          'GET /api/stats',
          'GET /api/health',
          'GET /api/batch/stats'
        ]
      });
    });
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
        received: { chunkX, chunkZ }
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

  // NEW: Validation for chunk-only updates
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

  private validateAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const authHeader = req.headers.authorization;
    const validToken = process.env.ADMIN_TOKEN;
    
    if (!validToken) {
      res.status(500).json({
        error: 'Configuration missing',
        message: 'Admin token not configured'
      });
      return;
    }
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Authorization header with Bearer token required'
      });
      return;
    }
    
    const token = authHeader.replace('Bearer ', '');
    if (!SecurityUtils.timingSafeEqual(token, validToken)) {
      res.status(403).json({
        error: 'Invalid token',
        message: 'Invalid admin token'
      });
      return;
    }
    
    next();
  }

  // ========== SYSTEM ROUTE ==========
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
          connected: this.wsServer?.getConnectedPlayersCount() || 0,
          players: this.wsServer?.getConnectedPlayers() || []
        }
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

  private setupErrorHandling(): void {
    // Global error handler with more details
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      const errorId = Date.now().toString(36) + Math.random().toString(36).substr(2);
      
      logger.error('Unhandled error', {
error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent')
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

    // Handle unhandled promise rejections with more context
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
      
      // Graceful shutdown
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
      
      logger.info('Starting application');
      
      // 1. Validate critical environment variables
      this.validateEnvironment();
      
      // 2. Initialize Redis
      await this.redisService.init();
      logger.info('Redis initialized successfully');
      
      // 3. Test PostgreSQL connection
      const dbConnected = await DatabaseConfig.testConnection();
      if (!dbConnected) {
        throw new Error('Unable to connect to PostgreSQL');
      }
      logger.info('PostgreSQL connected successfully');
      
      // 4. Initialize synchronization service
      await this.syncService.init();
      logger.info('Synchronization service initialized successfully');
      
      // 5. Start HTTP server
      this.server = createServer(this.app);
      
      // 6. Initialize WebSocket
      this.wsServer = new ZoneWebSocketServer(this.server, this.redisService);
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
      
      logger.info('Server started successfully', { port });
      logger.info('WebSocket available', { endpoint: `ws://localhost:${port}/ws/zones` });
      logger.info('API available', { endpoint: `http://localhost:${port}/api` });
      
      // 8. Setup graceful shutdown
      this.setupGracefulShutdown();
      
    } catch (error) {
      logger.error('Failed to start application', { 
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
    
    logger.info('Environment variables validated successfully');
  }

  private setupGracefulShutdown(): void {
    const signals = ['SIGTERM', 'SIGINT'];
    
    signals.forEach(signal => {
      process.on(signal, () => this.gracefulShutdown(signal));
    });
  }

  private async gracefulShutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Shutdown signal ignored - already shutting down', { signal });
      return;
    }
    
    this.isShuttingDown = true;
    logger.info('Graceful shutdown initiated', { signal });
    
    try {
      // Stop accepting new connections
      if (this.server) {
        this.server.close();
      }
      
      // Wait for ongoing requests to complete (max 2s)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await this.cleanup();
      
      logger.info('Graceful shutdown completed successfully');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      process.exit(1);
    }
  }

  private async cleanup(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];
    
    // Close WebSocket
    if (this.wsServer) {
      cleanupPromises.push(
        new Promise(resolve => {
          this.wsServer!.close();
          resolve();
        })
      );
    }
    
    // Stop synchronization service
    if (this.syncService) {
      cleanupPromises.push(this.syncService.destroy());
    }

    // Stop player controller (batch service)
    if (this.playerController) {
      cleanupPromises.push(this.playerController.destroy());
    }
    
    // Close Redis
    if (this.redisService) {
      cleanupPromises.push(this.redisService.destroy());
    }
    
    // Close PostgreSQL pool
    cleanupPromises.push(DatabaseConfig.closeAll());
    
    // Wait for all cleanups (max 5s)
    await Promise.race([
      Promise.allSettled(cleanupPromises),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }

  // ========== PUBLIC API FOR TESTS ==========
  getApp(): express.Application {
    return this.app;
  }

  getWSServer(): ZoneWebSocketServer | null {
    return this.wsServer;
  }

  async stop(): Promise<void> {
    await this.gracefulShutdown('MANUAL_STOP');
  }
}

// Start application
const app = new Application();

// Start only if this is not an import (for tests)
if (require.main === module) {
  app.start().catch(error => {
    logger.error('Fatal error', { 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
    process.exit(1);
  });
}


export default Application;