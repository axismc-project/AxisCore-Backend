import { Region, Node, City, ChunkZoneData, ChunkCoordinate, Polygon } from '../models/Zone';
import { logger } from '../utils/logger';

interface Point {
  x: number;
  z: number;
}

interface BoundingBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class ChunkCalculatorService {

  // ========== CALCUL PRINCIPAL ==========
  calculateChunkZones(
    chunkX: number, 
    chunkZ: number, 
    regions: Region[], 
    nodes: Node[], 
    cities: City[]
  ): ChunkZoneData {
    const result: ChunkZoneData = {
      regionId: null,
      regionName: null,
      nodeId: null,
      nodeName: null,
      cityId: null,
      cityName: null
    };

    try {
      // 1. Trouver région contenant ce chunk
      for (const region of regions) {
        if (this.isChunkInPolygon(chunkX, chunkZ, region.chunk_boundary)) {
          result.regionId = region.id;
          result.regionName = region.name;
          break;
        }
      }

      // 2. Si dans une région, chercher node
      if (result.regionId) {
        for (const node of nodes) {
          if (node.region_id === result.regionId && 
              this.isChunkInPolygon(chunkX, chunkZ, node.chunk_boundary)) {
            result.nodeId = node.id;
            result.nodeName = node.name;
            break;
          }
        }
      }

      // 3. Si dans un node, chercher ville
      if (result.nodeId) {
        for (const city of cities) {
          if (city.node_id === result.nodeId && 
              this.isChunkInPolygon(chunkX, chunkZ, city.chunk_boundary)) {
            result.cityId = city.id;
            result.cityName = city.name;
            break;
          }
        }
      }

      return result;
    } catch (error) {
      logger.error(`Erreur calculateChunkZones (${chunkX}, ${chunkZ}):`, error);
      return result;
    }
  }

  // ========== ALGORITHMES GÉOMÉTRIQUES ==========
  isChunkInPolygon(chunkX: number, chunkZ: number, polygon: Polygon): boolean {
    try {
      return this.isPointInPolygon(chunkX, chunkZ, polygon);
    } catch (error) {
      logger.error(`Erreur isChunkInPolygon (${chunkX}, ${chunkZ}):`, error);
      return false;
    }
  }

  private isPointInPolygon(x: number, z: number, polygon: Polygon): boolean {
    let inside = false;
    const numPoints = polygon.length;

    for (let i = 0, j = numPoints - 1; i < numPoints; j = i++) {
      const pointI = polygon[i];
      const pointJ = polygon[j];
      
      if (!pointI || !pointJ) continue;
      
      const xi = pointI[0];
      const zi = pointI[1];
      const xj = pointJ[0];
      const zj = pointJ[1];

      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
        inside = !inside;
      }
    }

    return inside;
  }

  // ========== UTILITAIRES POLYGONES ==========
  getChunksInPolygon(polygon: Polygon): Point[] {
    try {
      const bounds = this.getPolygonBounds(polygon);
      const chunks: Point[] = [];

      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
          if (this.isPointInPolygon(x, z, polygon)) {
            chunks.push({ x, z });
          }
        }
      }

      return chunks;
    } catch (error) {
      logger.error('Erreur getChunksInPolygon:', error);
      return [];
    }
  }

  getChunksInPolygonOptimized(polygon: Polygon, batchCallback?: (chunks: Point[]) => void): Point[] {
    try {
      const bounds = this.getPolygonBounds(polygon);
      const chunks: Point[] = [];
      const batchSize = 1000;

      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        const batchChunks: Point[] = [];
        
        for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
          if (this.isPointInPolygon(x, z, polygon)) {
            const chunk = { x, z };
            chunks.push(chunk);
            batchChunks.push(chunk);

            if (batchChunks.length >= batchSize && batchCallback) {
              batchCallback([...batchChunks]);
              batchChunks.length = 0;
            }
          }
        }

        if (batchChunks.length > 0 && batchCallback) {
          batchCallback([...batchChunks]);
        }
      }

      return chunks;
    } catch (error) {
      logger.error('Erreur getChunksInPolygonOptimized:', error);
      return [];
    }
  }

  private getPolygonBounds(polygon: Polygon): BoundingBox {
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    for (const point of polygon) {
      if (!point) continue;
      
      const [x, z] = point;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }

    return { 
      minX: Math.floor(minX), 
      maxX: Math.ceil(maxX),
      minZ: Math.floor(minZ), 
      maxZ: Math.ceil(maxZ)
    };
  }

  // ========== VALIDATION ET HELPERS ==========
  validatePolygon(polygon: Polygon): { valid: boolean; error?: string } {
    try {
      if (!Array.isArray(polygon)) {
        return { valid: false, error: 'Le polygone doit être un tableau' };
      }

      if (polygon.length < 3) {
        return { valid: false, error: 'Le polygone doit avoir au moins 3 points' };
      }

      for (let i = 0; i < polygon.length; i++) {
        const point = polygon[i];
        if (!point || !Array.isArray(point) || point.length !== 2) {
          return { valid: false, error: `Point ${i} invalide: doit être [x, z]` };
        }

        const [x, z] = point;
        if (!Number.isInteger(x) || !Number.isInteger(z)) {
          return { valid: false, error: `Point ${i} invalide: coordonnées doivent être des entiers` };
        }
      }

      const area = this.calculatePolygonArea(polygon);
      if (Math.abs(area) < 1) {
        return { valid: false, error: 'Polygone dégénéré (aire trop petite)' };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, error: `Erreur validation: ${error}` };
    }
  }

  private calculatePolygonArea(polygon: Polygon): number {
    let area = 0;
    const numPoints = polygon.length;

    for (let i = 0; i < numPoints; i++) {
      const j = (i + 1) % numPoints;
      const pointI = polygon[i];
      const pointJ = polygon[j];
      
      if (!pointI || !pointJ) continue;
      
      area += pointI[0] * pointJ[1];
      area -= pointJ[0] * pointI[1];
    }

    return area / 2;
  }

  createRectanglePolygon(minX: number, minZ: number, maxX: number, maxZ: number): Polygon {
    if (minX >= maxX || minZ >= maxZ) {
      throw new Error('Coordonnées rectangle invalides: min doit être < max');
    }

    return [
      [minX, minZ],
      [maxX, minZ],
      [maxX, maxZ],
      [minX, maxZ]
    ];
  }

  createCirclePolygon(centerX: number, centerZ: number, radius: number, points: number = 32): Polygon {
    if (radius <= 0) {
      throw new Error('Le rayon doit être positif');
    }

    if (points < 3) {
      throw new Error('Un polygone doit avoir au moins 3 points');
    }

    const polygon: Polygon = [];
    
    for (let i = 0; i < points; i++) {
      const angle = (2 * Math.PI * i) / points;
      const x = Math.round(centerX + radius * Math.cos(angle));
      const z = Math.round(centerZ + radius * Math.sin(angle));
      polygon.push([x, z]);
    }

    return polygon;
  }

  // ========== DIAGNOSTICS ==========
  getPolygonStats(polygon: Polygon): {
    pointCount: number;
    area: number;
    perimeter: number;
    bounds: BoundingBox;
    chunksCount: number;
  } {
    const bounds = this.getPolygonBounds(polygon);
    const area = Math.abs(this.calculatePolygonArea(polygon));
    const perimeter = this.calculatePolygonPerimeter(polygon);
    const chunksCount = this.getChunksInPolygon(polygon).length;

    return {
      pointCount: polygon.length,
      area,
      perimeter,
      bounds,
      chunksCount
    };
  }

  private calculatePolygonPerimeter(polygon: Polygon): number {
    let perimeter = 0;
    const numPoints = polygon.length;

    for (let i = 0; i < numPoints; i++) {
const j = (i + 1) % numPoints;
     const pointI = polygon[i];
     const pointJ = polygon[j];
     
     if (!pointI || !pointJ) continue;
     
     const dx = pointJ[0] - pointI[0];
     const dz = pointJ[1] - pointI[1];
     perimeter += Math.sqrt(dx * dx + dz * dz);
   }

   return perimeter;
 }
}