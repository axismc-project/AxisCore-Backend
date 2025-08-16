// src/websocket/FixedZoneWebSocketServer.ts (corrections de toutes les erreurs)

import WebSocket from 'ws';
import { Server as HTTPServer } from 'http';
import { RedisService } from '../services/RedisService';
import { ApiKeyService } from '../services/ApiKeyService';
import { logger } from '../utils/logger';

interface AuthenticatedWebSocket extends WebSocket {
  apiKey?: {
    id: number;
    keyName: string;
    permissions: string[];
  };
  isAlive?: boolean;
  clientId?: string;
  connectionTime?: number;
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
  messageId: string;
  timestamp: number;
}

// ✅ FIX: Updated SystemMessage interface to include 'maintenance'
interface SystemMessage {
  type: 'connected' | 'pong' | 'error' | 'shutdown' | 'maintenance';
  message?: string;
  features?: string[];
  timestamp: number;
  clientId?: string;
}

type WebSocketMessage = ZoneEventMessage | SystemMessage;

interface WebSocketStats {
  totalConnections: number;
  currentConnections: number;
  totalEvents: number;
  totalBytesSent: number;
  totalBytesReceived: number;
  eventsByType: {
    region_enter: number;
    region_leave: number;
    node_enter: number;
    node_leave: number;
    city_enter: number;
    city_leave: number;
  };
  averageMessageSize: number;
  uptimeMs: number;
}

export class FixedZoneWebSocketServer {
  private wss: WebSocket.Server;
  private authenticatedClients: Set<AuthenticatedWebSocket> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private startTime = Date.now();
  
  // Statistics
  private stats: WebSocketStats = {
    totalConnections: 0,
    currentConnections: 0,
    totalEvents: 0,
    totalBytesSent: 0,
    totalBytesReceived: 0,
    eventsByType: {
      region_enter: 0,
      region_leave: 0,
      node_enter: 0,
      node_leave: 0,
      city_enter: 0,
      city_leave: 0
    },
    averageMessageSize: 0,
    uptimeMs: 0
  };

  constructor(
    server: HTTPServer,
    private redis: RedisService,
    private apiKeyService: ApiKeyService
  ) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/ws/zones',
      perMessageDeflate: {
        threshold: 1024,
        concurrencyLimit: 10,
        serverMaxWindowBits: 15,
        clientMaxWindowBits: 15,
        // ✅ FIX: Corrected property names
        serverNoContextTakeover: false,
        clientNoContextTakeover: false,
        zlibDeflateOptions: {
          level: 6,
          chunkSize: 1024
        }
      }
    });
    
    this.setupWebSocketServer();
    this.startHeartbeat();
    this.subscribeToRedisEvents();
    
    logger.info('🚀 FixedZoneWebSocketServer initialized with compression');
  }

  // ========== SERVER SETUP ==========
  
  private setupWebSocketServer(): void {
    this.wss.on('connection', async (ws: AuthenticatedWebSocket, request) => {
      const clientIP = request.socket.remoteAddress;
      const userAgent = request.headers['user-agent'];
      
      logger.info('🔌 New WebSocket connection attempt', { 
        clientIP, 
        userAgent: userAgent?.substring(0, 50) + (userAgent && userAgent.length > 50 ? '...' : '')
      });
      
      try {
        // Authenticate connection
        const authenticated = await this.authenticateConnection(ws, request);
        if (!authenticated) {
          this.sendError(ws, 'Authentication required. Provide API key via ?api_key=xxx or Authorization header.');
          ws.close(1008, 'Authentication required');
          return;
        }

        // Setup authenticated client
        this.setupAuthenticatedClient(ws);
        
      } catch (error) {
        logger.error('❌ WebSocket setup error', { 
          clientIP,
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        this.sendError(ws, 'Connection setup failed');
        ws.close(1011, 'Setup failed');
      }
    });
    
    this.wss.on('error', (error) => {
      logger.error('❌ WebSocket server error', { 
        error: error.message 
      });
    });
    
    logger.info('✅ WebSocket server configured on /ws/zones');
  }

  private setupAuthenticatedClient(ws: AuthenticatedWebSocket): void {
    // Initialize client properties
    ws.isAlive = true;
    ws.clientId = `${ws.apiKey!.keyName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    ws.connectionTime = Date.now();
    
    // Add to authenticated clients
    this.authenticatedClients.add(ws);
    this.stats.totalConnections++;
    this.stats.currentConnections = this.authenticatedClients.size;
    
    // Setup event handlers
    this.setupClientEventHandlers(ws);
    
    // Send welcome message
    this.sendWelcomeMessage(ws);
    
    logger.info('✅ WebSocket client authenticated and ready', {
      clientId: ws.clientId,
      keyName: ws.apiKey!.keyName,
      totalClients: this.authenticatedClients.size,
      permissions: ws.apiKey!.permissions
    });
  }

  private setupClientEventHandlers(ws: AuthenticatedWebSocket): void {
    // Message handler
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        // ✅ FIX: Proper handling of RawData type
        const dataLength = Buffer.isBuffer(data) ? data.length : 
                          data instanceof ArrayBuffer ? data.byteLength :
                          Array.isArray(data) ? data.reduce((sum, buf) => sum + buf.length, 0) : 0;
        
        this.stats.totalBytesReceived += dataLength;
        this.handleMessage(ws, data);
      } catch (error) {
        logger.error('❌ Error handling message', {
          clientId: ws.clientId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
    
    // Close handler
    ws.on('close', (code, reason) => {
      this.handleDisconnection(ws, code, reason);
    });
    
    // Error handler
    ws.on('error', (error) => {
      logger.error('❌ WebSocket client error', { 
        clientId: ws.clientId,
        error: error.message 
      });
    });
    
    // Pong handler (heartbeat response)
    ws.on('pong', () => {
      ws.isAlive = true;
      logger.debug('💓 Pong received', { clientId: ws.clientId });
    });
  }

  private sendWelcomeMessage(ws: AuthenticatedWebSocket): void {
    const welcomeMessage: SystemMessage = {
      type: 'connected',
      message: 'WebSocket connected successfully - Real-time zone events enabled',
      features: [
        'Zone enter/leave events only',
        'Compression enabled',
        'Filtered events (no wilderness movements)',
        'Real-time broadcasting',
        'Heartbeat monitoring'
      ],
      timestamp: Date.now(),
      clientId: ws.clientId
    };

    this.sendMessage(ws, welcomeMessage);
  }

  // ========== AUTHENTICATION ==========
  
  private async authenticateConnection(ws: AuthenticatedWebSocket, request: any): Promise<boolean> {
    try {
      // Extract API key from query or headers
      const url = new URL(request.url || '', 'http://localhost');
      const apiKeyFromQuery = url.searchParams.get('api_key');
      const authHeader = request.headers.authorization;
      
      let apiKey: string | null = null;
      
      if (apiKeyFromQuery) {
        apiKey = apiKeyFromQuery;
      } else if (authHeader?.startsWith('Bearer ')) {
        apiKey = authHeader.replace('Bearer ', '');
      }
      
      if (!apiKey) {
        logger.warn('⚠️ WebSocket connection without API key', { 
          ip: request.socket.remoteAddress 
        });
        return false;
      }
      
      // Validate API key
      const validatedKey = await this.apiKeyService.validateApiKey(apiKey);
      if (!validatedKey) {
        logger.warn('⚠️ WebSocket connection with invalid API key', { 
          ip: request.socket.remoteAddress,
          keyPreview: apiKey.substring(0, 8) + '...'
        });
        return false;
      }
      
      // Check permissions
      if (!this.apiKeyService.hasPermission(validatedKey, 'zone:read')) {
        logger.warn('⚠️ WebSocket connection without zone:read permission', { 
          keyName: validatedKey.keyName,
          permissions: validatedKey.permissions
        });
        return false;
      }
      
      // Store validated key info
      ws.apiKey = {
        id: validatedKey.id,
        keyName: validatedKey.keyName,
        permissions: validatedKey.permissions
      };
      
      // Record usage asynchronously
      this.apiKeyService.recordUsage(validatedKey.id, '/ws/zones').catch(error => {
        logger.error('Failed to record WebSocket API usage', { 
          keyId: validatedKey.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      });
      
      return true;
      
    } catch (error) {
      logger.error('❌ WebSocket authentication error', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // ========== MESSAGE HANDLING ==========
  
  private handleMessage(ws: AuthenticatedWebSocket, data: WebSocket.RawData): void {
    try {
      // ✅ FIX: Convert RawData to string properly
      const messageStr = this.rawDataToString(data);
      const message = JSON.parse(messageStr);
      
      // ✅ FIX: Get data size properly
      const dataSize = this.getRawDataSize(data);
      
      logger.debug('📨 WebSocket message received', { 
        clientId: ws.clientId,
        type: message.type,
        size: dataSize
      });
      
      switch (message.type) {
        case 'ping':
          this.sendMessage(ws, {
            type: 'pong',
            timestamp: Date.now(),
            clientId: ws.clientId
          });
          break;
          
        case 'subscribe':
          // Future feature: selective zone subscriptions
          logger.debug('📋 Subscription request (not implemented)', { 
            clientId: ws.clientId,
            data: message.data
          });
          break;
          
        default:
          logger.debug('❓ Unknown message type', { 
            clientId: ws.clientId,
            type: message.type
          });
      }
      
    } catch (error) {
      logger.error('❌ Invalid JSON message', { 
        clientId: ws.clientId,
        error: error instanceof Error ? error.message : 'Unknown error',
        rawData: this.rawDataToString(data).substring(0, 100)
      });
      
      this.sendError(ws, 'Invalid JSON message format');
    }
  }

  // ✅ FIX: Helper methods for RawData handling
  private rawDataToString(data: WebSocket.RawData): string {
    if (Buffer.isBuffer(data)) {
      return data.toString();
    } else if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString();
    } else if (Array.isArray(data)) {
      return Buffer.concat(data).toString();
    }
    return '';
  }

  private getRawDataSize(data: WebSocket.RawData): number {
    if (Buffer.isBuffer(data)) {
      return data.length;
    } else if (data instanceof ArrayBuffer) {
      return data.byteLength;
    } else if (Array.isArray(data)) {
      return data.reduce((sum, buf) => sum + buf.length, 0);
    }
    return 0;
  }

  private handleDisconnection(ws: AuthenticatedWebSocket, code: number, reason: Buffer): void {
    // Remove from authenticated clients
    this.authenticatedClients.delete(ws);
    this.stats.currentConnections = this.authenticatedClients.size;
    
    const sessionDuration = ws.connectionTime ? Date.now() - ws.connectionTime : 0;
    
    logger.info('🔌 WebSocket client disconnected', {
      clientId: ws.clientId,
      keyName: ws.apiKey?.keyName,
      code,
      reason: reason.toString(),
      sessionDurationMs: sessionDuration,
      remainingClients: this.authenticatedClients.size
    });
  }

  // ========== REDIS EVENT SUBSCRIPTION ==========
  
  private async subscribeToRedisEvents(): Promise<void> {
    try {
      logger.info('🔧 Subscribing to Redis zone events...');
      
      await this.redis.subscribeToZoneEvents((channel, message) => {
        try {
          this.handleRedisZoneEvent(channel, message);
        } catch (error) {
          logger.error('❌ Error handling Redis zone event', {
            channel,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      });
      
      logger.info('✅ Successfully subscribed to Redis zone events');
      
    } catch (error) {
      logger.error('❌ Failed to subscribe to Redis events', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  private handleRedisZoneEvent(channel: string, message: string): void {
    try {
      const eventData = JSON.parse(message);
      
      // Validate event data
      if (!this.isValidZoneEvent(eventData)) {
        logger.warn('⚠️ Invalid zone event data received', { 
          channel,
          eventData: JSON.stringify(eventData).substring(0, 200)
        });
        return;
      }
      
      // Create WebSocket message
      const wsMessage: ZoneEventMessage = {
        type: 'zone_event',
        data: {
          playerUuid: eventData.playerUuid,
          action: eventData.eventType, // eventType from Redis -> action for WebSocket
          zoneType: eventData.zoneType,
          zoneId: eventData.zoneId,
          zoneName: eventData.zoneName,
          timestamp: eventData.timestamp
        },
        messageId: `${eventData.zoneType}_${eventData.eventType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        timestamp: Date.now()
      };
      
      // Update statistics
      const eventKey = `${eventData.zoneType}_${eventData.eventType}` as keyof typeof this.stats.eventsByType;
      if (eventKey in this.stats.eventsByType) {
        this.stats.eventsByType[eventKey]++;
      }
      this.stats.totalEvents++;
      
      // Broadcast to all authenticated clients
      this.broadcastToAllClients(wsMessage);
      
      logger.info('📡 Zone event broadcasted', {
        messageId: wsMessage.messageId,
        playerUuid: eventData.playerUuid.substring(0, 8) + '...',
        event: `${eventData.zoneType}_${eventData.eventType}`,
        zoneName: eventData.zoneName,
        clientCount: this.authenticatedClients.size
      });
      
    } catch (error) {
      logger.error('❌ Failed to handle Redis zone event', {
        channel,
        message: message.substring(0, 200),
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private isValidZoneEvent(data: any): boolean {
    return (
      data &&
      typeof data === 'object' &&
      typeof data.playerUuid === 'string' &&
      typeof data.zoneType === 'string' &&
      ['region', 'node', 'city'].includes(data.zoneType) &&
      typeof data.zoneId === 'number' &&
      typeof data.zoneName === 'string' &&
      typeof data.eventType === 'string' &&
      ['enter', 'leave'].includes(data.eventType) &&
      typeof data.timestamp === 'number'
    );
  }

  // ========== MESSAGE SENDING ==========
  
  private sendMessage(ws: AuthenticatedWebSocket, message: WebSocketMessage): void {
    if (ws.readyState !== WebSocket.OPEN) {
      logger.debug('⚠️ Cannot send message - WebSocket not open', { 
        clientId: ws.clientId,
        readyState: ws.readyState
      });
      return;
    }

    try {
      const messageStr = JSON.stringify(message);
      ws.send(messageStr);
      
      this.stats.totalBytesSent += messageStr.length;
      this.updateAverageMessageSize(messageStr.length);
      
      logger.debug('📤 Message sent to client', { 
        clientId: ws.clientId,
        type: message.type,
        size: messageStr.length
      });
      
    } catch (error) {
      logger.error('❌ Failed to send message to client', { 
        clientId: ws.clientId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      // Remove client if sending fails
      this.authenticatedClients.delete(ws);
      this.stats.currentConnections = this.authenticatedClients.size;
    }
  }

  private sendError(ws: AuthenticatedWebSocket, errorMessage: string): void {
    const errorMsg: SystemMessage = {
      type: 'error',
      message: errorMessage,
      timestamp: Date.now(),
      clientId: ws.clientId
    };
    
    this.sendMessage(ws, errorMsg);
  }

  private broadcastToAllClients(message: WebSocketMessage): void {
    if (this.authenticatedClients.size === 0) {
      logger.debug('📡 No clients to broadcast to');
      return;
    }

    let successCount = 0;
    let failureCount = 0;
    const disconnectedClients: AuthenticatedWebSocket[] = [];

    for (const client of this.authenticatedClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          this.sendMessage(client, message);
          successCount++;
        } catch (error) {
          failureCount++;
          disconnectedClients.push(client);
          logger.error('❌ Failed to broadcast to client', { 
            clientId: client.clientId,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      } else {
        disconnectedClients.push(client);
      }
    }

    // Clean up disconnected clients
    disconnectedClients.forEach(client => {
      this.authenticatedClients.delete(client);
    });
    
    if (disconnectedClients.length > 0) {
      this.stats.currentConnections = this.authenticatedClients.size;
      logger.debug('🧹 Cleaned up disconnected clients', { 
        removed: disconnectedClients.length,
        remaining: this.authenticatedClients.size
      });
    }

    logger.debug('📡 Broadcast completed', { 
      messageType: message.type,
      successCount,
      failureCount,
      totalClients: this.authenticatedClients.size
    });
  }

  // ========== HEARTBEAT ==========
  
  private startHeartbeat(): void {
    const interval = parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000');
    
    this.heartbeatInterval = setInterval(() => {
      this.performHeartbeat();
    }, interval);
    
    logger.info('💓 WebSocket heartbeat started', { interval: `${interval}ms` });
  }

  private performHeartbeat(): void {
    const deadClients: AuthenticatedWebSocket[] = [];
    
    for (const client of this.authenticatedClients) {
      if (!client.isAlive) {
        deadClients.push(client);
        continue;
      }
      
      client.isAlive = false;
      
      try {
        client.ping();
      } catch (error) {
        logger.debug('💔 Heartbeat ping failed', { 
          clientId: client.clientId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        deadClients.push(client);
      }
    }
    
    // Remove dead clients
    deadClients.forEach(client => {
      this.authenticatedClients.delete(client);
      
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'Heartbeat timeout');
      }
      
      logger.info('💔 Client removed due to heartbeat failure', { 
        clientId: client.clientId,
        keyName: client.apiKey?.keyName
      });
    });
    
    if (deadClients.length > 0) {
      this.stats.currentConnections = this.authenticatedClients.size;
    }
    
    logger.debug('💓 Heartbeat completed', { 
      activeClients: this.authenticatedClients.size,
      removedClients: deadClients.length
    });
  }

  // ========== STATISTICS ==========
  
  private updateAverageMessageSize(messageSize: number): void {
    if (this.stats.totalEvents === 0) {
      this.stats.averageMessageSize = messageSize;
    } else {
      this.stats.averageMessageSize = 
        (this.stats.averageMessageSize * (this.stats.totalEvents - 1) + messageSize) / this.stats.totalEvents;
    }
  }

  // ========== PUBLIC API ==========
  
  getConnectedClientsCount(): number {
    return this.authenticatedClients.size;
  }

  getConnectedClients(): Array<{
    clientId: string;
    keyName: string;
    permissions: string[];
    connectionTime: number;
    sessionDuration: number;
  }> {
    return Array.from(this.authenticatedClients).map(client => ({
      clientId: client.clientId!,
      keyName: client.apiKey!.keyName,
      permissions: client.apiKey!.permissions,
      connectionTime: client.connectionTime!,
      sessionDuration: Date.now() - client.connectionTime!
    }));
  }

  getStats(): WebSocketStats {
    return {
      ...this.stats,
      currentConnections: this.authenticatedClients.size,
      uptimeMs: Date.now() - this.startTime
    };
  }

  // ========== ADMIN OPERATIONS ==========
  
  async broadcastSystemMessage(message: string, type: 'shutdown' | 'maintenance' = 'shutdown'): Promise<number> {
    const systemMessage: SystemMessage = {
      type, // ✅ FIX: Now type is properly constrained to valid values
      message,
      timestamp: Date.now()
    };
    
    this.broadcastToAllClients(systemMessage);
    
    logger.info('📢 System message broadcasted', { 
      type,
      message,
      clientCount: this.authenticatedClients.size
    });
    
    return this.authenticatedClients.size;
  }

  async disconnectAllClients(reason = 'Server shutdown'): Promise<void> {
    logger.info('🔌 Disconnecting all WebSocket clients', { 
      clientCount: this.authenticatedClients.size,
      reason
    });
    
    // Send shutdown message first
    await this.broadcastSystemMessage(`Server shutting down: ${reason}`, 'shutdown');
    
    // Wait a moment for message delivery
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Close all connections
    const disconnectPromises = Array.from(this.authenticatedClients).map(client => {
      return new Promise<void>(resolve => {
        client.close(1001, reason);
        resolve();
      });
    });
    
    await Promise.all(disconnectPromises);
    
    this.authenticatedClients.clear();
    this.stats.currentConnections = 0;
    
    logger.info('✅ All WebSocket clients disconnected');
  }

  // ========== SHUTDOWN ==========
  
  async close(): Promise<void> {
    try {
      logger.info('🛑 Shutting down FixedZoneWebSocketServer...');
      
      // Stop heartbeat
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      
      // Disconnect all clients gracefully
      await this.disconnectAllClients('Server shutdown');
      
      // Close WebSocket server
      await new Promise<void>((resolve, reject) => {
        this.wss.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      
      logger.info('✅ FixedZoneWebSocketServer shutdown completed', {
        finalStats: {
          totalConnections: this.stats.totalConnections,
          totalEvents: this.stats.totalEvents,
          totalBytesSent: this.stats.totalBytesSent,
          uptimeMs: Date.now() - this.startTime
        }
      });
      
    } catch (error) {
      logger.error('❌ Error during WebSocket server shutdown', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }
}