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
   * 🎯 MÉTHODE PRINCIPALE : Détecte les transitions de zones
   * Version simplifiée et debuggée pour résoudre le problème "plus aucun message"
   */
  detectTransitions(
    playerUuid: string,
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null
  ): ZoneTransition | null {
    
    // 🔍 LOG INITIAL COMPLET
    logger.info('🔍 TRANSITION DETECTOR START', {
      playerUuid,
      input: {
        previous: this.safeFormatZones(previousZones),
        current: this.safeFormatZones(currentZones)
      },
      rawData: {
        previous: previousZones,
        current: currentZones
      }
    });

    // 🧪 ANALYSE PRÉLIMINAIRE
    const previousIsWilderness = this.isWilderness(previousZones);
    const currentIsWilderness = this.isWilderness(currentZones);
    const zonesAreIdentical = this.areZonesIdentical(previousZones, currentZones);

    logger.info('🧪 PRELIMINARY ANALYSIS', {
      playerUuid,
      analysis: {
        previousIsWilderness,
        currentIsWilderness,
        zonesAreIdentical,
        bothWilderness: previousIsWilderness && currentIsWilderness
      }
    });

    // ❌ FILTRE 1: Wilderness → Wilderness
    if (previousIsWilderness && currentIsWilderness) {
      logger.info('🚫 FILTER 1: Wilderness → Wilderness', { 
        playerUuid,
        reason: 'Both positions are in wilderness - no zones involved'
      });
      return null;
    }

    // ❌ FILTRE 2: Zones exactement identiques
    if (zonesAreIdentical) {
      logger.info('🚫 FILTER 2: Identical zones', { 
        playerUuid,
        zones: this.safeFormatZones(currentZones),
        reason: 'Player remains in exactly the same zones'
      });
      return null;
    }

    // ✅ IL Y A UNE DIFFÉRENCE → Analyser les transitions
    logger.info('✅ DIFFERENCE DETECTED - Analyzing individual zone transitions', {
      playerUuid,
      from: this.safeFormatZones(previousZones),
      to: this.safeFormatZones(currentZones)
    });

    const transitions: ZoneTransition['transitions'] = {};
    let transitionCount = 0;

    // 🔍 ANALYSER RÉGION
    const regionTransition = this.analyzeZoneTransition(
      'region',
      previousZones?.regionId || null,
      currentZones?.regionId || null,
      currentZones?.regionName || null
    );

    if (regionTransition) {
      transitions.region = regionTransition;
      transitionCount++;
      logger.info('✅ REGION TRANSITION', {
        playerUuid,
        transition: regionTransition,
        details: {
          from: previousZones?.regionId || 'null',
          to: currentZones?.regionId || 'null'
        }
      });
    } else {
      logger.debug('➖ No region transition', {
        playerUuid,
        from: previousZones?.regionId || 'null',
        to: currentZones?.regionId || 'null'
      });
    }

    // 🔍 ANALYSER NODE
    const nodeTransition = this.analyzeZoneTransition(
      'node',
      previousZones?.nodeId || null,
      currentZones?.nodeId || null,
      currentZones?.nodeName || null
    );

    if (nodeTransition) {
      transitions.node = nodeTransition;
      transitionCount++;
      logger.info('✅ NODE TRANSITION', {
        playerUuid,
        transition: nodeTransition,
        details: {
          from: previousZones?.nodeId || 'null',
          to: currentZones?.nodeId || 'null'
        }
      });
    } else {
      logger.debug('➖ No node transition', {
        playerUuid,
        from: previousZones?.nodeId || 'null',
        to: currentZones?.nodeId || 'null'
      });
    }

    // 🔍 ANALYSER VILLE
    const cityTransition = this.analyzeZoneTransition(
      'city',
      previousZones?.cityId || null,
      currentZones?.cityId || null,
      currentZones?.cityName || null
    );

    if (cityTransition) {
      transitions.city = cityTransition;
      transitionCount++;
      logger.info('✅ CITY TRANSITION', {
        playerUuid,
        transition: cityTransition,
        details: {
          from: previousZones?.cityId || 'null',
          to: currentZones?.cityId || 'null'
        }
      });
    } else {
      logger.debug('➖ No city transition', {
        playerUuid,
        from: previousZones?.cityId || 'null',
        to: currentZones?.cityId || 'null'
      });
    }

    // 📊 RÉSULTAT FINAL
    if (transitionCount === 0) {
      logger.info('🚫 FINAL RESULT: No transitions found', {
        playerUuid,
        reason: 'After analyzing all zone types, no transitions were detected',
        analyzed: {
          region: !!regionTransition,
          node: !!nodeTransition,
          city: !!cityTransition
        },
        note: 'This might indicate a logic issue if you expected a transition'
      });
      return null;
    }

    // ✅ TRANSITIONS TROUVÉES !
    logger.info('🎉 FINAL RESULT: TRANSITIONS DETECTED!', {
      playerUuid,
      transitionCount,
      summary: Object.entries(transitions).map(([type, data]) => 
        `${type}: ${data.type} → ${data.zoneName} (ID: ${data.zoneId})`
      ),
      from: this.safeFormatZones(previousZones),
      to: this.safeFormatZones(currentZones),
      willTriggerWebSocket: true
    });

    return {
      playerUuid,
      previousZones,
      currentZones,
      transitions
    };
  }

  /**
   * 🔍 Analyse la transition pour UN type de zone spécifique
   * Logic simplifiée et claire
   */
  private analyzeZoneTransition(
    zoneType: 'region' | 'node' | 'city',
    previousZoneId: number | null,
    currentZoneId: number | null,
    currentZoneName: string | null
  ): { type: 'enter' | 'leave'; zoneId: number; zoneName: string } | null {
    
    logger.debug(`🔍 Analyzing ${zoneType} transition`, {
      previous: previousZoneId,
      current: currentZoneId,
      currentName: currentZoneName
    });

    // Cas 1: null → zone (ENTER)
    if (previousZoneId === null && currentZoneId !== null) {
      const result = {
        type: 'enter' as const,
        zoneId: currentZoneId,
        zoneName: currentZoneName || `${this.capitalize(zoneType)} ${currentZoneId}`
      };
      logger.debug(`✅ ${zoneType.toUpperCase()} ENTER detected`, result);
      return result;
    }

    // Cas 2: zone → null (LEAVE)
    if (previousZoneId !== null && currentZoneId === null) {
      const result = {
        type: 'leave' as const,
        zoneId: previousZoneId,
        zoneName: `${this.capitalize(zoneType)} ${previousZoneId}`
      };
      logger.debug(`✅ ${zoneType.toUpperCase()} LEAVE detected`, result);
      return result;
    }

    // Cas 3: zone A → zone B (ENTER dans la nouvelle)
    if (previousZoneId !== null && currentZoneId !== null && previousZoneId !== currentZoneId) {
      const result = {
        type: 'enter' as const,
        zoneId: currentZoneId,
        zoneName: currentZoneName || `${this.capitalize(zoneType)} ${currentZoneId}`
      };
      logger.debug(`✅ ${zoneType.toUpperCase()} CHANGE detected (${previousZoneId} → ${currentZoneId})`, result);
      return result;
    }

    // Cas 4: Pas de changement
    logger.debug(`➖ No ${zoneType} change (${previousZoneId} → ${currentZoneId})`);
    return null;
  }

  // ========== MÉTHODES UTILITAIRES SÉCURISÉES ==========

  /**
   * Vérifie si une position est dans le wilderness (SÉCURISÉ)
   */
  private isWilderness(zones: ChunkZoneData | null): boolean {
    if (!zones) {
      return true;
    }

    // Une position est wilderness si elle n'a AUCUNE zone
    const hasAnyZone = (zones.regionId !== null && zones.regionId !== undefined) ||
                       (zones.nodeId !== null && zones.nodeId !== undefined) ||
                       (zones.cityId !== null && zones.cityId !== undefined);
    
    return !hasAnyZone;
  }

  /**
   * Vérifie si deux ensembles de zones sont identiques (SÉCURISÉ)
   */
  private areZonesIdentical(zones1: ChunkZoneData | null, zones2: ChunkZoneData | null): boolean {
    // Cas 1: Les deux sont null/undefined
    if (!zones1 && !zones2) {
      return true;
    }

    // Cas 2: Un seul est null/undefined
    if (!zones1 || !zones2) {
      return false;
    }

    // Cas 3: Comparaison détaillée des IDs
    const region1 = zones1.regionId || null;
    const region2 = zones2.regionId || null;
    const node1 = zones1.nodeId || null;
    const node2 = zones2.nodeId || null;
    const city1 = zones1.cityId || null;
    const city2 = zones2.cityId || null;

    const identical = region1 === region2 && node1 === node2 && city1 === city2;

    logger.debug('🔍 Zone comparison', {
      zones1: { region: region1, node: node1, city: city1 },
      zones2: { region: region2, node: node2, city: city2 },
      identical
    });

    return identical;
  }

  /**
   * Formate les zones de manière sécurisée pour l'affichage
   */
  private safeFormatZones(zones: ChunkZoneData | null): string {
    if (!zones) {
      return 'wilderness';
    }

    try {
      const parts: string[] = [];
      
      if (zones.regionId) {
        parts.push(`R${zones.regionId}${zones.regionName ? ` (${zones.regionName})` : ''}`);
      }
      
      if (zones.nodeId) {
        parts.push(`N${zones.nodeId}${zones.nodeName ? ` (${zones.nodeName})` : ''}`);
      }
      
      if (zones.cityId) {
        parts.push(`C${zones.cityId}${zones.cityName ? ` (${zones.cityName})` : ''}`);
      }
      
      return parts.length > 0 ? parts.join(' → ') : 'wilderness';
    } catch (error) {
      logger.warn('Error formatting zones', { zones, error });
      return 'format_error';
    }
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
    return this.safeFormatZones(zones);
  }

  // ========== MÉTHODES DE TEST ET DEBUG ==========

  /**
   * 🧪 Test rapide des transitions
   */
  testBasicTransitions(): void {
    logger.info('🧪 TESTING BASIC TRANSITIONS');

    const testCases = [
      {
        name: 'Wilderness → Wilderness',
        previous: null,
        current: null,
        expected: false
      },
      {
        name: 'Wilderness → Region 1',
        previous: null,
        current: { regionId: 1, regionName: 'Test Region', nodeId: null, nodeName: null, cityId: null, cityName: null },
        expected: true
      },
      {
        name: 'Region 1 → Wilderness',
        previous: { regionId: 1, regionName: 'Test Region', nodeId: null, nodeName: null, cityId: null, cityName: null },
        current: null,
        expected: true
      },
      {
        name: 'Same Region',
        previous: { regionId: 1, regionName: 'Test Region', nodeId: null, nodeName: null, cityId: null, cityName: null },
        current: { regionId: 1, regionName: 'Test Region', nodeId: null, nodeName: null, cityId: null, cityName: null },
        expected: false
      },
      {
        name: 'Region 1 → Region 2',
        previous: { regionId: 1, regionName: 'Region 1', nodeId: null, nodeName: null, cityId: null, cityName: null },
        current: { regionId: 2, regionName: 'Region 2', nodeId: null, nodeName: null, cityId: null, cityName: null },
        expected: true
      }
    ];

    testCases.forEach((testCase, index) => {
      const result = this.detectTransitions(`test_player_${index}`, testCase.previous, testCase.current);
      const hasTransition = !!result;
      const success = hasTransition === testCase.expected;

      logger.info(`${success ? '✅' : '❌'} TEST ${index + 1}: ${testCase.name}`, {
        expected: testCase.expected ? 'transition' : 'no transition',
        actual: hasTransition ? 'transition' : 'no transition',
        success,
        result: result ? {
          transitionsCount: Object.keys(result.transitions).length,
          transitions: result.transitions
        } : null
      });
    });

    logger.info('🧪 TEST COMPLETED');
  }

  /**
   * 🔍 Diagnostic d'une transition spécifique
   */
  diagnoseTransition(
    playerUuid: string,
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null
  ): {
    shouldHaveTransition: boolean;
    reason: string;
    details: any;
  } {
    const previousIsWilderness = this.isWilderness(previousZones);
    const currentIsWilderness = this.isWilderness(currentZones);
    const zonesAreIdentical = this.areZonesIdentical(previousZones, currentZones);

    if (previousIsWilderness && currentIsWilderness) {
      return {
        shouldHaveTransition: false,
        reason: 'Both positions are wilderness',
        details: { previousIsWilderness, currentIsWilderness }
      };
    }

    if (zonesAreIdentical) {
      return {
        shouldHaveTransition: false,
        reason: 'Zones are identical',
        details: { previousZones, currentZones, zonesAreIdentical }
      };
    }

    return {
      shouldHaveTransition: true,
      reason: 'Zones are different',
      details: {
        previous: this.safeFormatZones(previousZones),
        current: this.safeFormatZones(currentZones),
        regionChange: (previousZones?.regionId || null) !== (currentZones?.regionId || null),
        nodeChange: (previousZones?.nodeId || null) !== (currentZones?.nodeId || null),
        cityChange: (previousZones?.cityId || null) !== (currentZones?.cityId || null)
      }
    };
  }
}