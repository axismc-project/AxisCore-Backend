// src/services/ZoneTransitionService.ts
import { RedisService, ChunkZoneData, ZoneTransitionEvent } from './RedisService';
import { logger } from '../utils/logger';

export interface ZoneTransition {
  playerUuid: string;
  action: 'enter' | 'leave';
  zoneType: 'region' | 'node' | 'city';
  zoneId: number;
  zoneName: string;
  timestamp: number;
}

export class ZoneTransitionService {
  private isActive = false;

  constructor(
    private redis: RedisService,
    private onTransition: (transition: ZoneTransition) => void
  ) {}

  // ========== INITIALIZATION ==========
  
  async start(): Promise<void> {
    try {
      logger.info('🎯 Starting Zone Transition Service...');
      
      await this.redis.subscribeToPlayerMovements(this.handleZoneTransition.bind(this));
      
      this.isActive = true;
      logger.info('✅ Zone Transition Service active');
      
    } catch (error) {
      logger.error('❌ Failed to start Zone Transition Service', { error });
      throw error;
    }
  }

  // ========== CORE TRANSITION LOGIC ==========
  
  // src/services/ZoneTransitionService.ts - REMPLACER handleZoneTransition

private async handleZoneTransition(event: ZoneTransitionEvent): Promise<void> {
  try {
    const uuid = event.playerUuid;
    
    logger.debug('🔍 Processing zone transition', {
      playerUuid: uuid.substring(0, 8) + '...',
      currentChunk: event.currentChunk
    });

    // 1. Récupérer les zones précédentes stockées
    const previousZones = await this.redis.getPlayerPreviousZones(uuid);
    
    // 2. Récupérer les zones actuelles
    const currentZones = await this.redis.getChunkZone(
      event.currentChunk.x, 
      event.currentChunk.z
    );

    // 3. Détecter les transitions
    const transitions = this.detectTransitions(previousZones, currentZones);
    
    if (transitions.length === 0) {
      logger.debug('➖ No zone transitions detected', {
        playerUuid: uuid.substring(0, 8) + '...',
        previousZones: this.formatZones(previousZones),
        currentZones: this.formatZones(currentZones)
      });
    } else {
      // 4. Publier chaque transition
      for (const transition of transitions) {
        const zoneTransition: ZoneTransition = {
          playerUuid: uuid,
          action: transition.action,
          zoneType: transition.zoneType,
          zoneId: transition.zoneId,
          zoneName: transition.zoneName,
          timestamp: event.timestamp
        };

        logger.info('🎉 Zone transition detected', {
          playerUuid: uuid.substring(0, 8) + '...',
          action: transition.action,
          zone: `${transition.zoneType}:${transition.zoneId} (${transition.zoneName})`
        });

        // Callback vers WebSocket
        this.onTransition(zoneTransition);
      }
    }

    // 5. Sauvegarder les zones actuelles comme précédentes
    await this.redis.setPlayerPreviousZones(uuid, currentZones);

  } catch (error) {
    logger.error('❌ Failed to process zone transition', { 
      playerUuid: event.playerUuid, 
      error 
    });
  }
}

// Ajouter méthode utilitaire
private formatZones(zones: ChunkZoneData | null): string {
  if (!zones) return 'wilderness';
  
  const parts: string[] = [];
  if (zones.regionId) parts.push(`R${zones.regionId}`);
  if (zones.nodeId) parts.push(`N${zones.nodeId}`);
  if (zones.cityId) parts.push(`C${zones.cityId}`);
  
  return parts.length > 0 ? parts.join(',') : 'wilderness';
}

  // ========== TRANSITION DETECTION ==========
  
  private detectTransitions(
    previousZones: ChunkZoneData | null, 
    currentZones: ChunkZoneData | null
  ): Array<{
    action: 'enter' | 'leave';
    zoneType: 'region' | 'node' | 'city';
    zoneId: number;
    zoneName: string;
  }> {
    
    const transitions: Array<{
      action: 'enter' | 'leave';
      zoneType: 'region' | 'node' | 'city';
      zoneId: number;
      zoneName: string;
    }> = [];

    // Détecter les changements pour chaque type de zone
    this.detectZoneTypeTransitions('region', previousZones, currentZones, transitions);
    this.detectZoneTypeTransitions('node', previousZones, currentZones, transitions);
    this.detectZoneTypeTransitions('city', previousZones, currentZones, transitions);

    return transitions;
  }

  private detectZoneTypeTransitions(
    zoneType: 'region' | 'node' | 'city',
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null,
    transitions: Array<{
      action: 'enter' | 'leave';
      zoneType: 'region' | 'node' | 'city';
      zoneId: number;
      zoneName: string;
    }>
  ): void {
    
    const previousId = this.getZoneId(previousZones, zoneType);
    const currentId = this.getZoneId(currentZones, zoneType);
    const currentName = this.getZoneName(currentZones, zoneType);

    // Aucun changement
    if (previousId === currentId) {
      return;
    }

    // LEAVE: zone → null ou zone A → zone B
    if (previousId !== null) {
      transitions.push({
        action: 'leave',
        zoneType,
        zoneId: previousId,
        zoneName: this.getZoneName(previousZones, zoneType) || `${this.capitalize(zoneType)} ${previousId}`
      });
    }

    // ENTER: null → zone ou zone A → zone B
    if (currentId !== null) {
      transitions.push({
        action: 'enter',
        zoneType,
        zoneId: currentId,
        zoneName: currentName || `${this.capitalize(zoneType)} ${currentId}`
      });
    }
  }

  // ========== UTILITIES ==========
  
  private getZoneId(zones: ChunkZoneData | null, type: 'region' | 'node' | 'city'): number | null {
    if (!zones) return null;
    
    switch (type) {
      case 'region': return zones.regionId;
      case 'node': return zones.nodeId;
      case 'city': return zones.cityId;
    }
  }

  private getZoneName(zones: ChunkZoneData | null, type: 'region' | 'node' | 'city'): string | null {
    if (!zones) return null;
    
    switch (type) {
      case 'region': return zones.regionName;
      case 'node': return zones.nodeName;
      case 'city': return zones.cityName;
    }
  }

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // ========== STATUS ==========
  
  isRunning(): boolean {
    return this.isActive;
  }

  async stop(): Promise<void> {
    this.isActive = false;
    logger.info('🛑 Zone Transition Service stopped');
  }
}