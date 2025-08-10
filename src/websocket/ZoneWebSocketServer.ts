import WebSocket from 'ws';
import { Server as HTTPServer } from 'http';
import { RedisService } from '../services/RedisService';
import { ZoneEvent } from '../models/Zone';
import { logger } from '../utils/logger';

interface WebSocketClient extends WebSocket {
  playerId?: string;
  isAlive?: boolean;
  subscriptions?: Set<string>;
}

export class ZoneWebSocketServer {
  private wss: WebSocket.Server;
  private clients: Map<string, WebSocketClient> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    server: HTTPServer,
    private redis: RedisService
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
    this.wss.on('connection', (ws: WebSocketClient, request) => {
      logger.info(`🔌 Nouvelle connexion WebSocket: ${request.socket.remoteAddress}`);
      
      // Configuration client
      ws.isAlive = true;
      ws.subscriptions = new Set();
      
      // Gestionnaires d'événements
      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(ws, data);
      });
      
      ws.on('close', (code, reason) => {
        this.handleDisconnection(ws, code, reason);
      });
      
      ws.on('error', (error) => {
        logger.error('Erreur WebSocket:', error);
      });
      
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      
      // Message de bienvenue
      this.sendToClient(ws, {
        type: 'connected',
        message: 'Connexion WebSocket établie',
        timestamp: Date.now()
      });
    });
    
    logger.info('🌐 Serveur WebSocket démarré sur /ws/zones');
  }

  private handleMessage(ws: WebSocketClient, data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'subscribe':
          this.handleSubscription(ws, message);
          break;
        case 'unsubscribe':
          this.handleUnsubscription(ws, message);
          break;
        case 'ping':
          this.sendToClient(ws, { type: 'pong', timestamp: Date.now() });
          break;
        default:
          this.sendToClient(ws, {
            type: 'error',
            message: `Type de message inconnu: ${message.type}`,
            timestamp: Date.now()
          });
      }
    } catch (error) {
      logger.error('Erreur traitement message WebSocket:', error);
      this.sendToClient(ws, {
        type: 'error',
        message: 'Message invalide',
        timestamp: Date.now()
      });
    }
  }

  private handleSubscription(ws: WebSocketClient, message: any): void {
    const { playerUuid, subscriptions } = message;
    
    // Validation UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!playerUuid || !uuidRegex.test(playerUuid)) {
      this.sendToClient(ws, {
        type: 'error',
        message: 'UUID joueur invalide',
        timestamp: Date.now()
      });
      return;
    }
    
    // Associer ce WebSocket au joueur
    ws.playerId = playerUuid;
    this.clients.set(playerUuid, ws);
    
    // Gérer souscriptions aux événements
    if (subscriptions && Array.isArray(subscriptions)) {
      for (const sub of subscriptions) {
        if (this.isValidSubscription(sub)) {
          ws.subscriptions?.add(sub);
        }
      }
    } else {
      // Souscriptions par défaut
      ws.subscriptions?.add('zone_events');
      ws.subscriptions?.add('player_updates');
    }
    
    this.sendToClient(ws, {
      type: 'subscribed',
      playerUuid,
      subscriptions: Array.from(ws.subscriptions || []),
      message: 'Souscription réussie',
      timestamp: Date.now()
    });
    
    logger.info(`✅ Joueur ${playerUuid} souscrit aux événements`);
  }

  private handleUnsubscription(ws: WebSocketClient, message: any): void {
    const { subscriptions } = message;
    
    if (subscriptions && Array.isArray(subscriptions)) {
      for (const sub of subscriptions) {
        ws.subscriptions?.delete(sub);
      }
    }
    
    this.sendToClient(ws, {
      type: 'unsubscribed',
      subscriptions: subscriptions || [],
      message: 'Désinscription réussie',
      timestamp: Date.now()
    });
  }

  private handleDisconnection(ws: WebSocketClient, code: number, reason: Buffer): void {
    if (ws.playerId) {
      this.clients.delete(ws.playerId);
      logger.info(`🔌 Joueur ${ws.playerId} déconnecté (code: ${code})`);
    } else {
      logger.info(`🔌 Client anonyme déconnecté (code: ${code})`);
    }
  }

  private isValidSubscription(subscription: string): boolean {
    const validSubscriptions = [
      'zone_events',
      'player_updates',
      'system_notifications'
    ];
    return validSubscriptions.includes(subscription);
  }

  private async subscribeToRedisEvents(): Promise<void> {
    try {
      await this.redis.subscribeToZoneEvents((channel: string, message: string) => {
        this.handleZoneEvent(channel, message);
      });
      
      logger.info('📡 Souscription aux événements Redis réussie');
    } catch (error) {
      logger.error('❌ Erreur souscription événements Redis:', error);
    }
  }

  private handleZoneEvent(channel: string, message: string): void {
    try {
      const event: ZoneEvent = JSON.parse(message);
      
      // Envoyer notification au joueur concerné
      const client = this.clients.get(event.playerUuid);
      if (client && client.subscriptions?.has('zone_events')) {
        this.sendZoneNotification(client, event);
      }
      
      // Envoyer aussi aux autres joueurs dans la même zone si nécessaire
      this.broadcastZoneEventToNearbyPlayers(event);
      
    } catch (error) {
      logger.error('Erreur traitement événement zone:', error);
    }
  }

  private sendZoneNotification(client: WebSocketClient, event: ZoneEvent): void {
    const notification = this.createZoneNotification(event);
    this.sendToClient(client, notification);
  }

  private createZoneNotification(event: ZoneEvent): any {
    let title: string;
    let message: string;
    let color: string;
    let sound: string;
    
    switch (`${event.zoneType}.${event.eventType}`) {
      case 'city.enter':
        title = `Bienvenue à ${event.zoneName}`;
        message = 'Vous entrez dans la ville';
        color = '#FFD700';
        sound = 'city_enter';
        break;
      case 'city.leave':
        title = 'Au revoir';
        message = `Vous quittez ${event.zoneName}`;
        color = '#87CEEB';
        sound = 'city_leave';
        break;
      case 'node.enter':
        title = `Node: ${event.zoneName}`;
        message = 'Nouveau territoire exploré';
        color = '#98FB98';
        sound = 'node_enter';
        break;
      case 'node.leave':
        title = 'Node quitté';
        message = `Vous quittez ${event.zoneName}`;
        color = '#D3D3D3';
        sound = 'node_leave';
        break;
      case 'region.enter':
        title = `Région: ${event.zoneName}`;
        message = 'Nouvelle région découverte!';
        color = '#DDA0DD';
        sound = 'region_enter';
        break;
      case 'region.leave':
        title = 'Région quittée';
        message = `Vous quittez ${event.zoneName}`;
        color = '#F0E68C';
        sound = 'region_leave';
        break;
      default:
        title = event.zoneName;
        message = event.eventType;
        color = '#FFFFFF';
        sound = 'default';
    }
    
    return {
      type: 'zone_notification',
      data: {
        playerUuid: event.playerUuid,
        title,
        message,
        zoneType: event.zoneType,
        zoneId: event.zoneId,
        zoneName: event.zoneName,
        eventType: event.eventType,
        color,
        sound,
        duration: 3000,
        timestamp: event.timestamp
      }
    };
  }

  private async broadcastZoneEventToNearbyPlayers(event: ZoneEvent): Promise<void> {
    try {
      const playersInZone = await this.redis.getPlayersInZone(event.zoneType, event.zoneId);
      
      for (const playerUuid of playersInZone) {
        const client = this.clients.get(playerUuid);
        if (client && 
            client.playerId !== event.playerUuid &&
            client.subscriptions?.has('zone_events')) {
          
          this.sendToClient(client, {
            type: 'player_zone_event',
            data: {
              playerUuid: event.playerUuid,
              zoneType: event.zoneType,
              zoneName: event.zoneName,
              eventType: event.eventType,
              message: event.eventType === 'enter' 
                ? `Un joueur entre dans ${event.zoneName}`
                : `Un joueur quitte ${event.zoneName}`,
              timestamp: event.timestamp
            }
          });
        }
      }
    } catch (error) {
      logger.error('Erreur diffusion événement proximité:', error);
    }
  }

  private sendToClient(client: WebSocket, data: any): void {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(data));
      } catch (error) {
        logger.error('Erreur envoi message WebSocket:', error);
      }
    }
  }

  private startHeartbeat(): void {
    const interval = parseInt(process.env.WS_HEARTBEAT_INTERVAL || '30000');
    
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws: WebSocketClient) => {
if (ws.isAlive === false) {
         ws.terminate();
         return;
       }
       
       ws.isAlive = false;
       ws.ping();
     });
   }, interval);
   
   logger.info(`💓 Heartbeat WebSocket démarré (${interval}ms)`);
 }

 // ========== API PUBLIQUE ==========
 broadcast(message: any): void {
   this.wss.clients.forEach((client) => {
     this.sendToClient(client, message);
   });
 }

 sendToPlayer(playerUuid: string, message: any): boolean {
   const client = this.clients.get(playerUuid);
   if (client) {
     this.sendToClient(client, message);
     return true;
   }
   return false;
 }

 getConnectedPlayersCount(): number {
   return this.clients.size;
 }

 getConnectedPlayers(): string[] {
   return Array.from(this.clients.keys());
 }

 isPlayerConnected(playerUuid: string): boolean {
   return this.clients.has(playerUuid);
 }

 disconnect(playerUuid: string): boolean {
   const client = this.clients.get(playerUuid);
   if (client) {
     client.close(1000, 'Disconnected by server');
     return true;
   }
   return false;
 }

 // Nettoyage à la fermeture
 close(): void {
   if (this.heartbeatInterval) {
     clearInterval(this.heartbeatInterval);
     this.heartbeatInterval = null;
   }
   
   this.wss.close(() => {
     logger.info('🔌 Serveur WebSocket fermé');
   });
 }
}