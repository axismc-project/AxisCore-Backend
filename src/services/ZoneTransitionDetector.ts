import { ChunkZoneData } from '../models/Zone';
import { logger } from '../utils/logger';

export interface ZoneTransition {
  playerUuid: string;
  previousZones: ChunkZoneData | null;
  currentZones: ChunkZoneData | null;
  transitions: {
    region?: { type: 'enter' | 'leave'; zoneId: number; zoneName: string };
    node?: { type: 'enter' | 'leave'; zoneId: number; zoneName: string };
    city?: { type: 'enter' | 'leave'; zoneId: number; zoneName: string };
  };
}

export class ZoneTransitionDetector {
  
  /**
   * 🎯 MÉTHODE PRINCIPALE : Détecte UNIQUEMENT les vraies transitions de zones
   * Retourne null si aucune transition significative (évite le spam wilderness)
   */
  detectTransitions(
    playerUuid: string,
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null
  ): ZoneTransition | null {
    
    // 🔍 Log de debug pour traçabilité
    logger.debug('🔍 TRANSITION ANALYSIS', {
      playerUuid,
      previous: this.formatZones(previousZones),
      current: this.formatZones(currentZones)
    });

    // ❌ CAS 1: Wilderness → Wilderness (FILTRÉ)
    if (this.isWilderness(previousZones) && this.isWilderness(currentZones)) {
      logger.debug('🚫 FILTERED: Wilderness → Wilderness', { playerUuid });
      return null;
    }

    // ❌ CAS 2: Zones identiques (FILTRÉ)
    if (this.areZonesIdentical(previousZones, currentZones)) {
      logger.debug('🚫 FILTERED: Same zones', { 
        playerUuid, 
        zones: this.formatZones(currentZones) 
      });
      return null;
    }

    // ✅ CAS 3: Analyser les transitions réelles
    const transitions: ZoneTransition['transitions'] = {};
    let hasTransition = false;

    // Analyser chaque type de zone
    const regionTransition = this.detectSingleZoneTransition(
      'region',
      previousZones?.regionId || null,
      currentZones?.regionId || null,
      currentZones?.regionName || null
    );

    const nodeTransition = this.detectSingleZoneTransition(
      'node',
      previousZones?.nodeId || null,
      currentZones?.nodeId || null,
      currentZones?.nodeName || null
    );

    const cityTransition = this.detectSingleZoneTransition(
      'city',
      previousZones?.cityId || null,
      currentZones?.cityId || null,
      currentZones?.cityName || null
    );

    // Collecter les transitions détectées
    if (regionTransition) {
      transitions.region = regionTransition;
      hasTransition = true;
    }

    if (nodeTransition) {
      transitions.node = nodeTransition;
      hasTransition = true;
    }

    if (cityTransition) {
      transitions.city = cityTransition;
      hasTransition = true;
    }

    // ❌ Aucune transition réelle trouvée
    if (!hasTransition) {
      logger.debug('🚫 FILTERED: No real transitions detected', { playerUuid });
      return null;
    }

    // ✅ Transitions confirmées
    logger.info('✅ ZONE TRANSITIONS DETECTED', {
      playerUuid,
      transitionsCount: Object.keys(transitions).length,
      from: this.formatZones(previousZones),
      to: this.formatZones(currentZones),
      transitions: Object.entries(transitions).map(([type, data]) => 
        `${type}: ${data.type} ${data.zoneName}`
      )
    });

    return {
      playerUuid,
      previousZones,
      currentZones,
      transitions
    };
  }

  /**
   * 🔍 Détecte la transition pour UN type de zone spécifique
   */
  private detectSingleZoneTransition(
    zoneType: 'region' | 'node' | 'city',
    previousZoneId: number | null,
    currentZoneId: number | null,
    currentZoneName: string | null
  ): { type: 'enter' | 'leave'; zoneId: number; zoneName: string } | null {
    
    // Wilderness → Zone (ENTER)
    if (previousZoneId === null && currentZoneId !== null) {
      logger.debug(`📍 ${zoneType.toUpperCase()} ENTER`, {
        zoneId: currentZoneId,
        zoneName: currentZoneName
      });
      return {
        type: 'enter',
        zoneId: currentZoneId,
        zoneName: currentZoneName || `${this.capitalize(zoneType)} ${currentZoneId}`
      };
    }

    // Zone → Wilderness (LEAVE)
    if (previousZoneId !== null && currentZoneId === null) {
      logger.debug(`📍 ${zoneType.toUpperCase()} LEAVE`, {
        zoneId: previousZoneId
      });
      return {
        type: 'leave',
        zoneId: previousZoneId,
        zoneName: `${this.capitalize(zoneType)} ${previousZoneId}`
      };
    }

    // Zone A → Zone B (ENTER dans la nouvelle)
    if (previousZoneId !== null && currentZoneId !== null && previousZoneId !== currentZoneId) {
      logger.debug(`📍 ${zoneType.toUpperCase()} CHANGE`, {
        from: previousZoneId,
        to: currentZoneId
      });
      return {
        type: 'enter',
        zoneId: currentZoneId,
        zoneName: currentZoneName || `${this.capitalize(zoneType)} ${currentZoneId}`
      };
    }

    // Aucune transition
    return null;
  }

  // ========== MÉTHODES UTILITAIRES ==========

  /**
   * Vérifie si une position est dans le wilderness
   */
  private isWilderness(zones: ChunkZoneData | null): boolean {
    if (!zones) return true;
    return !zones.regionId && !zones.nodeId && !zones.cityId;
  }

  /**
   * Vérifie si deux ensembles de zones sont identiques
   */
  private areZonesIdentical(zones1: ChunkZoneData | null, zones2: ChunkZoneData | null): boolean {
    if (!zones1 && !zones2) return true;
    if (!zones1 || !zones2) return false;
    
    return zones1.regionId === zones2.regionId &&
           zones1.nodeId === zones2.nodeId &&
           zones1.cityId === zones2.cityId;
  }

  /**
   * Formate les zones pour l'affichage
   */
  private formatZones(zones: ChunkZoneData | null): string {
    if (!zones || this.isWilderness(zones)) {
      return 'wilderness';
    }
    
    const parts: string[] = [];
    if (zones.regionId) parts.push(`R${zones.regionId}`);
    if (zones.nodeId) parts.push(`N${zones.nodeId}`);
    if (zones.cityId) parts.push(`C${zones.cityId}`);
    
    return parts.length > 0 ? parts.join('→') : 'wilderness';
  }

  /**
   * Met en majuscule la première lettre
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Méthode publique pour formater les zones (utilisée par ZoneSyncService)
   */
  zonesToString(zones: ChunkZoneData | null): string {
    return this.formatZones(zones);
  }
}