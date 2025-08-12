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
   * Détecte les transitions de zones entre deux états
   * Retourne null s'il n'y a pas de transition significative
   */
  detectTransitions(
    playerUuid: string,
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null
  ): ZoneTransition | null {
    
    const transitions: ZoneTransition['transitions'] = {};
    let hasTransition = false;

    // 🔍 RÉGION : Détecter enter/leave
    const regionTransition = this.detectZoneTransition(
      previousZones?.regionId || null,
      currentZones?.regionId || null,
      currentZones?.regionName || null
    );
    if (regionTransition) {
      transitions.region = regionTransition;
      hasTransition = true;
    }

    // 🔍 NODE : Détecter enter/leave  
    const nodeTransition = this.detectZoneTransition(
      previousZones?.nodeId || null,
      currentZones?.nodeId || null,
      currentZones?.nodeName || null
    );
    if (nodeTransition) {
      transitions.node = nodeTransition;
      hasTransition = true;
    }

    // 🔍 VILLE : Détecter enter/leave
    const cityTransition = this.detectZoneTransition(
      previousZones?.cityId || null,
      currentZones?.cityId || null,
      currentZones?.cityName || null
    );
    if (cityTransition) {
      transitions.city = cityTransition;
      hasTransition = true;
    }

    // ✅ Retourner SEULEMENT si il y a une vraie transition
    if (!hasTransition) {
      return null;
    }

    logger.info('🎯 Zone transition detected', {
      playerUuid,
      previousZones: this.zonesToString(previousZones),
      currentZones: this.zonesToString(currentZones),
      transitions
    });

    return {
      playerUuid,
      previousZones,
      currentZones,
      transitions
    };
  }

  /**
   * Détecte la transition pour un type de zone spécifique
   */
  private detectZoneTransition(
    previousZoneId: number | null,
    currentZoneId: number | null,
    currentZoneName: string | null
  ): { type: 'enter' | 'leave'; zoneId: number; zoneName: string } | null {
    
    // Cas 1: Wilderness → Zone (ENTER)
    if (previousZoneId === null && currentZoneId !== null) {
      return {
        type: 'enter',
        zoneId: currentZoneId,
        zoneName: currentZoneName || `Zone ${currentZoneId}`
      };
    }

    // Cas 2: Zone → Wilderness (LEAVE)
    if (previousZoneId !== null && currentZoneId === null) {
      return {
        type: 'leave',
        zoneId: previousZoneId,
        zoneName: `Zone ${previousZoneId}` // On n'a plus le nom, approximation
      };
    }

    // Cas 3: Zone A → Zone B différente (LEAVE de A + ENTER de B sera géré séparément)
    if (previousZoneId !== null && currentZoneId !== null && previousZoneId !== currentZoneId) {
      // Cette méthode ne gère qu'une transition à la fois
      // Le caller appellera cette méthode deux fois pour gérer LEAVE puis ENTER
      return {
        type: 'enter',
        zoneId: currentZoneId,
        zoneName: currentZoneName || `Zone ${currentZoneId}`
      };
    }

    // Cas 4: Même zone ou wilderness → wilderness (PAS de transition)
    return null;
  }

  /**
   * Gère les transitions complexes Zone A → Zone B
   */
  detectComplexTransitions(
    playerUuid: string,
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null
  ): ZoneTransition[] {
    
    const transitions: ZoneTransition[] = [];

    // Pour chaque type de zone, gérer les transitions complexes
    const zoneTypes: Array<{
      type: 'region' | 'node' | 'city';
      prevId: number | null;
      currId: number | null;
      currName: string | null;
    }> = [
      {
        type: 'region',
        prevId: previousZones?.regionId || null,
        currId: currentZones?.regionId || null,
        currName: currentZones?.regionName || null
      },
      {
        type: 'node', 
        prevId: previousZones?.nodeId || null,
        currId: currentZones?.nodeId || null,
        currName: currentZones?.nodeName || null
      },
      {
        type: 'city',
        prevId: previousZones?.cityId || null,
        currId: currentZones?.cityId || null,
        currName: currentZones?.cityName || null
      }
    ];

    zoneTypes.forEach(({ type, prevId, currId, currName }) => {
      // Zone A → Zone B (différentes)
      if (prevId !== null && currId !== null && prevId !== currId) {
        
        // LEAVE de la zone précédente
        const leaveTransition: ZoneTransition = {
          playerUuid,
          previousZones,
          currentZones,
          transitions: {
            [type]: {
              type: 'leave',
              zoneId: prevId,
              zoneName: `Zone ${prevId}`
            }
          }
        };
        transitions.push(leaveTransition);

        // ENTER dans la nouvelle zone
        const enterTransition: ZoneTransition = {
          playerUuid,
          previousZones,
          currentZones,
          transitions: {
            [type]: {
              type: 'enter',
              zoneId: currId,
              zoneName: currName || `Zone ${currId}`
            }
          }
        };
        transitions.push(enterTransition);
      }
    });

    return transitions;
  }

  /**
   * Conversion zones en string pour logging
   */
  private zonesToString(zones: ChunkZoneData | null): string {
    if (!zones) return 'wilderness';
    
    const parts: string[] = [];
    if (zones.regionId) parts.push(`R${zones.regionId}`);
    if (zones.nodeId) parts.push(`N${zones.nodeId}`);
    if (zones.cityId) parts.push(`C${zones.cityId}`);
    
    return parts.length > 0 ? parts.join(' → ') : 'wilderness';
  }

  /**
   * Vérifie si deux zones sont identiques
   */
  private areZonesEqual(zones1: ChunkZoneData | null, zones2: ChunkZoneData | null): boolean {
    if (!zones1 && !zones2) return true;
    if (!zones1 || !zones2) return false;
    
    return zones1.regionId === zones2.regionId &&
           zones1.nodeId === zones2.nodeId &&
           zones1.cityId === zones2.cityId;
  }
}