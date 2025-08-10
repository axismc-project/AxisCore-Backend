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

  constructor() {
    this.app = express();
    this.initializeServices();
    this.initializeControllers();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private initializeServices(): void {
    this.dbService = new DatabaseService();
    this.redisService = new RedisService();
    this.calculatorService = new ChunkCalculatorService();
    this.syncService = new ZoneSyncService(
      this.dbService,
      this.redisService,
      this.calculatorService
    );
  }

  private initializeControllers(): void {
    this.zoneController = new ZoneController(
      this.redisService,
      this.dbService,
      this.syncService
    );
    
    this.playerController = new PlayerController(
      this.redisService,
      this.dbService
    );
  }

  private setupMiddleware(): void {
    // Sécurité
    this.app.use(helmet({
      contentSecurityPolicy: false // Désactivé pour WebSocket
    }));
    
    // CORS
    this.app.use(cors({
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true
    }));
    
    // Parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // Logging des requêtes
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path} - ${req.ip}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Route racine
    this.app.get('/', (req, res) => {
      res.json({
        name: 'Minecraft Zones Backend',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString()
      });
    });

    // Routes API zones
    this.app.get('/api/chunk/:chunkX/:chunkZ', 
      this.zoneController.getChunkZone.bind(this.zoneController));
    
    this.app.get('/api/zones/hierarchy', 
      this.zoneController.getZoneHierarchy.bind(this.zoneController));
    
    this.app.get('/api/zone/:zoneType/:zoneId', 
      this.zoneController.getZoneById.bind(this.zoneController));
    
    this.app.get('/api/zone/:zoneType/:zoneId/players', 
      this.zoneController.getPlayersInZone.bind(this.zoneController));

    // Routes API joueurs
    this.app.get('/api/player/:uuid', 
      this.playerController.getPlayerInfo.bind(this.playerController));
    
    this.app.post('/api/player/:uuid/position', 
      this.playerController.updatePlayerPosition.bind(this.playerController));
    
    this.app.get('/api/player/:uuid/zones', 
      this.playerController.getPlayerCurrentZones.bind(this.playerController));

    // Routes statistiques et monitoring
    this.app.get('/api/stats', 
      this.zoneController.getStats.bind(this.zoneController));
    
    this.app.get('/api/health', 
      this.zoneController.getHealth.bind(this.zoneController));

    // Routes administration
    this.app.post('/api/admin/sync', 
      this.zoneController.forceSync.bind(this.zoneController));
    
    this.app.post('/api/admin/cleanup', 
      this.zoneController.performCleanup.bind(this.zoneController));

    // Route 404
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Endpoint non trouvé',
        message: `${req.method} ${req.originalUrl} n'existe pas`,
        timestamp: new Date().toISOString()
      });
    });
  }

  private setupErrorHandling(): void {
    // Gestionnaire d'erreurs global
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.error('Erreur non gérée:', error);
      
      res.status(500).json({
        error: 'Erreur serveur interne',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Une erreur est survenue',
        timestamp: new Date().toISOString()
      });
    });

    // Gestionnaire promesses rejetées
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Promesse rejetée non gérée:', reason);
    });

    // Gestionnaire exceptions non capturées
    process.on('uncaughtException', (error) => {
      logger.error('Exception non capturée:', error);
      process.exit(1);
    });
  }

  async start(): Promise<void> {
    try {
      const port = process.env.PORT || 3000;
      
      logger.info('🚀 Démarrage de l\'application...');
      
      // 1. Initialiser Redis
      await this.redisService.init();
      logger.info('✅ Redis initialisé');
      
      // 2. Initialiser le service de synchronisation
      await this.syncService.init();
      logger.info('✅ Service de synchronisation initialisé');
      
      // 3. Démarrer le serveur HTTP
      this.server = createServer(this.app);
      
      // 4. Initialiser WebSocket
      this.wsServer = new ZoneWebSocketServer(this.server, this.redisService);
      logger.info('✅ Serveur WebSocket initialisé');
      
      // 5. Démarrer l'écoute
      this.server.listen(port, () => {
        logger.info(`🌐 Serveur démarré sur port ${port}`);
        logger.info(`📡 WebSocket disponible sur ws://localhost:${port}/ws/zones`);
        logger.info(`🔗 API disponible sur http://localhost:${port}/api`);
      });
      
      // 6. Gérer l'arrêt propre
      this.setupGracefulShutdown();
      
    } catch (error) {
      logger.error('❌ Erreur démarrage application:', error);
      process.exit(1);
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      logger.info(`🛑 Signal ${signal} reçu, arrêt en cours...`);
      
      try {
        // Fermer WebSocket
        if (this.wsServer) {
          this.wsServer.close();
        }
        
        // Fermer serveur HTTP
        if (this.server) {
          this.server.close();
        }
        
        // Fermer connexions Redis
        await RedisConfig.closeAll();
        
        // Fermer pool PostgreSQL
        await DatabaseConfig.closeAll();
        
        logger.info('✅ Arrêt propre terminé');
        process.exit(0);
      } catch (error) {
        logger.error('❌ Erreur lors de l\'arrêt:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // API publique pour tests
  getApp(): express.Application {
    return this.app;
  }

  getWSServer(): ZoneWebSocketServer | null {
    return this.wsServer;
  }
}

// Démarrage de l'application
const app = new Application();
app.start().catch(error => {
  logger.error('Erreur fatale:', error);
  process.exit(1);
});

export default Application;