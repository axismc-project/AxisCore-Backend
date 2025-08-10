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
import { RedisConfig } from './config/redis';
import { DatabaseConfig } from './config/database';

// Charger variables d'environnement
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

  // État de l'application
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
      logger.info('✅ Services initialisés');
    } catch (error) {
      logger.error('❌ Erreur initialisation services:', error);
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
      logger.info('✅ Controllers initialisés');
    } catch (error) {
      logger.error('❌ Erreur initialisation controllers:', error);
      throw error;
    }
  }

  private setupMiddleware(): void {
    // Vérifier si l'app est en cours d'arrêt
    this.app.use((req, res, next) => {
      if (this.isShuttingDown) {
        res.status(503).json({
          error: 'Service indisponible',
          message: 'Application en cours d\'arrêt',
          timestamp: new Date().toISOString()
        });
        return;
      }
      next();
    });

    // Sécurité
    this.app.use(helmet({
      contentSecurityPolicy: false, // Désactivé pour WebSocket
      crossOriginEmbedderPolicy: false
    }));
    
    // CORS
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));
    
    // Parsing avec limites
    this.app.use(express.json({ 
      limit: '10mb',
      strict: true,
      type: 'application/json'
    }));
    this.app.use(express.urlencoded({ 
      extended: true,
      limit: '10mb'
    }));
    
    // Logging des requêtes avec plus de détails
    this.app.use((req, res, next) => {
      const start = Date.now();
      const originalSend = res.send;
      
      res.send = function(data) {
        const duration = Date.now() - start;
        logger.info(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms - ${req.ip}`);
        return originalSend.call(this, data);
      };
      
      next();
    });

    // Headers de sécurité supplémentaires
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      next();
    });
  }

  private setupRoutes(): void {
    // Route racine avec plus d'informations
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

    // Routes API zones avec validation
    this.app.get('/api/chunk/:chunkX/:chunkZ', 
      this.validateChunkParams.bind(this),
      this.zoneController.getChunkZone.bind(this.zoneController)
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

    // Routes API joueurs avec validation
    this.app.get('/api/player/:uuid', 
      this.validateUUIDParam.bind(this),
      this.playerController.getPlayerInfo.bind(this.playerController)
    );
    
    this.app.post('/api/player/:uuid/position', 
      this.validateUUIDParam.bind(this),
      this.validatePositionBody.bind(this),
      this.playerController.updatePlayerPosition.bind(this.playerController)
    );
    
    this.app.get('/api/player/:uuid/zones', 
      this.validateUUIDParam.bind(this),
      this.playerController.getPlayerCurrentZones.bind(this.playerController)
    );

    // Routes statistiques et monitoring
    this.app.get('/api/stats', 
      this.zoneController.getStats.bind(this.zoneController)
    );
    
    this.app.get('/api/health', 
      this.zoneController.getHealth.bind(this.zoneController)
    );

    // Route de diagnostic système
    this.app.get('/api/system', this.getSystemInfo.bind(this));

    // Routes administration avec authentification
    this.app.post('/api/admin/sync', 
      this.validateAdminAuth.bind(this),
      this.zoneController.forceSync.bind(this.zoneController)
    );
    
    this.app.post('/api/admin/cleanup', 
      this.validateAdminAuth.bind(this),
      this.zoneController.performCleanup.bind(this.zoneController)
    );

    // Route 404 avec plus de détails
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint non trouvé',
        message: `${req.method} ${req.originalUrl} n'existe pas`,
        timestamp: new Date().toISOString(),
        availableEndpoints: [
          'GET /',
          'GET /api/chunk/:chunkX/:chunkZ',
          'GET /api/zones/hierarchy',
          'GET /api/zone/:type/:id',
          'GET /api/player/:uuid',
          'POST /api/player/:uuid/position',
          'GET /api/stats',
          'GET /api/health'
        ]
      });
    });
  }

  // ========== MIDDLEWARES DE VALIDATION ==========
  private validateChunkParams(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const { chunkX, chunkZ } = req.params;
    
    const x = parseInt(chunkX);
    const z = parseInt(chunkZ);
    
    if (isNaN(x) || isNaN(z)) {
      res.status(400).json({
        error: 'Paramètres invalides',
        message: 'chunkX et chunkZ doivent être des entiers',
        received: { chunkX, chunkZ }
      });
      return;
    }
    
    const minChunk = parseInt(process.env.CHUNK_MIN || '-2000');
    const maxChunk = parseInt(process.env.CHUNK_MAX || '2000');
    
    if (x < minChunk || x > maxChunk || z < minChunk || z > maxChunk) {
      res.status(400).json({
        error: 'Coordonnées hors limites',
        message: `Les chunks doivent être entre ${minChunk} et ${maxChunk}`,
        received: { x, z },
        limits: { min: minChunk, max: maxChunk }
      });
      return;
    }
    
    next();
  }

  private validateZoneParams(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const { zoneType, zoneId } = req.params;
    
    if (!['region', 'node', 'city'].includes(zoneType)) {
      res.status(400).json({
        error: 'Type de zone invalide',
        message: 'Le type doit être: region, node, ou city',
        received: zoneType,
        allowed: ['region', 'node', 'city']
      });
      return;
    }
    
    const id = parseInt(zoneId);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({
        error: 'ID de zone invalide',
        message: 'L\'ID doit être un entier positif',
        received: zoneId
      });
      return;
    }
    
    next();
  }

  private validateUUIDParam(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const { uuid } = req.params;
    
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid || !uuidRegex.test(uuid)) {
      res.status(400).json({
        error: 'UUID invalide',
        message: 'L\'UUID doit être au format valide (ex: 123e4567-e89b-12d3-a456-426614174000)',
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
        error: 'Nom invalide',
        message: 'Le nom doit être une chaîne de 1 à 16 caractères',
        received: { name, type: typeof name, length: name?.length }
      });
      return;
    }
    
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
      res.status(400).json({
        error: 'Coordonnées invalides',
        message: 'x, y, z doivent être des nombres',
        received: { x: typeof x, y: typeof y, z: typeof z }
      });
      return;
    }
    
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      res.status(400).json({
        error: 'Coordonnées invalides',
        message: 'x, y, z doivent être des nombres finis',
        received: { x, y, z }
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
        error: 'Configuration manquante',
        message: 'Token d\'administration non configuré'
      });
      return;
    }
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Authentification requise',
        message: 'Header Authorization avec Bearer token requis'
      });
      return;
    }
    
    const token = authHeader.replace('Bearer ', '');
    if (token !== validToken) {
      res.status(403).json({
        error: 'Token invalide',
        message: 'Token d\'administration incorrect'
      });
      return;
    }
    
    next();
  }

  // ========== ROUTE SYSTÈME ==========
  private async getSystemInfo(req: express.Request, res: express.Response): Promise<void> {
    try {
      const [dbStats, redisStats] = await Promise.all([
        DatabaseConfig.getPoolStats(),
        this.redisService.getStats().catch(() => ({ connectionStatus: 'error', activePlayers: 0, cachedChunks: 0, memoryUsage: 'Unknown' }))
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
      logger.error('Erreur getSystemInfo:', error);
      res.status(500).json({
        error: 'Erreur récupération informations système',
        message: error instanceof Error ? error.message : 'Erreur inconnue'
      });
    }
  }

  private setupErrorHandling(): void {
    // Gestionnaire d'erreurs global avec plus de détails
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      const errorId = Date.now().toString(36) + Math.random().toString(36).substr(2);
      
      logger.error(`Erreur non gérée [${errorId}]:`, {
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      
      const isDevelopment = process.env.NODE_ENV === 'development';
      
      res.status(500).json({
        error: 'Erreur serveur interne',
        message: isDevelopment ? error.message : 'Une erreur est survenue',
        errorId,
        timestamp: new Date().toISOString(),
        ...(isDevelopment && { stack: error.stack })
      });
    });

    // Gestionnaire promesses rejetées avec plus de contexte
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Promesse rejetée non gérée:', {
        reason,
        promise: promise.toString()
      });
    });

    // Gestionnaire exceptions non capturées
    process.on('uncaughtException', (error) => {
      logger.error('Exception non capturée:', {
        error: error.message,
        stack: error.stack
      });
      
      // Arrêt gracieux
      this.gracefulShutdown('UNCAUGHT_EXCEPTION');
    });

    // Gestionnaire warnings
    process.on('warning', (warning) => {
      logger.warn('Node.js warning:', {
        name: warning.name,
        message: warning.message,
        stack: warning.stack
      });
    });
  }

  async start(): Promise<void> {
    try {
      const port = process.env.PORT || 3000;
      
      logger.info('🚀 Démarrage de l\'application...');
      
      // 1. Vérifier les variables d'environnement critiques
      this.validateEnvironment();
      
      // 2. Initialiser Redis
      await this.redisService.init();
      logger.info('✅ Redis initialisé');
      
      // 3. Tester la connexion PostgreSQL
      const dbConnected = await DatabaseConfig.testConnection();
      if (!dbConnected) {
        throw new Error('Impossible de se connecter à PostgreSQL');
      }
      logger.info('✅ PostgreSQL connecté');
      
      // 4. Initialiser le service de synchronisation
      await this.syncService.init();
      logger.info('✅ Service de synchronisation initialisé');
      
      // 5. Démarrer le serveur HTTP
      this.server = createServer(this.app);
      
      // 6. Initialiser WebSocket
      this.wsServer = new ZoneWebSocketServer(this.server, this.redisService);
      logger.info('✅ Serveur WebSocket initialisé');
      
      // 7. Démarrer l'écoute
      await new Promise<void>((resolve, reject) => {
        this.server.listen(port, (err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      
      logger.info(`🌐 Serveur démarré sur port ${port}`);
      logger.info(`📡 WebSocket disponible sur ws://localhost:${port}/ws/zones`);
      logger.info(`🔗 API disponible sur http://localhost:${port}/api`);
      
      // 8. Gérer l'arrêt propre
      this.setupGracefulShutdown();
      
    } catch (error) {
      logger.error('❌ Erreur démarrage application:', error);
      await this.cleanup();
      process.exit(1);
    }
  }

  private validateEnvironment(): void {
    const required = ['DATABASE_URL', 'REDIS_URL'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Variables d'environnement manquantes: ${missing.join(', ')}`);
    }
    
    logger.info('✅ Variables d\'environnement validées');
  }

  private setupGracefulShutdown(): void {
    const signals = ['SIGTERM', 'SIGINT'];
    
    signals.forEach(signal => {
      process.on(signal, () => this.gracefulShutdown(signal));
    });
  }

  private async gracefulShutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn(`Signal ${signal} ignoré - arrêt déjà en cours`);
      return;
    }
    
    this.isShuttingDown = true;
    logger.info(`🛑 Signal ${signal} reçu, arrêt en cours...`);
    
    try {
      // Arrêter d'accepter de nouvelles connexions
      if (this.server) {
        this.server.close();
      }
      
      // Attendre que les requêtes en cours se terminent (max 10s)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await this.cleanup();
      
      logger.info('✅ Arrêt propre terminé');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Erreur lors de l\'arrêt:', error);
      process.exit(1);
    }
  }

  private async cleanup(): Promise<void> {
    const cleanupPromises: Promise<void>[] = [];
    
    // Fermer WebSocket
    if (this.wsServer) {
      cleanupPromises.push(
        new Promise(resolve => {
          this.wsServer!.close();
          resolve();
        })
      );
    }
    
    // Arrêter le service de synchronisation
    if (this.syncService) {
      cleanupPromises.push(this.syncService.destroy());
    }
    
    // Fermer Redis
    if (this.redisService) {
      cleanupPromises.push(this.redisService.destroy());
    }
    
    // Fermer pool PostgreSQL
    cleanupPromises.push(DatabaseConfig.closeAll());
    
    // Attendre tous les nettoyages (max 5s)
    await Promise.race([
      Promise.allSettled(cleanupPromises),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }

  // ========== API PUBLIQUE POUR TESTS ==========
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

// Démarrage de l'application
const app = new Application();

// Démarrer seulement si ce n'est pas un import (pour les tests)
if (require.main === module) {
  app.start().catch(error => {
    logger.error('Erreur fatale:', error);
    process.exit(1);
  });
}

export default Application;