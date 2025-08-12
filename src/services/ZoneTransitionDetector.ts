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
   * 🎯 MÉTHODE PRINCIPALE : Détecte VRAIMENT les transitions de zones
   * Version ultra-simplifiée qui se concentre sur l'essentiel
   */
  detectTransitions(
    playerUuid: string,
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null
  ): ZoneTransition | null {
    
    // 🔍 LOG INITIAL ULTRA-DÉTAILLÉ
    logger.info('🎯 TRANSITION DETECTOR - ULTRA DEBUG', {
      playerUuid,
      input: {
        previous: {
          raw: previousZones,
          formatted: this.formatZones(previousZones),
          isWilderness: this.isWilderness(previousZones)
        },
        current: {
          raw: currentZones,
          formatted: this.formatZones(currentZones),
          isWilderness: this.isWilderness(currentZones)
        }
      }
    });

    // 🚨 NOUVEAU : Comparer zone par zone MANUELLEMENT
    const changes = this.detectDetailedChanges(previousZones, currentZones);
    
    logger.info('🔍 DETAILED ZONE CHANGES', {
      playerUuid,
      changes,
      hasAnyChange: changes.region.hasChange || changes.node.hasChange || changes.city.hasChange
    });

    // ❌ FILTRE PRINCIPAL : Aucun changement détecté
    if (!changes.region.hasChange && !changes.node.hasChange && !changes.city.hasChange) {
      logger.info('🚫 NO CHANGES DETECTED', {
        playerUuid,
        reason: 'All zones remain the same',
        details: changes
      });
      return null;
    }

    // ✅ DES CHANGEMENTS DÉTECTÉS → Générer les transitions
    logger.info('✅ ZONE CHANGES DETECTED - Generating transitions', {
      playerUuid,
      changesDetected: {
        region: changes.region.hasChange,
        node: changes.node.hasChange,
        city: changes.city.hasChange
      }
    });

    const transitions: ZoneTransition['transitions'] = {};
    let transitionCount = 0;

    // 🎯 RÉGION : Générer les transitions
    if (changes.region.hasChange) {
      const regionTransitions = this.generateTransitionsForZone(
        'region',
        changes.region.previous,
        changes.region.current,
        currentZones?.regionName || null
      );
      
      regionTransitions.forEach(transition => {
        if (transition.type === 'enter') {
          transitions.region = transition;
          transitionCount++;
          logger.info('✅ REGION TRANSITION GENERATED', {
            playerUuid,
            transition
          });
        }
      });
    }

    // 🎯 NODE : Générer les transitions
    if (changes.node.hasChange) {
      const nodeTransitions = this.generateTransitionsForZone(
        'node',
        changes.node.previous,
        changes.node.current,
        currentZones?.nodeName || null
      );
      
      nodeTransitions.forEach(transition => {
        if (transition.type === 'enter') {
          transitions.node = transition;
          transitionCount++;
          logger.info('✅ NODE TRANSITION GENERATED', {
            playerUuid,
            transition
          });
        }
      });
    }

    // 🎯 VILLE : Générer les transitions
    if (changes.city.hasChange) {
      const cityTransitions = this.generateTransitionsForZone(
        'city',
        changes.city.previous,
        changes.city.current,
        currentZones?.cityName || null
      );
      
      cityTransitions.forEach(transition => {
        if (transition.type === 'enter') {
          transitions.city = transition;
          transitionCount++;
          logger.info('✅ CITY TRANSITION GENERATED', {
            playerUuid,
            transition
          });
        }
      });
    }

    // 📊 RÉSULTAT FINAL
    if (transitionCount === 0) {
      logger.warn('⚠️ WEIRD: Changes detected but no transitions generated', {
        playerUuid,
        changes,
        note: 'This might indicate a logic issue'
      });
      return null;
    }

    // 🎉 TRANSITIONS CONFIRMÉES
    logger.info('🎉 TRANSITIONS READY FOR WEBSOCKET', {
      playerUuid,
      transitionCount,
      transitions,
      summary: Object.entries(transitions).map(([type, data]) => 
        `${type}: ${data.type} → ${data.zoneName} (ID: ${data.zoneId})`
      ),
      willBroadcast: true
    });

    return {
      playerUuid,
      previousZones,
      currentZones,
      transitions
    };
  }

  /**
   * 🔍 NOUVELLE MÉTHODE : Détecte les changements détaillés zone par zone
   */
  private detectDetailedChanges(
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null
  ): {
    region: { hasChange: boolean; previous: number | null; current: number | null };
    node: { hasChange: boolean; previous: number | null; current: number | null };
    city: { hasChange: boolean; previous: number | null; current: number | null };
  } {
    
    const previousRegion = previousZones?.regionId || null;
    const currentRegion = currentZones?.regionId || null;
    const previousNode = previousZones?.nodeId || null;
    const currentNode = currentZones?.nodeId || null;
    const previousCity = previousZones?.cityId || null;
    const currentCity = currentZones?.cityId || null;

    const changes = {
      region: {
        hasChange: previousRegion !== currentRegion,
        previous: previousRegion,
        current: currentRegion
      },
      node: {
        hasChange: previousNode !== currentNode,
        previous: previousNode,
        current: currentNode
      },
      city: {
        hasChange: previousCity !== currentCity,
        previous: previousCity,
        current: currentCity
      }
    };

    logger.debug('🧪 CHANGE ANALYSIS', {
      region: `${previousRegion} → ${currentRegion} (${changes.region.hasChange ? 'CHANGED' : 'SAME'})`,
      node: `${previousNode} → ${currentNode} (${changes.node.hasChange ? 'CHANGED' : 'SAME'})`,
      city: `${previousCity} → ${currentCity} (${changes.city.hasChange ? 'CHANGED' : 'SAME'})`
    });

    return changes;
  }

  /**
   * 🎯 NOUVELLE MÉTHODE : Génère les transitions pour un type de zone
   */
  private generateTransitionsForZone(
    zoneType: 'region' | 'node' | 'city',
    previousId: number | null,
    currentId: number | null,
    currentName: string | null
  ): Array<{ type: 'enter' | 'leave'; zoneId: number; zoneName: string }> {
    
    const transitions: Array<{ type: 'enter' | 'leave'; zoneId: number; zoneName: string }> = [];

    logger.debug(`🎯 Generating ${zoneType} transitions`, {
      previous: previousId,
      current: currentId,
      currentName
    });

    // Cas 1: null → zone (ENTER)
    if (previousId === null && currentId !== null) {
      const enterTransition = {
        type: 'enter' as const,
        zoneId: currentId,
        zoneName: currentName || `${this.capitalize(zoneType)} ${currentId}`
      };
      transitions.push(enterTransition);
      logger.debug(`✅ ${zoneType.toUpperCase()} ENTER: null → ${currentId}`, enterTransition);
    }

    // Cas 2: zone → null (LEAVE)
    else if (previousId !== null && currentId === null) {
      const leaveTransition = {
        type: 'leave' as const,
        zoneId: previousId,
        zoneName: `${this.capitalize(zoneType)} ${previousId}`
      };
      transitions.push(leaveTransition);
      logger.debug(`✅ ${zoneType.toUpperCase()} LEAVE: ${previousId} → null`, leaveTransition);
    }

    // Cas 3: zone A → zone B (ENTER dans la nouvelle, le LEAVE sera géré séparément)
    else if (previousId !== null && currentId !== null && previousId !== currentId) {
      const enterTransition = {
        type: 'enter' as const,
        zoneId: currentId,
        zoneName: currentName || `${this.capitalize(zoneType)} ${currentId}`
      };
      transitions.push(enterTransition);
      logger.debug(`✅ ${zoneType.toUpperCase()} CHANGE: ${previousId} → ${currentId}`, enterTransition);
    }

    // Cas 4: Même zone (ne devrait pas arriver car detectDetailedChanges filtre)
    else {
      logger.debug(`➖ ${zoneType.toUpperCase()}: No transition needed (${previousId} → ${currentId})`);
    }

    return transitions;
  }

  // ========== MÉTHODES UTILITAIRES SIMPLIFIÉES ==========

  /**
   * Vérifie si une position est dans le wilderness
   */
  private isWilderness(zones: ChunkZoneData | null): boolean {
    if (!zones) return true;
    
    return !zones.regionId && !zones.nodeId && !zones.cityId;
  }

  /**
   * Formate les zones pour l'affichage
   */
  private formatZones(zones: ChunkZoneData | null): string {
    if (!zones || this.isWilderness(zones)) {
      return 'wilderness';
    }
    
    const parts: string[] = [];
    if (zones.regionId) parts.push(`R${zones.regionId}${zones.regionName ? ` (${zones.regionName})` : ''}`);
    if (zones.nodeId) parts.push(`N${zones.nodeId}${zones.nodeName ? ` (${zones.nodeName})` : ''}`);
    if (zones.cityId) parts.push(`C${zones.cityId}${zones.cityName ? ` (${zones.cityName})` : ''}`);
    
    return parts.length > 0 ? parts.join(' → ') : 'wilderness';
  }

  /**
   * Met en majuscule la première lettre
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Méthode publique pour formater les zones
   */
  zonesToString(zones: ChunkZoneData | null): string {
    return this.formatZones(zones);
  }

  // ========== MÉTHODES DE TEST SIMPLIFIÉES ==========

  /**
   * 🧪 Test simple et direct
   */
  testSimpleTransitions(): void {
    logger.info('🧪 TESTING SIMPLE TRANSITIONS');

    // Test 1: Wilderness → Region
    logger.info('🧪 TEST 1: Wilderness → Region');
    const test1 = this.detectTransitions(
      'test1',
      null,
      { regionId: 1, regionName: 'Test Region', nodeId: null, nodeName: null, cityId: null, cityName: null }
    );
    logger.info(`TEST 1 RESULT: ${test1 ? 'TRANSITION DETECTED ✅' : 'NO TRANSITION ❌'}`, { result: test1 });

    // Test 2: Region → Wilderness
    logger.info('🧪 TEST 2: Region → Wilderness');
    const test2 = this.detectTransitions(
      'test2',
      { regionId: 1, regionName: 'Test Region', nodeId: null, nodeName: null, cityId: null, cityName: null },
      null
    );
    logger.info(`TEST 2 RESULT: ${test2 ? 'TRANSITION DETECTED ✅' : 'NO TRANSITION ❌'}`, { result: test2 });

    // Test 3: Same region (should be no transition)
    logger.info('🧪 TEST 3: Same Region');
    const test3 = this.detectTransitions(
      'test3',
      { regionId: 1, regionName: 'Test Region', nodeId: null, nodeName: null, cityId: null, cityName: null },
      { regionId: 1, regionName: 'Test Region', nodeId: null, nodeName: null, cityId: null, cityName: null }
    );
    logger.info(`TEST 3 RESULT: ${test3 ? 'TRANSITION DETECTED ❌' : 'NO TRANSITION ✅'}`, { result: test3 });

    // Test 4: Region A → Region B
    logger.info('🧪 TEST 4: Region A → Region B');
    const test4 = this.detectTransitions(
      'test4',
      { regionId: 1, regionName: 'Region A', nodeId: null, nodeName: null, cityId: null, cityName: null },
      { regionId: 2, regionName: 'Region B', nodeId: null, nodeName: null, cityId: null, cityName: null }
    );
    logger.info(`TEST 4 RESULT: ${test4 ? 'TRANSITION DETECTED ✅' : 'NO TRANSITION ❌'}`, { result: test4 });

    logger.info('🧪 SIMPLE TESTS COMPLETED');
  }

  /**
   * 🔍 Diagnostic direct d'une transition
   */
  diagnose(
    playerUuid: string,
    previousZones: ChunkZoneData | null,
    currentZones: ChunkZoneData | null
  ): void {
    logger.info('🔍 DIAGNOSTIC MODE', { playerUuid });
    
    const changes = this.detectDetailedChanges(previousZones, currentZones);
    
    logger.info('🔍 DIAGNOSTIC RESULT', {
      playerUuid,
      previous: this.formatZones(previousZones),
      current: this.formatZones(currentZones),
      changes,
      shouldHaveTransition: changes.region.hasChange || changes.node.hasChange || changes.city.hasChange,
      recommendation: changes.region.hasChange || changes.node.hasChange || changes.city.hasChange 
        ? 'SHOULD generate transition events'
        : 'Should NOT generate transition events'
    });
  }
}