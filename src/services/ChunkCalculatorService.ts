// src/services/ChunkCalculatorService.ts
import { logger } from '../utils/logger';

export interface Point {
 x: number;
 z: number;
}

export interface BoundingBox {
 minX: number;
 maxX: number;
 minZ: number;
 maxZ: number;
}

export interface Polygon extends Array<[number, number]> {}

export interface PolygonStats {
 pointCount: number;
 area: number;
 perimeter: number;
 bounds: BoundingBox;
 chunksCount: number;
 isValid: boolean;
}

export interface ValidationResult {
 valid: boolean;
 error?: string;
 warnings?: string[];
}

export class ChunkCalculatorService {
 private readonly MAX_POLYGON_POINTS = 1000;
 private readonly MAX_CHUNK_AREA = 10000; // 100x100 chunks max
 private readonly MIN_POLYGON_POINTS = 3;

 // Cache pour optimiser les calculs répétitifs
 private boundsCache = new Map<string, BoundingBox>();
 private polygonCache = new Map<string, Point[]>();

 // ========== ALGORITHME PRINCIPAL POINT-IN-POLYGON ==========
 
 /**
  * Détermine si un chunk est dans un polygone
  * Utilise l'algorithme Ray Casting optimisé
  */
 isChunkInPolygon(chunkX: number, chunkZ: number, polygon: Polygon): boolean {
   try {
     if (!this.isValidPolygonBasic(polygon)) {
       logger.debug('Invalid polygon for chunk test', { chunkX, chunkZ });
       return false;
     }

     return this.pointInPolygonRayCasting(chunkX, chunkZ, polygon);
     
   } catch (error) {
     logger.error('Error in chunk-in-polygon test', {
       chunkX, chunkZ,
       polygonPoints: polygon.length,
       error: error instanceof Error ? error.message : 'Unknown error'
     });
     return false;
   }
 }

 /**
  * Algorithme Ray Casting optimisé
  * Complexité: O(n) où n = nombre de points du polygone
  */
 private pointInPolygonRayCasting(x: number, z: number, polygon: Polygon): boolean {
   let inside = false;
   const numPoints = polygon.length;

   for (let i = 0, j = numPoints - 1; i < numPoints; j = i++) {
     const [xi, zi] = polygon[i];
     const [xj, zj] = polygon[j];

     // Vérifier si le point est exactement sur un sommet
     if (xi === x && zi === z) {
       return true;
     }

     // Test d'intersection avec le rayon horizontal
     if (((zi > z) !== (zj > z)) && 
         (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
       inside = !inside;
     }
   }

   return inside;
 }

 // ========== CALCUL DES CHUNKS DANS UN POLYGONE ==========
 
 /**
  * Récupère tous les chunks contenus dans un polygone
  * Méthode optimisée avec bounding box
  */
 getChunksInPolygon(polygon: Polygon): Point[] {
   try {
     const validation = this.validatePolygon(polygon);
     if (!validation.valid) {
       logger.warn('Invalid polygon for chunk calculation', { 
         error: validation.error,
         warnings: validation.warnings
       });
       return [];
     }

     return this.getChunksInPolygonOptimized(polygon);
     
   } catch (error) {
     logger.error('Error calculating chunks in polygon', {
       polygonPoints: polygon.length,
       error: error instanceof Error ? error.message : 'Unknown error'
     });
     return [];
   }
 }

 /**
  * Version optimisée avec cache et bounding box
  */
// src/services/ChunkCalculatorService.ts - REMPLACER les lignes concernées

// Ligne 170-180 environ - Méthode getChunksInPolygonOptimized
private getChunksInPolygonOptimized(polygon: Polygon): Point[] {
  const polygonKey = this.getPolygonCacheKey(polygon);
  
  // Vérifier le cache
  if (this.polygonCache.has(polygonKey)) {
    const cached = this.polygonCache.get(polygonKey)!;
    logger.debug('Using cached chunk calculation', { 
      polygonKey: polygonKey.substring(0, 16) + '...',
      chunks: cached.length 
    });
    return cached;
  }

  const startTime = Date.now();
  const bounds = this.getPolygonBounds(polygon);
  const chunks: Point[] = [];

  // Optimisation: vérifier d'abord si la bounding box n'est pas trop grande
  const areaEstimate = (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1);
  if (areaEstimate > this.MAX_CHUNK_AREA) {
    logger.warn('Polygon area too large, may cause performance issues', {
      estimatedChunks: areaEstimate,
      maxAllowed: this.MAX_CHUNK_AREA,
      bounds
    });
  }

  // Parcourir la bounding box et tester chaque point
  let testedPoints = 0;
  let chunksFound = 0;

  for (let x = bounds.minX; x <= bounds.maxX; x++) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
      testedPoints++;
      
      if (this.pointInPolygonRayCasting(x, z, polygon)) {
        chunks.push({ x, z });
        chunksFound++;
      }
    }
  }

  const duration = Date.now() - startTime;

  // Mettre en cache si le calcul a pris du temps
  if (duration > 10 || chunks.length > 100) {
    this.polygonCache.set(polygonKey, chunks);
    
    // ✅ FIX: Limiter la taille du cache avec vérification null
    if (this.polygonCache.size > 100) {
      const firstKey = this.polygonCache.keys().next().value;
      if (firstKey !== undefined) {
        this.polygonCache.delete(firstKey);
      }
    }
  }

  logger.debug('Chunks calculation completed', {
    polygonPoints: polygon.length,
    testedPoints,
    chunksFound,
    durationMs: duration,
    efficiency: Math.round((chunksFound / testedPoints) * 100) + '%'
  });

  return chunks;
}

// Ligne 270-285 environ - Méthode getPolygonBounds
getPolygonBounds(polygon: Polygon): BoundingBox {
  const polygonKey = this.getPolygonCacheKey(polygon);
  
  if (this.boundsCache.has(polygonKey)) {
    return this.boundsCache.get(polygonKey)!;
  }

  if (polygon.length === 0) {
    return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  }

  let minX = polygon[0][0];
  let maxX = polygon[0][0];
  let minZ = polygon[0][1];
  let maxZ = polygon[0][1];

  for (let i = 1; i < polygon.length; i++) {
    const [x, z] = polygon[i];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  const bounds = {
    minX: Math.floor(minX),
    maxX: Math.ceil(maxX),
    minZ: Math.floor(minZ),
    maxZ: Math.ceil(maxZ)
  };

  // Cache les bounds
  this.boundsCache.set(polygonKey, bounds);
  
  // ✅ FIX: Limiter la taille du cache avec vérification null
  if (this.boundsCache.size > 100) {
    const firstKey = this.boundsCache.keys().next().value;
    if (firstKey !== undefined) {
      this.boundsCache.delete(firstKey);
    }
  }

  return bounds;
}

 /**
  * Calcule l'aire d'un polygone (algorithme du lacet)
  */
 calculatePolygonArea(polygon: Polygon): number {
   if (polygon.length < 3) return 0;

   let area = 0;
   const numPoints = polygon.length;

   for (let i = 0; i < numPoints; i++) {
     const j = (i + 1) % numPoints;
     const [xi, zi] = polygon[i];
     const [xj, zj] = polygon[j];
     
     area += xi * zj;
     area -= xj * zi;
   }

   return Math.abs(area) / 2;
 }

 /**
  * Calcule le périmètre d'un polygone
  */
 calculatePolygonPerimeter(polygon: Polygon): number {
   if (polygon.length < 2) return 0;

   let perimeter = 0;
   const numPoints = polygon.length;

   for (let i = 0; i < numPoints; i++) {
     const j = (i + 1) % numPoints;
     const [xi, zi] = polygon[i];
     const [xj, zj] = polygon[j];
     
     const dx = xj - xi;
     const dz = zj - zi;
     perimeter += Math.sqrt(dx * dx + dz * dz);
   }

   return perimeter;
 }

 // ========== VALIDATION ==========
 
 /**
  * Validation complète d'un polygone
  */
 validatePolygon(polygon: Polygon): ValidationResult {
   const result: ValidationResult = { valid: true, warnings: [] };

   try {
     // Vérifications de base
     if (!Array.isArray(polygon)) {
       return { valid: false, error: 'Polygon must be an array' };
     }

     if (polygon.length < this.MIN_POLYGON_POINTS) {
       return { 
         valid: false, 
         error: `Polygon must have at least ${this.MIN_POLYGON_POINTS} points` 
       };
     }

     if (polygon.length > this.MAX_POLYGON_POINTS) {
       return { 
         valid: false, 
         error: `Polygon cannot have more than ${this.MAX_POLYGON_POINTS} points` 
       };
     }

     // Vérifier chaque point
     for (let i = 0; i < polygon.length; i++) {
       const point = polygon[i];
       
       if (!Array.isArray(point) || point.length !== 2) {
         return { 
           valid: false, 
           error: `Point ${i} must be [x, z] array` 
         };
       }

       const [x, z] = point;
       
       if (!Number.isFinite(x) || !Number.isFinite(z)) {
         return { 
           valid: false, 
           error: `Point ${i} coordinates must be finite numbers` 
         };
       }

       if (!Number.isInteger(x) || !Number.isInteger(z)) {
         result.warnings!.push(`Point ${i} has non-integer coordinates`);
       }

       // Vérifier les limites raisonnables
       if (Math.abs(x) > 1000000 || Math.abs(z) > 1000000) {
         result.warnings!.push(`Point ${i} has very large coordinates`);
       }
     }

     // Vérifier les points dupliqués
     const duplicates = this.findDuplicatePoints(polygon);
     if (duplicates.length > 0) {
       result.warnings!.push(`Duplicate points found at indices: ${duplicates.join(', ')}`);
     }

     // Vérifier si le polygone est fermé
     const firstPoint = polygon[0];
     const lastPoint = polygon[polygon.length - 1];
     if (firstPoint[0] === lastPoint[0] && firstPoint[1] === lastPoint[1]) {
       result.warnings!.push('Polygon appears to be explicitly closed (first point = last point)');
     }

     // Calculer l'aire pour vérifier la validité géométrique
     const area = this.calculatePolygonArea(polygon);
     if (area < 1) {
       return { 
         valid: false, 
         error: 'Polygon area is too small (degenerate polygon)' 
       };
     }

     // Vérifier si le polygone s'auto-intersecte (basique)
     if (this.hasBasicSelfIntersection(polygon)) {
       result.warnings!.push('Polygon may have self-intersections');
     }

     // Estimation de performance
     const bounds = this.getPolygonBounds(polygon);
     const estimatedChunks = (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1);
     
     if (estimatedChunks > this.MAX_CHUNK_AREA) {
       result.warnings!.push(`Large polygon may impact performance (estimated ${estimatedChunks} chunks to test)`);
     }

     return result;

   } catch (error) {
     return { 
       valid: false, 
       error: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}` 
     };
   }
 }

 /**
  * Validation rapide pour les opérations courantes
  */
 private isValidPolygonBasic(polygon: Polygon): boolean {
   return Array.isArray(polygon) && 
          polygon.length >= this.MIN_POLYGON_POINTS &&
          polygon.length <= this.MAX_POLYGON_POINTS &&
          polygon.every(point => 
            Array.isArray(point) && 
            point.length === 2 && 
            Number.isFinite(point[0]) && 
            Number.isFinite(point[1])
          );
 }

 /**
  * Trouve les points dupliqués dans un polygone
  */
 private findDuplicatePoints(polygon: Polygon): number[] {
   const duplicates: number[] = [];
   const seen = new Set<string>();

   for (let i = 0; i < polygon.length; i++) {
     const [x, z] = polygon[i];
     const key = `${x},${z}`;
     
     if (seen.has(key)) {
       duplicates.push(i);
     } else {
       seen.add(key);
     }
   }

   return duplicates;
 }

 /**
  * Détection basique d'auto-intersection
  */
 private hasBasicSelfIntersection(polygon: Polygon): boolean {
   // Vérification simplifiée: polygone très petit ou lignes qui se croisent de manière évidente
   if (polygon.length < 4) return false;

   // Pour des polygones simples, vérifier juste les segments adjacents non consécutifs
   for (let i = 0; i < polygon.length - 2; i++) {
     for (let j = i + 2; j < polygon.length; j++) {
       // Éviter de comparer le dernier segment avec le premier (connexion normale)
       if (i === 0 && j === polygon.length - 1) continue;
       
       const seg1 = [polygon[i], polygon[i + 1]];
       const seg2 = [polygon[j], polygon[(j + 1) % polygon.length]];
       
       if (this.segmentsIntersect(seg1[0], seg1[1], seg2[0], seg2[1])) {
         return true;
       }
     }
   }

   return false;
 }

 /**
  * Teste si deux segments de ligne s'intersectent
  */
 private segmentsIntersect(
   p1: [number, number], 
   q1: [number, number], 
   p2: [number, number], 
   q2: [number, number]
 ): boolean {
   const orientation = (p: [number, number], q: [number, number], r: [number, number]): number => {
     const val = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
     if (val === 0) return 0; // colinéaire
     return val > 0 ? 1 : 2; // horaire ou anti-horaire
   };

   const onSegment = (p: [number, number], q: [number, number], r: [number, number]): boolean => {
     return q[0] <= Math.max(p[0], r[0]) && q[0] >= Math.min(p[0], r[0]) &&
            q[1] <= Math.max(p[1], r[1]) && q[1] >= Math.min(p[1], r[1]);
   };

   const o1 = orientation(p1, q1, p2);
   const o2 = orientation(p1, q1, q2);
   const o3 = orientation(p2, q2, p1);
   const o4 = orientation(p2, q2, q1);

   // Cas général
   if (o1 !== o2 && o3 !== o4) return true;

   // Cas spéciaux (points colinéaires)
   if (o1 === 0 && onSegment(p1, p2, q1)) return true;
   if (o2 === 0 && onSegment(p1, q2, q1)) return true;
   if (o3 === 0 && onSegment(p2, p1, q2)) return true;
   if (o4 === 0 && onSegment(p2, q1, q2)) return true;

   return false;
 }

 // ========== CRÉATION DE POLYGONES ==========
 
 /**
  * Crée un polygone rectangulaire
  */
 createRectanglePolygon(minX: number, minZ: number, maxX: number, maxZ: number): Polygon {
   if (minX >= maxX || minZ >= maxZ) {
     throw new Error('Invalid rectangle coordinates: min values must be less than max values');
   }

   return [
     [minX, minZ],
     [maxX, minZ],
     [maxX, maxZ],
     [minX, maxZ]
   ];
 }

 /**
  * Crée un polygone circulaire approximé
  */
 createCirclePolygon(centerX: number, centerZ: number, radius: number, segments: number = 32): Polygon {
   if (radius <= 0) {
     throw new Error('Radius must be positive');
   }

   if (segments < 3) {
     throw new Error('Circle must have at least 3 segments');
   }

   if (segments > 100) {
     throw new Error('Too many segments (max 100)');
   }

   const polygon: Polygon = [];
   
   for (let i = 0; i < segments; i++) {
     const angle = (2 * Math.PI * i) / segments;
     const x = Math.round(centerX + radius * Math.cos(angle));
     const z = Math.round(centerZ + radius * Math.sin(angle));
     polygon.push([x, z]);
   }

   return polygon;
 }

 /**
  * Crée un polygone en forme de losange
  */
 createDiamondPolygon(centerX: number, centerZ: number, radius: number): Polygon {
   if (radius <= 0) {
     throw new Error('Radius must be positive');
   }

   return [
     [centerX, centerZ - radius],      // Nord
     [centerX + radius, centerZ],      // Est
     [centerX, centerZ + radius],      // Sud
     [centerX - radius, centerZ]       // Ouest
   ];
 }

 // ========== STATISTIQUES ET DIAGNOSTICS ==========
 
 /**
  * Obtient des statistiques détaillées sur un polygone
  */
 getPolygonStats(polygon: Polygon): PolygonStats {
   try {
     const validation = this.validatePolygon(polygon);
     const bounds = this.getPolygonBounds(polygon);
     const area = this.calculatePolygonArea(polygon);
     const perimeter = this.calculatePolygonPerimeter(polygon);
     
     let chunksCount = 0;
     try {
       // Calcul sécurisé du nombre de chunks
       const estimatedChunks = (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1);
       if (estimatedChunks <= this.MAX_CHUNK_AREA) {
         chunksCount = this.getChunksInPolygon(polygon).length;
       } else {
         chunksCount = -1; // Trop grand pour calculer
       }
     } catch (error) {
       chunksCount = -1;
     }

     return {
       pointCount: polygon.length,
       area,
       perimeter,
       bounds,
       chunksCount,
       isValid: validation.valid
     };

   } catch (error) {
     logger.error('Error calculating polygon stats', {
       error: error instanceof Error ? error.message : 'Unknown error'
     });
     
     return {
       pointCount: polygon.length,
       area: 0,
       perimeter: 0,
       bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
       chunksCount: 0,
       isValid: false
     };
   }
 }

 /**
  * Diagnostic de performance pour un polygone
  */
 performanceAnalysis(polygon: Polygon): {
   complexity: 'low' | 'medium' | 'high' | 'extreme';
   estimatedProcessingTime: number;
   recommendations: string[];
 } {
   const stats = this.getPolygonStats(polygon);
   const estimatedChunks = (stats.bounds.maxX - stats.bounds.minX + 1) * 
                          (stats.bounds.maxZ - stats.bounds.minZ + 1);
   
   let complexity: 'low' | 'medium' | 'high' | 'extreme';
   let estimatedTime: number;
   const recommendations: string[] = [];

   if (estimatedChunks <= 100) {
     complexity = 'low';
     estimatedTime = 1;
   } else if (estimatedChunks <= 1000) {
     complexity = 'medium';
     estimatedTime = 10;
   } else if (estimatedChunks <= 10000) {
     complexity = 'high';
     estimatedTime = 100;
     recommendations.push('Consider using batched processing for better performance');
   } else {
     complexity = 'extreme';
     estimatedTime = 1000;
     recommendations.push('Polygon is very large, consider splitting into smaller zones');
     recommendations.push('Use batched processing to avoid blocking operations');
   }

   if (polygon.length > 50) {
     recommendations.push('High polygon complexity may impact performance');
   }

   if (!stats.isValid) {
     recommendations.push('Polygon validation failed, check for errors');
   }

   return {
     complexity,
     estimatedProcessingTime: estimatedTime,
     recommendations
   };
 }

 // ========== UTILITAIRES DE CACHE ==========
 
 /**
  * Génère une clé de cache pour un polygone
  */
 private getPolygonCacheKey(polygon: Polygon): string {
   // Créer un hash simple basé sur les points du polygone
   const points = polygon.map(([x, z]) => `${x},${z}`).join('|');
   return this.simpleHash(points);
 }

 /**
  * Hash simple pour les clés de cache
  */
 private simpleHash(str: string): string {
   let hash = 0;
   for (let i = 0; i < str.length; i++) {
     const char = str.charCodeAt(i);
     hash = ((hash << 5) - hash) + char;
     hash = hash & hash; // Convert to 32-bit integer
   }
   return hash.toString(36);
 }

 /**
  * Vide les caches (utile pour les tests ou après modification de zones)
  */
 clearCache(): void {
   const boundsSize = this.boundsCache.size;
   const polygonSize = this.polygonCache.size;
   
   this.boundsCache.clear();
   this.polygonCache.clear();
   
   logger.info('ChunkCalculator cache cleared', {
     boundsCleared: boundsSize,
     polygonCleared: polygonSize
   });
 }

 /**
  * Statistiques du cache
  */
 getCacheStats(): {
   boundsCache: number;
   polygonCache: number;
   totalMemoryEstimate: string;
 } {
   // Estimation approximative de la mémoire utilisée
   const avgBoundsSize = 64; // bytes per bounds object
   const avgPolygonSize = 32; // bytes per point
   const avgPointsPerPolygon = 100;
   
   const boundsMemory = this.boundsCache.size * avgBoundsSize;
   const polygonMemory = this.polygonCache.size * avgPolygonSize * avgPointsPerPolygon;
   const totalMemory = boundsMemory + polygonMemory;
   
   let memoryStr: string;
   if (totalMemory < 1024) {
     memoryStr = `${totalMemory}B`;
   } else if (totalMemory < 1024 * 1024) {
     memoryStr = `${Math.round(totalMemory / 1024)}KB`;
   } else {
     memoryStr = `${Math.round(totalMemory / (1024 * 1024))}MB`;
   }

   return {
     boundsCache: this.boundsCache.size,
     polygonCache: this.polygonCache.size,
     totalMemoryEstimate: memoryStr
   };
 }
}