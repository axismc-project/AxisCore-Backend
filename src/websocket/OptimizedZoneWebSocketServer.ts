import WebSocket from 'ws';
import { Server as HTTPServer } from 'http';
import { RedisService } from '../services/RedisService';
import { ApiKeyService } from '../services/ApiKeyService';
import { ZoneTransition } from '../services/ZoneTransitionDetector';
import { logger } from '../utils/logger';

interface AuthenticatedWebSocket extends WebSocket {
  apiKey?: {
    id: number;
    keyName: string;
    permissions: string[];
  };
  isAlive?: boolean;
  clientId?: string;
}

interface ZoneEventMessage {
  type: 'zone_event';
  data: {
    playerUuid: string;
    action: 'enter' | 'leave';
    zoneType: 'region' | 'node' | 'city';
    zoneId: number;
    zoneName: string;
    timestamp: number;
  };
  timestamp: number;
}

interface ConnectionMessage {
  type: 'connected';
  message: string;
  features: string[];
  timestamp: number;
}

interface PongMessage {
  type: 'pong';
  timestamp: number;
}

interface ErrorMessage {
  type: 'error';
  message: string;
  timestamp: number;
}

type WebSocketMessage = ZoneEventMessage | ConnectionMessage | PongMessage | ErrorMessage;

export class OptimizedZoneWebSocketServer {
  private wss: WebSocket.Server;
  private authenticatedClients: Set<AuthenticatedWebSocket> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private compressionEnabled: boolean = true;

  // 📊 Statistiques
  private stats = {
    totalConnections: 0,
    totalEvents: 0,
    totalBytesSent: 0,
    eventsByType: {
      region_enter: 0,
      region_leave: 0,
      node_enter: 0,
      node_leave: 0,
      city_enter: 0,
      city_leave: 0
    }
  };

constructor(
    server: HTTPServer,
    private redis: RedisService,
    private apiKeyService: ApiKeyService
  ) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws/zones',
      // ✅ COMPRESSION ACTIVÉE - Configuration par défaut optimisée
      perMessageDeflate: true
    });
    
    this.setupWebSocketServer();
    this.startHeartbeat();
    this.subscribeToRedisTransitions();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', async (ws: AuthenticatedWebSocket, request) => {
      const clientIP = request.socket.remoteAddress;
      logger.info(`🔌 New WebSocket connection attempt from ${clientIP}`);
      
      try {
        // 🔐 Authentification obligatoire
        const authenticated = await this.authenticateConnection(ws, request);
        if (!authenticated) {
          this.sendError(ws, 'Authentication required. Provide API key via ?api_key=xxx or Authorization header.');
          ws.close(1008, 'Authentication required');
          return;
        }

        // ✅ Configuration client authentifié
        ws.isAlive = true;
        ws.clientId = `${ws.apiKey!.keyName}_${Date.now()}`;
        this.authenticatedClients.add(ws);
        this.stats.totalConnections++;
        
        // 🎯 Gestionnaires d'événements
        ws.on('message', (data: WebSocket.RawData) => {
          this.handleMessage(ws, data);
        });
        
        ws.on('close', (code, reason) => {
          this.handleDisconnection(ws, code, reason);
        });
        
        ws.on('error', (error) => {
          logger.error('WebSocket error:', { 
            clientId: ws.clientId,
            error: error.message 
          });
        });
        
        ws.on('pong', () => {
          ws.isAlive = true;
        });
        
        // ✅ Message de connexion confirmée
        const welcomeMessage: ConnectionMessage = {
          type: 'connected',
          message: 'WebSocket connected - Real-time zone events enabled',
          features: [
            'Zone enter/leave events only',
            'Compression enabled',
            'Filtered events (no wilderness movements)',
            'Low-latency < 5ms'
          ],
          timestamp: Date.now()
        };

        this.sendToClient(ws, welcomeMessage);

        logger.info(`✅ WebSocket authenticated and ready`, {
          clientId: ws.clientId,
          keyName: ws.apiKey!.keyName,
          totalClients: this.authenticatedClients.size,
          compression: this.compressionEnabled
        });
        
      } catch (error) {
        logger.error('WebSocket authentication error:', { 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        this.sendError(ws, 'Authentication failed');
        ws.close(1011, 'Authentication failed');
      }
    });
    
    logger.info('🚀 Optimized WebSocket Zone Events server started', {
      path: '/ws/zones',
      features: {
        authentication: 'required',
        compression: this.compressionEnabled,
        filtering: 'zone transitions only',
        latency: '< 5ms'
      }
    });
  }

  // ========== AUTHENTIFICATION ==========
  private async authenticateConnection(
    ws: AuthenticatedWebSocket, 
    request: any
  ): Promise<boolean> {
    try {
      // 🔑 Extraire API Key depuis query params ou headers
      const url = new URL(request.url!, `http://${request.headers.host}`);
      let apiKey = url.searchParams.get('api_key');
      
      if (!apiKey) {
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          apiKey = authHeader.replace('Bearer ', '');
        }
      }

      if (!apiKey) {
        logger.warn('WebSocket: No API key provided');
        return false;
      }

      // ✅ Valider l'API key
      const validatedKey = await this.apiKeyService.validateApiKey(apiKey);
      if (!validatedKey) {
        logger.warn('WebSocket: Invalid API key', { keyPreview: apiKey.substring(0, 10) + '...' });
        return false;
      }

      // 🛡️ Vérifier les permissions WebSocket
      if (!this.apiKeyService.hasPermission(validatedKey, 'zone:read')) {
        logger.warn('WebSocket: Insufficient permissions', { 
          keyName: validatedKey.keyName,
          required: 'zone:read',
          available: validatedKey.permissions
        });
        return false;
      }

      // 📊 Enregistrer l'usage (async)
      this.apiKeyService.recordUsage(validatedKey.id, '/ws/zones').catch(error => {
        logger.error('Failed to record WebSocket usage', { 
          keyId: validatedKey.id, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      });

      // 💾 Attacher les infos d'authentification
      ws.apiKey = {
        id: validatedKey.id,
        keyName: validatedKey.keyName,
        permissions: validatedKey.permissions
      };

      return true;
    } catch (error) {
      logger.error('WebSocket authentication error:', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // ========== GESTION DES MESSAGES (PING SEULEMENT) ==========
  private handleMessage(ws: AuthenticatedWebSocket, data: WebSocket.RawData): void {
    try {
      const messageStr = data.toString();
      
      if (!this.isValidJson(messageStr)) {
        logger.debug('Invalid JSON from WebSocket client', { 
          clientId: ws.clientId,
          message: messageStr.substring(0, 100) 
        });
        this.sendError(ws, 'Invalid JSON format');
        return;
      }

      const message = JSON.parse(messageStr);
      
      // ✅ Seuls les pings sont autorisés (WebSocket en lecture seule)
      if (message.type === 'ping') {
        const pongMessage: PongMessage = { 
          type: 'pong', 
          timestamp: Date.now() 
        };
        this.sendToClient(ws, pongMessage);
        logger.debug('Ping/pong exchange', { clientId: ws.clientId });
        return;
      }

      // ❌ Rejeter tout autre message
      this.sendError(ws, 'Read-only WebSocket. Only ping messages are allowed.');
      
    } catch (error) {
      logger.error('Error processing WebSocket message:', { 
        clientId: ws.clientId,
        error: error instanceof Error ? error.message : 'Unknown error',
        rawMessage: data.toString().substring(0, 100)
      });
      this.sendError(ws, 'Message processing error');
    }
  }

  private handleDisconnection(ws: AuthenticatedWebSocket, code: number, reason: Buffer): void {
    this.authenticatedClients.delete(ws);
    
    const keyName = ws.apiKey?.keyName || 'Unknown';
    const clientId = ws.clientId || 'Unknown';
    
    logger.info(`🔌 WebSocket disconnected`, { 
      clientId,
      keyName,
      code,
      reason: reason.toString(),
      remainingClients: this.authenticatedClients.size
    });
  }

  // ========== SUBSCRIPTION AUX TRANSITIONS REDIS ==========
  private async subscribeToRedisTransitions(): Promise<void> {
    try {
      logger.info('🔧 Setting up Redis zone transition subscriptions...');
      
      // ✅ S'abonner SEULEMENT aux événements de transition
      await this.redis.subscribeToZoneEvents((channel: string, message: string) => {
        logger.debug('📡 Redis transition event received', { 
          channel, 
          messagePreview: message.substring(0, 100),
          clientsCount: this.authenticatedClients.size
        });
        
        this.handleZoneTransitionEvent(channel, message);
      });
      
      logger.info('✅ Redis zone transition subscriptions active');
    } catch (error) {
      logger.error('❌ Failed to subscribe to Redis transitions:', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }

  // ========== TRAITEMENT DES ÉVÉNEMENTS DE TRANSITION ==========
  private handleZoneTransitionEvent(channel: string, message: string): void {
    try {
      if (!this.isValidJson(message)) {
        logger.warn('Invalid JSON transition event', { channel, message: message.substring(0, 100) });
        return;
      }

      const transitionData = JSON.parse(message);
      
      // ✅ Validation des données de transition
      if (!this.isValidTransitionEvent(transitionData)) {
        logger.warn('Invalid transition event structure', { transitionData });
        return;
      }
      
      // 🎯 Convertir en format WebSocket optimisé
      const wsMessage: ZoneEventMessage = {
        type: 'zone_event',
        data: {
          playerUuid: transitionData.playerUuid,
          action: transitionData.eventType, // 'enter' ou 'leave'
          zoneType: transitionData.zoneType, // 'region', 'node', 'city'
          zoneId: transitionData.zoneId,
          zoneName: transitionData.zoneName,
          timestamp: transitionData.timestamp
        },
        timestamp: Date.now()
      };
      
      // 📊 Statistiques
      const eventKey = `${transitionData.zoneType}_${transitionData.eventType}` as keyof typeof this.stats.eventsByType;
      if (eventKey in this.stats.eventsByType) {
        this.stats.eventsByType[eventKey]++;
      }
      this.stats.totalEvents++;
      
      // 📡 Broadcast à TOUS les clients (pas de rooms, comme demandé)
      this.broadcastToAll(wsMessage);
      
      logger.info('✅ Zone transition broadcasted', { 
        playerUuid: transitionData.playerUuid,
        action: `${transitionData.zoneType}_${transitionData.eventType}`,
        zoneName: transitionData.zoneName,
        clientsNotified: this.authenticatedClients.size
      });
      
    } catch (error) {
      logger.error('Error processing zone transition event:', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        channel,
        message: message.substring(0, 200)
      });
    }
  }

  // ========== VALIDATION ==========
  private isValidTransitionEvent(data: any): boolean {
    return data &&
           typeof data.playerUuid === 'string' &&
           typeof data.eventType === 'string' &&
           ['enter', 'leave'].includes(data.eventType) &&
           typeof data.zoneType === 'string' &&
           ['region', 'node', 'city'].includes(data.zoneType) &&
           typeof data.zoneId === 'number' &&
           typeof data.zoneName === 'string' &&
           typeof data.timestamp === 'number';
  }

  private isValidJson(str: string): boolean {
    try {
      JSON.parse(str);
      return true;
    } catch {
      return false;
    }
  }

  // ========== BROADCASTING ==========
  private broadcastToAll(message: WebSocketMessage): void {
    const messageStr = JSON.stringify(message);
    const messageSize = Buffer.byteLength(messageStr, 'utf8');
    
    let successCount = 0;
    let errorCount = 0;
    const deadClients: AuthenticatedWebSocket[] = [];

    this.authenticatedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(messageStr);
          successCount++;
          this.stats.totalBytesSent += messageSize;
        } catch (error) {
          errorCount++;
          logger.error('Error sending message to client:', { 
            clientId: client.clientId,
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      } else {
        // Marquer pour suppression
        deadClients.push(client);
      }
    });

    // 🧹 Nettoyer les connexions mortes
    deadClients.forEach(client => {
      this.authenticatedClients.delete(client);
    });

    if (errorCount > 0) {
      logger.warn('Broadcast partially failed', { 
        successCount, 
        errorCount,
        deadClients: deadClients.length,
        messageType: message.type
      });
    } else if (successCount > 0) {
      logger.debug('Message broadcasted successfully', { 
        recipients: successCount,
        messageSize,
        messageType: message.type
      });
    }
  }

  private sendToClient(client: WebSocket, data: WebSocketMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      try {
        const messageStr = JSON.stringify(data);
        client.send(messageStr);
        this.stats.totalBytesSent += Buffer.byteLength(messageStr, 'utf8');
      } catch (error) {
        logger.error('Error sending message to client:', { 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    }
  }

  private sendError(client: WebSocket, message: string): void {
    const errorMessage: ErrorMessage = {
      type: 'error',
      message,
      timestamp: Date.now()
    };
    this.sendToClient(client, errorMessage);
  }

  // ========== HEARTBEAT ==========
  private startHeartbeat(): void {
    const interval = parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000');
    
    this.heartbeatInterval = setInterval(() => {
      logger.debug('💓 WebSocket heartbeat check', { 
        totalClients: this.authenticatedClients.size 
      });

      const deadClients: AuthenticatedWebSocket[] = [];

      this.authenticatedClients.forEach((ws) => {
        if (ws.isAlive === false) {
          deadClients.push(ws);
          return;
        }
        
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (error) {
          deadClients.push(ws);
        }
      });

      // Nettoyer les connexions mortes
      deadClients.forEach(ws => {
        ws.terminate();
        this.authenticatedClients.delete(ws);
      });

      if (deadClients.length > 0) {
        logger.info('💀 Cleaned up dead WebSocket connections', { 
          removed: deadClients.length,
          remaining: this.authenticatedClients.size
        });
      }
    }, interval);
    
    logger.info(`💓 WebSocket heartbeat started`, { 
      interval: `${interval}ms`,
      compressionEnabled: this.compressionEnabled
    });
  }

  // ========== API PUBLIQUE ==========
  getConnectedClientsCount(): number {
    return this.authenticatedClients.size;
  }

  getConnectedClients(): Array<{ clientId: string; keyName: string; connected: string }> {
    return Array.from(this.authenticatedClients)
      .map(ws => ({
        clientId: ws.clientId || 'unknown',
        keyName: ws.apiKey?.keyName || 'unknown',
        connected: new Date().toISOString()
      }));
  }

  getStats() {
    return {
      ...this.stats,
      currentConnections: this.authenticatedClients.size,
      compressionEnabled: this.compressionEnabled,
      averageMessageSize: this.stats.totalEvents > 0 
        ? Math.round(this.stats.totalBytesSent / this.stats.totalEvents) 
        : 0
    };
  }

  // ========== CLEANUP ==========
  close(): void {
    logger.info('🛑 Shutting down WebSocket server...');

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Fermer toutes les connexions proprement
    this.authenticatedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        this.sendToClient(client, {
          type: 'error',
          message: 'Server shutting down',
          timestamp: Date.now()
        });
        client.close(1001, 'Server shutdown');
      }
    });

    this.wss.close(() => {
      logger.info('✅ WebSocket server closed', {
        finalStats: this.getStats()
      });
    });
  }
}