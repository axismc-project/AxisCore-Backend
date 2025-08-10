import WebSocket from 'ws';
import { Server as HTTPServer } from 'http';
import { RedisService } from '../services/RedisService';
import { ApiKeyService } from '../services/ApiKeyService';
import { ZoneEvent } from '../models/Zone';
import { logger } from '../utils/logger';

interface AuthenticatedWebSocket extends WebSocket {
  apiKey?: {
    id: number;
    keyName: string;
    permissions: string[];
  };
  isAlive?: boolean;
}

export class ZoneWebSocketServer {
  private wss: WebSocket.Server;
  private authenticatedClients: Set<AuthenticatedWebSocket> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    server: HTTPServer,
    private redis: RedisService,
    private apiKeyService: ApiKeyService
  ) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws/zones'
    });
    
    this.setupWebSocketServer();
    this.startHeartbeat();
    this.subscribeToRedisEvents();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', async (ws: AuthenticatedWebSocket, request) => {
      logger.info(`🔌 Tentative de connexion WebSocket: ${request.socket.remoteAddress}`);
      
      try {
        // Authentification obligatoire
        const authenticated = await this.authenticateConnection(ws, request);
        if (!authenticated) {
          ws.close(1008, 'Authentication required');
          return;
        }

        // Configuration client
        ws.isAlive = true;
        this.authenticatedClients.add(ws);
        
        // Gestionnaires d'événements
        ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(ws, data);
        });
        
        ws.on('close', (code, reason) => {
          this.handleDisconnection(ws, code, reason);
        });
        
        ws.on('error', (error) => {
          logger.error('Erreur WebSocket:', { error: error.message });
        });
        
        ws.on('pong', () => {
          ws.isAlive = true;
        });
        
        // Confirmation de connexion
        this.sendToClient(ws, {
          type: 'connected',
          message: 'WebSocket authentifié - Diffusion des événements de zones',
          timestamp: Date.now()
        });

        logger.info(`✅ WebSocket authentifié: ${ws.apiKey?.keyName}`);
        
      } catch (error) {
        logger.error('Erreur authentification WebSocket:', { 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        ws.close(1011, 'Authentication failed');
      }
    });
    
    logger.info('🌐 WebSocket Zone Events démarré sur /ws/zones (Authentication required)');
  }

  // ========== AUTHENTIFICATION ==========
  private async authenticateConnection(
    ws: AuthenticatedWebSocket, 
    request: any
  ): Promise<boolean> {
    try {
      // Extraire API Key depuis query params ou headers
      const url = new URL(request.url!, `http://${request.headers.host}`);
      let apiKey = url.searchParams.get('api_key');
      
      if (!apiKey) {
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          apiKey = authHeader.replace('Bearer ', '');
        }
      }

      if (!apiKey) {
        logger.warn('WebSocket: Aucune API key fournie');
        return false;
      }

      // Valider l'API key
      const validatedKey = await this.apiKeyService.validateApiKey(apiKey);
      if (!validatedKey) {
        logger.warn('WebSocket: API key invalide');
        return false;
      }

      // Vérifier les permissions WebSocket
      if (!this.apiKeyService.hasPermission(validatedKey, 'zone:read')) {
        logger.warn('WebSocket: Permissions insuffisantes', { 
          keyName: validatedKey.keyName 
        });
        return false;
      }

      // Enregistrer l'usage
      this.apiKeyService.recordUsage(validatedKey.id, '/ws/zones').catch(error => {
        logger.error('Failed to record WebSocket usage', { 
          keyId: validatedKey.id, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      });

      // Attacher les infos d'auth
      ws.apiKey = {
        id: validatedKey.id,
        keyName: validatedKey.keyName,
        permissions: validatedKey.permissions
      };

      return true;
    } catch (error) {
      logger.error('Erreur authentification WebSocket:', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // ========== GESTION DES MESSAGES (LECTURE SEULE) ==========
  private handleMessage(ws: AuthenticatedWebSocket, data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString());
      
      // Seuls les pings sont autorisés
      if (message.type === 'ping') {
        this.sendToClient(ws, { 
          type: 'pong', 
          timestamp: Date.now() 
        });
        return;
      }

      // Rejeter tout autre message
      this.sendToClient(ws, {
        type: 'error',
        message: 'WebSocket en lecture seule - Aucune commande autorisée',
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Erreur traitement message WebSocket:', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      this.sendToClient(ws, {
        type: 'error',
        message: 'Message invalide',
        timestamp: Date.now()
      });
    }
  }

  private handleDisconnection(ws: AuthenticatedWebSocket, code: number, reason: Buffer): void {
    this.authenticatedClients.delete(ws);
    
    const keyName = ws.apiKey?.keyName || 'Unknown';
    logger.info(`🔌 WebSocket déconnecté: ${keyName} (code: ${code})`);
  }

  // ========== DIFFUSION REDIS → WEBSOCKET ==========
  private async subscribeToRedisEvents(): Promise<void> {
    try {
      await this.redis.subscribeToZoneEvents((channel: string, message: string) => {
        this.handleZoneEvent(channel, message);
      });
      
      logger.info('📡 Souscription aux événements Redis réussie');
    } catch (error) {
      logger.error('❌ Erreur souscription événements Redis:', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  private handleZoneEvent(channel: string, message: string): void {
    try {
      const event: ZoneEvent = JSON.parse(message);
      
      // Créer le message simplifié
      const simplifiedEvent = {
        type: 'zone_event',
        data: {
          playerUuid: event.playerUuid,
          action: event.eventType, // 'enter' ou 'leave'
          zoneType: event.zoneType, // 'region', 'node', 'city'
          zoneId: event.zoneId,
          zoneName: event.zoneName
        },
        timestamp: event.timestamp
      };
      
      // Diffuser à tous les clients authentifiés
      this.broadcast(simplifiedEvent);
      
    } catch (error) {
      logger.error('Erreur traitement événement zone:', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  // ========== DIFFUSION ==========
  private broadcast(message: any): void {
    const messageStr = JSON.stringify(message);
    let successCount = 0;
    let errorCount = 0;

    this.authenticatedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(messageStr);
          successCount++;
        } catch (error) {
          errorCount++;
          logger.error('Erreur envoi broadcast:', { 
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      } else {
        // Nettoyer les connexions fermées
        this.authenticatedClients.delete(client);
      }
    });

    if (errorCount > 0) {
      logger.warn('Broadcast partiellement échoué', { 
        successCount, 
        errorCount, 
        event: message.data 
      });
    } else if (successCount > 0) {
      logger.debug('Événement diffusé', { 
        recipients: successCount, 
        playerUuid: message.data?.playerUuid,
        action: message.data?.action,
        zone: `${message.data?.zoneType}:${message.data?.zoneName}`
      });
    }
  }

  private sendToClient(client: WebSocket, data: any): void {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(data));
      } catch (error) {
        logger.error('Erreur envoi message WebSocket:', { 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    }
  }

  // ========== HEARTBEAT ==========
  private startHeartbeat(): void {
    const interval = parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000');
    
    this.heartbeatInterval = setInterval(() => {
      this.authenticatedClients.forEach((ws) => {
        if (ws.isAlive === false) {
          ws.terminate();
          this.authenticatedClients.delete(ws);
          return;
        }
        
        ws.isAlive = false;
        ws.ping();
      });
    }, interval);
    
    logger.info(`💓 Heartbeat WebSocket démarré (${interval}ms)`);
  }

  // ========== API PUBLIQUE ==========
  getConnectedClientsCount(): number {
    return this.authenticatedClients.size;
  }

  getConnectedClients(): string[] {
    return Array.from(this.authenticatedClients)
      .map(ws => ws.apiKey?.keyName || 'Unknown')
      .filter(Boolean);
  }

  // ========== NETTOYAGE ==========
  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    this.wss.close(() => {
      logger.info('🔌 WebSocket Zone Events fermé');
    });
  }
}