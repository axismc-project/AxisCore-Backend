import { z } from 'zod';

export const PlayerSchema = z.object({
  id: z.number().int().positive(),
  player_uuid: z.string().uuid(),
  player_name: z.string().min(1).max(16),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  chunk_x: z.number().int(),
  chunk_z: z.number().int(),
  region_id: z.number().int().positive().nullable(),
  node_id: z.number().int().positive().nullable(),
  city_id: z.number().int().positive().nullable(),
  last_updated: z.date(),
  is_online: z.boolean(),
  redis_synced: z.boolean()
});

export type Player = z.infer<typeof PlayerSchema>;

export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
  chunk_x: number;
  chunk_z: number;
  timestamp: number;
}

export interface PlayerZones {
  region_id?: number;
  node_id?: number;
  city_id?: number;
  last_update: number;
}

export interface PlayerWithZones extends Player {
  region_name?: string;
  node_name?: string;
  city_name?: string;
  node_level?: number;
  city_level?: number;
  population?: number;
}