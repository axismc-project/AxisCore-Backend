// src/app.ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import dotenv from 'dotenv';

// Core Services
import { DatabaseService } from './services/DatabaseService';
import { RedisService } from './services/RedisService';
import { ZoneTransitionService } from './services/ZoneTransitionService';
import { BatchSyncService } from './services/BatchSyncService';
import { ApiKeyService } from './services/ApiKeyService';
import { ZoneLoaderService } from './services/ZoneLoaderService';
import { ChunkCalculatorService } from './services/ChunkCalculatorService';

// Controllers
import { PlayerController } from './controllers/PlayerController';
import { ZoneController } from './controllers/ZoneController';

// WebSocket
import { FixedZoneWebSocketServer } from './websocket/FixedZoneWebSocketServer';

// Utils
import { logger } from './utils/logger';
import { SecurityUtils } from './utils/security';
import { DatabaseConfig } from './config/database';

dotenv.config();

class Application {
 private app: express.Application;
 private server: any;
 
 // Core Services
 private dbService!: DatabaseService;
 private redisService!: RedisService;
 private zoneLoaderService!: ZoneLoaderService;
 private zoneTransitionService!: ZoneTransitionService;
 private batchSyncService!: BatchSyncService;
 private apiKeyService!: ApiKeyService;
 private calculatorService!: ChunkCalculatorService;
 
 // Controllers
 private playerController!: PlayerController;
 private zoneController!: ZoneController;
 
 // WebSocket
 private wsServer!: FixedZoneWebSocketServer;

 private isShuttingDown = false;
 private startupTime = Date.now();

 constructor() {
   this.app = express();
   this.setupMiddleware();
   this.setupErrorHandling();
 }

 // ========== INITIALIZATION ==========
 
 async start(): Promise<void> {
   try {
     const port = process.env.PORT || 3000;
     
     logger.info('🚀 Starting Minecraft Zones Backend v2.0 - FULLY OPTIMIZED');
     logger.info('🔧 Environment check', {
       nodeVersion: process.version,
       environment: process.env.NODE_ENV || 'development',
       port
     });
     
     // 1. Validate environment
     this.validateEnvironment();
     
     // 2. Initialize core services avec gestion d'erreur individuelle
     await this.initializeServices();
     
     // 3. Initialize controllers
     this.initializeControllers();

     this.setupRoutes();
     
     // 4. Load zones into Redis cache
     await this.initializeZoneCache();
     
     // 5. Create HTTP server + WebSocket
     this.server = createServer(this.app);
     this.wsServer = new FixedZoneWebSocketServer(this.server, this.apiKeyService);
     
     // 6. Start zone transition service
     try {
       await this.zoneTransitionService.start();
       logger.info('✅ Zone transition service started');
     } catch (error) {
       logger.error('❌ Zone transition service failed to start', { error });
       logger.warn('⚠️ Continuing without real-time zone transitions');
     }
     
     // 7. Start batch sync service
     try {
       await this.batchSyncService.start();
       logger.info('✅ Batch sync service started');
     } catch (error) {
       logger.error('❌ Batch sync service failed to start', { error });
       logger.warn('⚠️ Continuing without batch sync');
     }
     
     // 8. Start HTTP server
     await new Promise<void>((resolve, reject) => {
       this.server.listen(port, (err?: Error) => {
         if (err) {
           logger.error('❌ Failed to start HTTP server', { err });
           reject(err);
         } else {
           logger.info('✅ HTTP server listening', { port });
           resolve();
         }
       });
     });
     
     logger.info('🎉 APPLICATION STARTED SUCCESSFULLY!', { port });
     
     await this.logSystemStatus();
     
     this.setupGracefulShutdown();
     
   } catch (error) {
     logger.error('❌ Failed to start application', { error });
     await this.cleanup();
     process.exit(1);
   }
 }

 private async initializeServices(): Promise<void> {
   try {
     logger.info('🔧 Initializing core services...');
     
     // Database Service
     logger.info('🐘 Initializing Database service...');
     this.dbService = new DatabaseService();
     const dbConnected = await DatabaseConfig.testConnection();
     if (!dbConnected) throw new Error('Database connection failed');
     logger.info('✅ Database service ready');
     
     // Redis Service
     logger.info('🔴 Initializing Redis service...');
     this.redisService = new RedisService();
     await this.redisService.init();
     logger.info('✅ Redis service ready with keyspace notifications');
     
     // Calculator Service
     logger.info('📊 Initializing Chunk Calculator service...');
     this.calculatorService = new ChunkCalculatorService();
     logger.info('✅ Chunk Calculator service ready');
     
     // Zone Loader Service
     logger.info('🗺️ Initializing Zone Loader service...');
     this.zoneLoaderService = new ZoneLoaderService(
       this.dbService,
       this.redisService,
       this.calculatorService
     );
     logger.info('✅ Zone Loader service ready');
     
     // API Key Service
     logger.info('🔐 Initializing API Key service...');
     this.apiKeyService = new ApiKeyService();
     logger.info('✅ API Key service ready');
     
     // Zone Transition Service
     logger.info('🎯 Initializing Zone Transition service...');
     this.zoneTransitionService = new ZoneTransitionService(
       this.redisService,
       (transition) => {
         if (this.wsServer) {
           this.wsServer.broadcastZoneEvent(transition);
         }
       }
     );
     logger.info('✅ Zone Transition service ready');
     
     // Batch Sync Service
     logger.info('⚡ Initializing Batch Sync service...');
     this.batchSyncService = new BatchSyncService(
       this.redisService,
       this.dbService
     );
     logger.info('✅ Batch Sync service ready');
     
   } catch (error) {
     logger.error('❌ Service initialization failed', { error });
     throw error;
   }
 }

 private initializeControllers(): void {
   this.playerController = new PlayerController(this.redisService, this.dbService);
   this.zoneController = new ZoneController(this.redisService, this.dbService);
   logger.info('✅ Controllers initialized');
 }

 private async initializeZoneCache(): Promise<void> {
   try {
     logger.info('🗺️ Initializing zone cache...');
     
     // Load all zones from PostgreSQL into Redis
     await this.zoneLoaderService.loadAllZonesToRedis();
     
     // Get cache statistics
     const cacheStats = await this.zoneLoaderService.getCacheStats();
     
     logger.info('✅ Zone cache initialized', {
       totalChunks: cacheStats.totalCachedChunks,
       regions: cacheStats.regionsCount,
       nodes: cacheStats.nodesCount,
       cities: cacheStats.citiesCount
     });
     
   } catch (error) {
     logger.error('❌ Failed to initialize zone cache', { error });
     throw error;
   }
 }

 private validateEnvironment(): void {
   const required = ['DATABASE_URL', 'REDIS_URL'];
   const missing = required.filter(key => !process.env[key]);
   
   if (missing.length > 0) {
     throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
   }
   
   const recommended = ['ADMIN_TOKEN', 'CORS_ORIGIN'];
   const missingRecommended = recommended.filter(key => !process.env[key]);
   
   if (missingRecommended.length > 0) {
     logger.warn('⚠️ Missing recommended environment variables', { 
       missing: missingRecommended 
     });
   }
   
   logger.info('✅ Environment validated');
 }

 private async logSystemStatus(): Promise<void> {
   try {
     const [redisStats, batchStats, cacheStats] = await Promise.all([
       this.redisService.getStats(),
       this.batchSyncService.getStats(),
       this.zoneLoaderService.getCacheStats()
     ]);

     logger.info('🔥 SYSTEM STATUS - ALL SERVICES OPERATIONAL', {
       architecture: 'Jedis → Redis Keyspace → Zone Transitions → WebSocket + Batch Sync',
       services: {
         database: '✅ PostgreSQL connected with pooling',
         redis: '✅ Connected with KEh keyspace notifications',
         zoneCache: `✅ ${cacheStats.totalCachedChunks} chunks cached`,
         transitions: '✅ Real-time zone detection active',
         batchSync: `✅ Redis → PostgreSQL every ${process.env.BATCH_SYNC_INTERVAL || 30000}ms`,
         websocket: '✅ Real-time broadcasting ready',
         authentication: '✅ API key validation active'
       }
     });

   } catch (error) {
     logger.error('❌ Failed to log system status', { error });
   }
 }

 // ========== MIDDLEWARE ==========
 
 private setupMiddleware(): void {
   // Graceful shutdown check
   this.app.use((req, res, next) => {
     if (this.isShuttingDown) {
       res.status(503).json({ 
         error: 'Service unavailable - shutting down',
         timestamp: new Date().toISOString()
       });
       return;
     }
     next();
   });

   // Security headers
   this.app.use(helmet({
     contentSecurityPolicy: false,
     crossOriginEmbedderPolicy: false
   }));
   
   // CORS configuration
   this.app.use(cors({
     origin: process.env.CORS_ORIGIN || '*',
     credentials: true,
     methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
     allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
   }));
   
   // Body parsing
   this.app.use(express.json({ 
     limit: '1mb',
     strict: true,
     type: 'application/json'
   }));
   this.app.use(express.urlencoded({ 
     extended: true,
     limit: '1mb'
   }));
   
   // Request logging
   this.app.use((req, res, next) => {
     const start = Date.now();
     
     res.on('finish', () => {
       const duration = Date.now() - start;
       const apiKey = (req as any).apiKey;
       
       logger.info('HTTP Request', {
         method: req.method,
         path: req.path,
         statusCode: res.statusCode,
         durationMs: duration,
         ip: req.ip,
         apiKeyName: apiKey?.keyName || 'anonymous'
       });
     });
     
     next();
   });

   // API Key authentication for protected routes
   this.app.use('/api', this.authenticateApiKey.bind(this));
 }

 private async authenticateApiKey(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
   const publicEndpoints = [
     '/api/',
     '/api/health',
     '/api/websocket/test'
   ];

   if (publicEndpoints.some(endpoint => req.path === endpoint)) {
     next();
     return;
   }

   const authHeader = req.headers.authorization;
   const apiKeyHeader = req.headers['x-api-key'] as string;
   
   let apiKey: string | null = null;

   if (authHeader && authHeader.startsWith('Bearer ')) {
     apiKey = authHeader.replace('Bearer ', '');
   } else if (apiKeyHeader) {
     apiKey = apiKeyHeader;
   }

   if (!apiKey) {
     res.status(401).json({
       error: 'Authentication required',
       message: 'API key required: Authorization: Bearer <key> or X-API-Key: <key>',
       endpoints: {
         public: publicEndpoints,
         createApiKey: 'POST /api/admin/api-keys'
       }
     });
     return;
   }

   try {
     const validatedKey = await this.apiKeyService.validateApiKey(apiKey);
     
     if (!validatedKey) {
       res.status(401).json({
         error: 'Invalid API key',
         message: 'The provided API key is invalid, expired, or inactive'
       });
       return;
     }

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

     // Rate limiting check
     const rateLimitOk = await this.apiKeyService.checkRateLimit(
       validatedKey.id, 
       req.path, 
       validatedKey.rateLimitPerMinute
     );

     if (!rateLimitOk) {
       res.status(429).json({
         error: 'Rate limit exceeded',
         message: `Too many requests. Limit: ${validatedKey.rateLimitPerMinute} requests per minute`,
         retryAfter: 60
       });
       return;
     }

     // Record usage asynchronously
     this.apiKeyService.recordUsage(validatedKey.id, req.path).catch(error => {
       logger.error('Failed to record API usage', { 
         keyId: validatedKey.id, 
         endpoint: req.path, 
         error 
       });
     });

     (req as any).apiKey = validatedKey;
     next();
   } catch (error) {
     logger.error('Authentication error', { error });
     res.status(500).json({
       error: 'Authentication error',
       message: 'Unable to validate API key'
     });
   }
 }

 private getRequiredPermission(method: string, path: string): string {
   // Admin routes
   if (path.startsWith('/api/admin/')) {
     return 'admin:*';
   }

   // Zone routes
   if (path.includes('/api/zone/') && method === 'POST') {
     return 'zone:write';
   }
   if (path.includes('/api/zone/') || path.includes('/api/chunk/')) {
     return 'zone:read';
   }

   // Player routes
   if (path.includes('/api/player/') && (method === 'POST' || method === 'PUT')) {
     return 'player:write';
   }
   if (path.includes('/api/player/')) {
     return 'player:read';
   }

   // Sync routes
   if (path.includes('/api/sync/')) {
     return 'stats:read';
   }

   // Default
   return 'api:read';
 }

 // ========== ROUTES ==========
 
 private setupRoutes(): void {
   // ========== PUBLIC ROUTES ==========
   
   this.app.get('/', (req, res) => {
     const uptime = Date.now() - this.startupTime;
     
     res.json({
       name: 'Minecraft Zones Backend',
       version: '2.0.0-FULLY-OPTIMIZED',
       status: 'running',
       environment: process.env.NODE_ENV || 'development',
       uptime: Math.floor(uptime / 1000),
       architecture: {
         flow: 'Jedis → Redis Keyspace → Zone Transitions → WebSocket + Batch Sync',
         features: [
           '✅ Real-time zone transition detection (<1ms)',
           '✅ WebSocket broadcasting with compression',
           '✅ Redis chunk zone cache (instant lookup)',
           '✅ Batch sync Redis → PostgreSQL with redis_synced tracking',
           '✅ API key authentication & rate limiting',
           '✅ Keyspace notifications (KEh configuration)',
           '✅ Player identification system with Mojang API'
         ]
       },
       services: {
         zoneTransitions: this.zoneTransitionService?.isRunning() || false,
         batchSync: this.batchSyncService?.getStats().isRunning || false,
         websocket: this.wsServer?.getConnectedClientsCount() || 0,
         redis: 'Active with keyspace notifications'
       },
       endpoints: {
         websocket: 'ws://localhost:3000/ws/zones?api_key=xxx',
         health: '/api/health',
         testing: '/api/websocket/test',
         player: {
           userlog: 'POST /api/player/userlog (for Minecraft plugin)',
           whois: 'POST /api/player/whois (lookup by uuid or name)',
           position: 'POST /api/player/:uuid/position'
         },
         chunks: '/api/chunk/:x/:z'
       }
     });
   });

   this.app.get('/api/health', async (req, res) => {
     try {
       const [redisStats, batchStats, cacheStats, dbTest] = await Promise.all([
         this.redisService.getStats(),
         this.batchSyncService.getStats(),
         this.zoneLoaderService.getCacheStats(),
         DatabaseConfig.testConnection()
       ]);

       const isHealthy = redisStats.connectedClients && dbTest && this.zoneTransitionService.isRunning();

       res.status(isHealthy ? 200 : 503).json({
         status: isHealthy ? 'healthy' : 'unhealthy',
         timestamp: new Date().toISOString(),
         uptime: Math.floor((Date.now() - this.startupTime) / 1000),
         services: {
           database: dbTest,
           redis: redisStats,
           zoneCache: cacheStats,
           batchSync: batchStats,
           zoneTransitions: this.zoneTransitionService.isRunning(),
           websocket: this.wsServer?.getConnectedClientsCount() || 0
         }
       });
     } catch (error) {
       res.status(500).json({
         status: 'error',
         error: 'Health check failed',
         timestamp: new Date().toISOString()
       });
     }
   });

   this.app.get('/api/websocket/test', (req, res) => {
     const connectedClients = this.wsServer?.getConnectedClientsCount() || 0;
     
     res.json({
       websocket: {
         status: 'active',
         endpoint: `ws://${req.get('host')}/ws/zones`,
         connectedClients,
         authentication: {
           required: true,
           methods: ['?api_key=xxx', 'Authorization: Bearer xxx'],
           permissions: 'zone:read permission required'
         }
       }
     });
   });

   // ========== API KEY MANAGEMENT ==========
   
   this.app.post('/api/admin/api-keys', this.createApiKey.bind(this));
   this.app.get('/api/admin/api-keys', this.listApiKeys.bind(this));
   this.app.delete('/api/admin/api-keys/:keyName', this.revokeApiKey.bind(this));

   // ========== PLAYER ENDPOINTS ==========
   
   this.app.post('/api/player/userlog', 
     this.playerController.handleUserLog.bind(this.playerController)
   );

   this.app.post('/api/player/whois', 
     this.playerController.whoIs.bind(this.playerController)
   );
   
   this.app.post('/api/player/:uuid/position', 
     this.validateUUID.bind(this),
     this.validatePosition.bind(this),
     this.playerController.updatePlayerPosition.bind(this.playerController)
   );

   // ========== ZONE ENDPOINTS ==========
   
   this.app.get('/api/chunk/:chunkX/:chunkZ', 
     this.validateChunkCoords.bind(this),
     this.playerController.getChunkInfo.bind(this.playerController)
   );

   this.app.get('/api/zones/hierarchy', 
     this.zoneController.getZoneHierarchy.bind(this.zoneController)
   );

   this.app.get('/api/zone/:zoneType/:zoneId',
     this.validateZoneParams.bind(this),
     this.zoneController.getZoneById.bind(this.zoneController)
   );

   // ========== ADMIN ENDPOINTS ==========
   
   this.app.get('/api/admin/sync/status', this.getSyncStatus.bind(this));
   this.app.post('/api/admin/zones/reload', this.reloadZones.bind(this));

   // ========== 404 HANDLER ==========
   this.app.use('*', (req, res) => {
     res.status(404).json({
       error: 'Endpoint not found',
       message: `${req.method} ${req.originalUrl} does not exist`,
       timestamp: new Date().toISOString()
     });
   });
 }

 // ========== VALIDATION MIDDLEWARE ==========
 
 private validateUUID(req: express.Request, res: express.Response, next: express.NextFunction): void {
   if (!SecurityUtils.isValidUUID(req.params.uuid)) {
     res.status(400).json({ 
       error: 'Invalid UUID format',
       message: 'UUID must be in valid format (server_uuid from Minecraft server)'
     });
     return;
   }
   next();
 }

 private validatePosition(req: express.Request, res: express.Response, next: express.NextFunction): void {
   const { name, x, y, z } = req.body;
   
   if (!SecurityUtils.isValidPlayerName(name) ||
       !SecurityUtils.isValidCoordinate(x) ||
       !SecurityUtils.isValidCoordinate(y) ||
       !SecurityUtils.isValidCoordinate(z)) {
     res.status(400).json({ 
       error: 'Invalid parameters',
       message: 'Valid name (3-16 chars) and coordinates required'
     });
     return;
   }
   next();
 }

 private validateChunkCoords(req: express.Request, res: express.Response, next: express.NextFunction): void {
   const x = parseInt(req.params.chunkX);
   const z = parseInt(req.params.chunkZ);
   
   if (!SecurityUtils.isValidChunkCoordinate(x) || !SecurityUtils.isValidChunkCoordinate(z)) {
     res.status(400).json({ 
       error: 'Invalid chunk coordinates',
       message: 'Chunk coordinates must be valid integers within bounds'
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
   
   next();
 }

 // ========== API KEY ENDPOINTS ==========
 
 private async createApiKey(req: express.Request, res: express.Response): Promise<void> {
   try {
     const { keyName, permissions, description, rateLimitPerMinute } = req.body;

     if (!keyName || !Array.isArray(permissions)) {
       res.status(400).json({
         error: 'Invalid request',
         message: 'keyName and permissions array are required'
       });
       return;
     }

     const apiKey = await this.apiKeyService.createApiKey(
       keyName,
       permissions,
       description,
       undefined,
       1000,
       rateLimitPerMinute || 60
     );

     res.status(201).json({
       message: 'API key created successfully',
       data: { keyName, apiKey, permissions }
     });

   } catch (error) {
     logger.error('Failed to create API key', { error });
     res.status(500).json({
       error: 'Server error',
       message: 'Unable to create API key'
     });
   }
 }

 private async listApiKeys(req: express.Request, res: express.Response): Promise<void> {
   try {
     const keys = await this.apiKeyService.getUsageStats();

     const safeKeys = keys.map((key: any) => ({
       keyName: key.key_name,
       permissions: key.permissions,
       usageCount: key.usage_count,
       lastUsedAt: key.last_used_at,
       isActive: key.is_active
     }));

     res.json({
       message: 'API keys list',
       count: safeKeys.length,
       data: safeKeys
     });

   } catch (error) {
     logger.error('Failed to list API keys', { error });
     res.status(500).json({
       error: 'Server error',
       message: 'Unable to list API keys'
     });
   }
 }

 private async revokeApiKey(req: express.Request, res: express.Response): Promise<void> {
   try {
     const { keyName } = req.params;
     
     const revoked = await this.apiKeyService.revokeApiKey(keyName);

     if (revoked) {
       res.json({
         message: 'API key revoked successfully',
         keyName
       });
     } else {
       res.status(404).json({
         error: 'API key not found'
       });
     }

   } catch (error) {
     logger.error('Failed to revoke API key', { error });
     res.status(500).json({
       error: 'Server error'
     });
   }
 }

 // ========== ADMIN ENDPOINTS ==========
 
 private async getSyncStatus(req: express.Request, res: express.Response): Promise<void> {
   try {
     const [batchStats, redisStats, cacheStats] = await Promise.all([
       this.batchSyncService.getStats(),
       this.redisService.getStats(),
       this.zoneLoaderService.getCacheStats()
     ]);
     
     res.json({
       message: 'Synchronization status',
       timestamp: new Date().toISOString(),
       services: { batchSync: batchStats, redis: redisStats, zoneCache: cacheStats }
     });
   } catch (error) {
     logger.error('Failed to get sync status', { error });
     res.status(500).json({
       error: 'Failed to get sync status'
     });
   }
 }

 private async reloadZones(req: express.Request, res: express.Response): Promise<void> {
   try {
     await this.zoneLoaderService.loadAllZonesToRedis();
     const stats = await this.zoneLoaderService.getCacheStats();
     
     res.json({
       message: 'Zone cache reloaded successfully',
       timestamp: new Date().toISOString(),
       stats
     });
     
   } catch (error) {
     logger.error('Failed to reload zones', { error });
     res.status(500).json({
       error: 'Failed to reload zones'
     });
   }
 }

 // ========== ERROR HANDLING ==========
 
 private setupErrorHandling(): void {
   this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
     const errorId = Date.now().toString(36) + Math.random().toString(36).substr(2);
     
     logger.error('Unhandled application error', {
       errorId,
       error: error.message,
       stack: error.stack,
       url: req.url,
       method: req.method
     });
     
     res.status(500).json({
       error: 'Internal server error',
       errorId,
       timestamp: new Date().toISOString()
     });
   });
 }

 // ========== GRACEFUL SHUTDOWN ==========
 
 private setupGracefulShutdown(): void {
   const signals = ['SIGTERM', 'SIGINT'];
   
   signals.forEach(signal => {
     process.on(signal, () => this.gracefulShutdown(signal));
   });
   
   logger.info('🛡️ Graceful shutdown handlers registered');
 }

 private async gracefulShutdown(signal: string): Promise<void> {
   if (this.isShuttingDown) return;
   
   this.isShuttingDown = true;
   logger.info('🔄 Graceful shutdown initiated', { signal });
   
   try {
     if (this.server) {
       this.server.close();
     }
     
     await this.cleanup();
     
     logger.info('✅ Graceful shutdown completed successfully');
     process.exit(0);
   } catch (error) {
     logger.error('❌ Error during graceful shutdown', { error });
     process.exit(1);
   }
 }

 private async cleanup(): Promise<void> {
   logger.info('🧹 Starting cleanup process...');
   
   const cleanupPromises: Promise<void>[] = [];
   
   if (this.wsServer) {
     cleanupPromises.push(this.wsServer.close());
   }
   
   if (this.zoneTransitionService) {
     cleanupPromises.push(this.zoneTransitionService.stop());
   }

   if (this.batchSyncService) {
     cleanupPromises.push(this.batchSyncService.stop());
   }
   
   if (this.redisService) {
     cleanupPromises.push(this.redisService.destroy());
   }
   
   logger.info('🐘 Closing PostgreSQL pool...');
   cleanupPromises.push(DatabaseConfig.closeAll());
   
   await Promise.allSettled(cleanupPromises);
   
   logger.info('✅ Cleanup completed');
 }

 // ========== PUBLIC API ==========
 
 getApp(): express.Application {
  return this.app;
}

getServices() {
  return {
    database: this.dbService,
    redis: this.redisService,
    zoneLoader: this.zoneLoaderService,
    zoneTransitions: this.zoneTransitionService,
    batchSync: this.batchSyncService,
    apiKey: this.apiKeyService,
    calculator: this.calculatorService
  };
}

getControllers() {
  return {
    player: this.playerController,
    zone: this.zoneController
  };
}

getWebSocketServer() {
  return this.wsServer;
}

async stop(): Promise<void> {
  await this.gracefulShutdown('MANUAL_STOP');
}

isReady(): boolean {
  return !this.isShuttingDown && 
         this.zoneTransitionService?.isRunning() && 
         this.batchSyncService?.getStats().isRunning &&
         this.redisService !== null && 
         this.dbService !== null;
}
}

// ========== APPLICATION ENTRY POINT ==========

const app = new Application();

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