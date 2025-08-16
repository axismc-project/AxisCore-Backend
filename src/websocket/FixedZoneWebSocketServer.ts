// src/websocket/FixedZoneWebSocketServer.ts
import WebSocket from 'ws';
import { Server as HTTPServer } from 'http';
import { ApiKeyService } from '../services/ApiKeyService';
import { ZoneTransition } from '../services/ZoneTransitionService';
import { logger } from '../utils/logger';

interface AuthenticatedWebSocket extends WebSocket {
  clientId: string;
  apiKey: { keyName: string; permissions: string[] };
  connectionTime: number;
  isAlive: boolean;
}

interface ZoneEventMessage {
  type: 'zone_event';
  data: ZoneTransition;
  messageId: string;
  timestamp: number;
}

interface SystemMessage {
  type: 'connected' | 'pong' | 'error';
  message?: string;
  timestamp: number;
  clientId?: string;
}

export class FixedZoneWebSocketServer {
  private wss: WebSocket.Server;
  private clients = new Set<AuthenticatedWebSocket>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  
  private stats = {
    totalConnections: 0,
    totalEvents: 0,
    totalBytesSent: 0
  };

  constructor(
    server: HTTPServer,
    private apiKeyService: ApiKeyService
  ) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws/zones',
      perMessageDeflate: { threshold: 1024 }
    });
    
    this.setupServer();
    this.startHeartbeat();
    
    logger.info('🚀 Zone WebSocket Server initialized');
  }

  // ========== SERVER SETUP ==========
  
  private setupServer(): void {
    this.wss.on('connection', async (ws: AuthenticatedWebSocket, request) => {
      try {
        const authenticated = await this.authenticateConnection(ws, request);
        if (!authenticated) {
          ws.close(1008, 'Authentication required');
          return;
        }

        this.setupClient(ws);
        
      } catch (error) {
        logger.error('❌ WebSocket setup error', { error });
        ws.close(1011, 'Setup failed');
      }
    });
  }

  private async authenticateConnection(ws: AuthenticatedWebSocket, request: any): Promise<boolean> {
    try {
      const url = new URL(request.url || '', 'http://localhost');
      const apiKey = url.searchParams.get('api_key') || 
                    request.headers.authorization?.replace('Bearer ', '');
      
      if (!apiKey) return false;
      
      const validatedKey = await this.apiKeyService.validateApiKey(apiKey);
      if (!validatedKey || !this.apiKeyService.hasPermission(validatedKey, 'zone:read')) {
        return false;
      }
      
      ws.apiKey = {
        keyName: validatedKey.keyName,
        permissions: validatedKey.permissions
      };
      
      return true;
      
    } catch (error) {
      logger.error('❌ WebSocket authentication failed', { error });
      return false;
    }
  }

  private setupClient(ws: AuthenticatedWebSocket): void {
    ws.clientId = `${ws.apiKey.keyName}_${Date.now()}`;
    ws.connectionTime = Date.now();
    ws.isAlive = true;
    
    this.clients.add(ws);
    this.stats.totalConnections++;
    
    // Event handlers
    ws.on('message', (data) => this.handleMessage(ws, data));
    ws.on('close', () => this.handleDisconnection(ws));
    ws.on('pong', () => { ws.isAlive = true; });
    
    // Welcome message
    this.sendMessage(ws, {
      type: 'connected',
      message: 'Real-time zone events active',
      timestamp: Date.now(),
      clientId: ws.clientId
    });
    
    logger.info('✅ WebSocket client connected', {
      clientId: ws.clientId,
      keyName: ws.apiKey.keyName,
      totalClients: this.clients.size
    });
  }

  // ========== MESSAGE HANDLING ==========
  
  private handleMessage(ws: AuthenticatedWebSocket, data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'ping') {
        this.sendMessage(ws, {
          type: 'pong',
          timestamp: Date.now(),
          clientId: ws.clientId
        });
      }
      
    } catch (error) {
      this.sendMessage(ws, {
        type: 'error',
        message: 'Invalid JSON message',
        timestamp: Date.now()
      });
    }
  }

  private handleDisconnection(ws: AuthenticatedWebSocket): void {
    this.clients.delete(ws);
    
    const sessionDuration = Date.now() - ws.connectionTime;
    logger.info('🔌 WebSocket client disconnected', {
      clientId: ws.clientId,
      sessionDurationMs: sessionDuration,
      remainingClients: this.clients.size
    });
  }

  // ========== ZONE EVENT BROADCASTING ==========
  
  broadcastZoneEvent(transition: ZoneTransition): void {
    if (this.clients.size === 0) return;
    
    const message: ZoneEventMessage = {
      type: 'zone_event',
      data: transition,
      messageId: `${transition.zoneType}_${transition.action}_${Date.now()}`,
      timestamp: Date.now()
    };
    
    this.broadcastToAll(message);
    this.stats.totalEvents++;
    
    logger.info('📡 Zone event broadcasted', {
      playerUuid: transition.playerUuid.substring(0, 8) + '...',
      action: transition.action,
      zone: `${transition.zoneType}:${transition.zoneId}`,
      clientCount: this.clients.size
    });
  }

  private sendMessage(ws: AuthenticatedWebSocket, message: SystemMessage | ZoneEventMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    
    try {
      const messageStr = JSON.stringify(message);
      ws.send(messageStr);
      this.stats.totalBytesSent += messageStr.length;
    } catch (error) {
      logger.error('❌ Failed to send message', { clientId: ws.clientId, error });
      this.clients.delete(ws);
    }
  }

  private broadcastToAll(message: ZoneEventMessage): void {
    const disconnectedClients: AuthenticatedWebSocket[] = [];
    
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        this.sendMessage(client, message);
      } else {
        disconnectedClients.push(client);
      }
    }
    
    // Cleanup
    disconnectedClients.forEach(client => this.clients.delete(client));
  }

  // ========== HEARTBEAT ==========
  
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const deadClients: AuthenticatedWebSocket[] = [];
      
      for (const client of this.clients) {
        if (!client.isAlive) {
          deadClients.push(client);
          continue;
        }
        
        client.isAlive = false;
        client.ping();
      }
      
      deadClients.forEach(client => {
        this.clients.delete(client);
        client.close();
      });
      
    }, 30000); // 30 secondes
  }

  getConnectedClients(): Array<{
  clientId: string;
  keyName: string;
  permissions: string[];
  connectionTime: number;
  sessionDuration: number;
}> {
  return Array.from(this.clients).map(client => ({
    clientId: client.clientId,
    keyName: client.apiKey.keyName,
    permissions: client.apiKey.permissions,
    connectionTime: client.connectionTime,
    sessionDuration: Date.now() - client.connectionTime
  }));
}

  // ========== PUBLIC API ==========
  
  getConnectedClientsCount(): number {
    return this.clients.size;
  }

 getStats() {
  return {
    ...this.stats,
    currentConnections: this.clients.size,
    connectedClients: this.getConnectedClients()
  };
}

  async close(): Promise<void> {
    logger.info('🛑 Shutting down WebSocket server...');
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Disconnect all clients
    for (const client of this.clients) {
      client.close(1001, 'Server shutdown');
    }
    
    this.clients.clear();
    this.wss.close();
    
    logger.info('✅ WebSocket server shutdown completed');
  }
}
