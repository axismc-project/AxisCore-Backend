import { z } from 'zod';

// Schémas Zod pour validation
export const ChunkCoordinateSchema = z.tuple([z.number().int(), z.number().int()]);
export const PolygonSchema = z.array(ChunkCoordinateSchema).min(3);

export const RegionSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  chunk_boundary: PolygonSchema,
  boundary_cache: z.string(),
  is_active: z.boolean(),
  created_at: z.date(),
  updated_at: z.date()
});

export const NodeSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  region_id: z.number().int().positive(),
  chunk_boundary: PolygonSchema,
  boundary_cache: z.string(),
  experience_points: z.number().int().min(0),
  is_active: z.boolean(),
  created_at: z.date(),
  updated_at: z.date()
});

export const CitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  node_id: z.number().int().positive(),
  chunk_boundary: PolygonSchema,
  boundary_cache: z.string(),
  population: z.number().int().min(0),
  max_population: z.number().int().positive(),
  is_active: z.boolean(),
  created_at: z.date(),
  updated_at: z.date()
});

export const ChunkZoneDataSchema = z.object({
  regionId: z.number().int().positive().nullable(),
  regionName: z.string().nullable(),
  nodeId: z.number().int().positive().nullable(),
  nodeName: z.string().nullable(),
  cityId: z.number().int().positive().nullable(),
  cityName: z.string().nullable()
});

export const ZoneEventSchema = z.object({
  playerUuid: z.string().uuid(),
  zoneType: z.enum(['region', 'node', 'city']),
  zoneId: z.number().int().positive(),
  zoneName: z.string(),
  eventType: z.enum(['enter', 'leave']),
  timestamp: z.number().int().positive()
});

// Types TypeScript inférés
export type Region = z.infer<typeof RegionSchema>;
export type Node = z.infer<typeof NodeSchema>;
export type City = z.infer<typeof CitySchema>;
export type ChunkCoordinate = z.infer<typeof ChunkCoordinateSchema>;
export type Polygon = z.infer<typeof PolygonSchema>;
export type ChunkZoneData = z.infer<typeof ChunkZoneDataSchema>;
export type ZoneEvent = z.infer<typeof ZoneEventSchema>;

// Types pour les réponses API
export interface ZoneHierarchy {
  region_id: number;
  region_name: string;
  region_description?: string;
  region_active: boolean;
  node_id?: number;
  node_name?: string;
  node_description?: string;
  node_active?: boolean;
  city_id?: number;
  city_name?: string;
  city_description?: string;
  population?: number;
  city_active?: boolean;
}

export interface ZoneStats {
  activePlayers: number;
  cachedChunks: number;
  memoryUsage: string;
  regionsCount: number;
  nodesCount: number;
  citiesCount: number;
  lastSyncTime: Date;
}

export interface PostgresNotification {
  table: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  id: number;
  name?: string;
  boundary_cache?: string;
  is_active?: boolean;
  timestamp: number;
}