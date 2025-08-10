import { Pool, PoolClient } from 'pg';
import { DatabaseConfig } from '../config/database';
import { Region, Node, City, ZoneHierarchy, PostgresNotification } from '../models/Zone';
import { Player, PlayerWithZones } from '../models/Player';
import { logger } from '../utils/logger';

export class DatabaseService {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConfig.getInstance();
  }

  // ========== ZONES ==========
  async getAllRegions(): Promise<Region[]> {
    const query = 'SELECT * FROM regions WHERE is_active = true ORDER BY name';
    try {
      const result = await this.pool.query(query);
      return result.rows.map(row => ({
        ...row,
        chunk_boundary: JSON.parse(row.chunk_boundary),
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at)
      }));
    } catch (error) {
      logger.error('Erreur getAllRegions:', error);
      throw new Error('Impossible de récupérer les régions');
    }
  }

  async getAllNodes(): Promise<Node[]> {
    const query = 'SELECT * FROM nodes WHERE is_active = true ORDER BY region_id, name';
    try {
      const result = await this.pool.query(query);
      return result.rows.map(row => ({
        ...row,
        chunk_boundary: JSON.parse(row.chunk_boundary),
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at)
      }));
    } catch (error) {
      logger.error('Erreur getAllNodes:', error);
      throw new Error('Impossible de récupérer les nodes');
    }
  }

  async getAllCities(): Promise<City[]> {
    const query = 'SELECT * FROM cities WHERE is_active = true ORDER BY node_id, name';
    try {
      const result = await this.pool.query(query);
      return result.rows.map(row => ({
        ...row,
        chunk_boundary: JSON.parse(row.chunk_boundary),
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at)
      }));
    } catch (error) {
      logger.error('Erreur getAllCities:', error);
      throw new Error('Impossible de récupérer les villes');
    }
  }

  async getZoneHierarchy(): Promise<ZoneHierarchy[]> {
    const query = `
      SELECT 
        r.id as region_id,
        r.name as region_name,
        r.description as region_description,
        r.is_active as region_active,
        n.id as node_id,
        n.name as node_name,
        n.description as node_description,
        n.node_level,
        n.is_active as node_active,
        c.id as city_id,
        c.name as city_name,
        c.description as city_description,
        c.city_level,
        c.population,
        c.is_active as city_active
      FROM regions r
      LEFT JOIN nodes n ON n.region_id = r.id AND n.is_active = true
      LEFT JOIN cities c ON c.node_id = n.id AND c.is_active = true
      WHERE r.is_active = true
      ORDER BY r.name, n.name, c.name
    `;

    try {
      const result = await this.pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error('Erreur getZoneHierarchy:', error);
      throw new Error('Impossible de récupérer la hiérarchie des zones');
    }
  }

  async getZoneById(zoneType: 'region' | 'node' | 'city', id: number): Promise<Region | Node | City | null> {
    const tableName = zoneType === 'region' ? 'regions' : zoneType === 'node' ? 'nodes' : 'cities';
    const query = `SELECT * FROM ${tableName} WHERE id = $1 AND is_active = true`;

    try {
      const result = await this.pool.query(query, [id]);
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        ...row,
        chunk_boundary: JSON.parse(row.chunk_boundary),
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at)
      };
    } catch (error) {
      logger.error(`Erreur getZoneById ${zoneType}:${id}:`, error);
      throw new Error(`Impossible de récupérer la zone ${zoneType}:${id}`);
    }
  }

  // ========== JOUEURS ==========
  async getPlayerByUuid(uuid: string): Promise<PlayerWithZones | null> {
    const query = `
      SELECT 
        p.*,
        r.name as region_name,
        n.name as node_name,
        n.node_level,
        c.name as city_name,
        c.city_level,
        c.population
      FROM players p
      LEFT JOIN regions r ON p.region_id = r.id
      LEFT JOIN nodes n ON p.node_id = n.id
      LEFT JOIN cities c ON p.city_id = c.id
      WHERE p.player_uuid = $1
    `;

    try {
      const result = await this.pool.query(query, [uuid]);
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        ...row,
        last_updated: new Date(row.last_updated)
      };
    } catch (error) {
      logger.error('Erreur getPlayerByUuid:', error);
      throw new Error('Impossible de récupérer le joueur');
    }
  }

  async getPlayersInZone(zoneType: 'region' | 'node' | 'city', zoneId: number): Promise<Player[]> {
    const columnName = `${zoneType}_id`;
    const query = `
      SELECT * FROM players 
      WHERE ${columnName} = $1 AND is_online = true 
      ORDER BY player_name
    `;

    try {
      const result = await this.pool.query(query, [zoneId]);
      return result.rows.map(row => ({
        ...row,
        last_updated: new Date(row.last_updated)
      }));
    } catch (error) {
      logger.error(`Erreur getPlayersInZone ${zoneType}:${zoneId}:`, error);
      throw new Error(`Impossible de récupérer les joueurs de la zone ${zoneType}:${zoneId}`);
    }
  }

  async updatePlayerPosition(
    uuid: string, 
    name: string, 
    x: number, 
    y: number, 
    z: number,
    regionId?: number,
    nodeId?: number,
    cityId?: number
  ): Promise<void> {
    const chunkX = Math.floor(x / 16);
    const chunkZ = Math.floor(z / 16);

    const query = `
      INSERT INTO players (
        player_uuid, player_name, x, y, z, chunk_x, chunk_z,
        region_id, node_id, city_id, last_updated, is_online, redis_synced
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, true, false)
      ON CONFLICT (player_uuid) DO UPDATE SET
        player_name = EXCLUDED.player_name,
        x = EXCLUDED.x,
        y = EXCLUDED.y,
        z = EXCLUDED.z,
        chunk_x = EXCLUDED.chunk_x,
        chunk_z = EXCLUDED.chunk_z,
        region_id = EXCLUDED.region_id,
        node_id = EXCLUDED.node_id,
        city_id = EXCLUDED.city_id,
        last_updated = EXCLUDED.last_updated,
        is_online = EXCLUDED.is_online,
        redis_synced = EXCLUDED.redis_synced
    `;

    try {
      await this.pool.query(query, [
        uuid, name, x, y, z, chunkX, chunkZ, 
        regionId, nodeId, cityId
      ]);
    } catch (error) {
      logger.error('Erreur updatePlayerPosition:', error);
      throw new Error('Impossible de mettre à jour la position du joueur');
    }
  }

  async logZoneEvent(
    playerUuid: string,
    playerName: string,
    eventType: 'enter' | 'leave',
    zoneType: 'region' | 'node' | 'city',
    zoneId: number,
    zoneName: string,
    x?: number,
    y?: number,
    z?: number,
    metadata?: any
  ): Promise<void> {
    const chunkX = x ? Math.floor(x / 16) : null;
    const chunkZ = z ? Math.floor(z / 16) : null;

    const query = `
      INSERT INTO zone_events (
        player_uuid, player_name, event_type, zone_type, zone_id, zone_name,
        x, y, z, chunk_x, chunk_z, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `;

    try {
      await this.pool.query(query, [
        playerUuid, playerName, eventType, zoneType, zoneId, zoneName,
        x, y, z, chunkX, chunkZ, metadata ? JSON.stringify(metadata) : null
      ]);
    } catch (error) {
      logger.error('Erreur logZoneEvent:', error);
      // Ne pas faire échouer l'opération principale si le log échoue
      logger.warn('Impossible de logger l\'événement de zone, continuation...');
    }
  }

  // ========== ÉCOUTE DES CHANGEMENTS ==========
  async listenToChanges(callback: (notification: PostgresNotification) => void): Promise<PoolClient> {
    const client = await this.pool.connect();
    
    try {
      await client.query('LISTEN zone_updated');
      
      client.on('notification', (msg) => {
        if (msg.channel === 'zone_updated' && msg.payload) {
          try {
            const data = JSON.parse(msg.payload) as PostgresNotification;
            callback(data);
          } catch (error) {
            logger.error('Erreur parsing notification PostgreSQL:', error);
          }
        }
      });

      logger.info('Écoute des notifications PostgreSQL démarrée');
      return client;
    } catch (error) {
      client.release();
      logger.error('Erreur listenToChanges:', error);
      throw new Error('Impossible d\'écouter les changements PostgreSQL');
    }
  }

  // ========== STATISTIQUES ==========
  async getZoneStats(): Promise<{
    regionsCount: number;
    nodesCount: number;
    citiesCount: number;
    playersCount: number;
    onlinePlayersCount: number;
  }> {
    const query = `
      SELECT 
        (SELECT COUNT(*) FROM regions WHERE is_active = true) as regions_count,
        (SELECT COUNT(*) FROM nodes WHERE is_active = true) as nodes_count,
        (SELECT COUNT(*) FROM cities WHERE is_active = true) as cities_count,
        (SELECT COUNT(*) FROM players) as players_count,
        (SELECT COUNT(*) FROM players WHERE is_online = true) as online_players_count
    `;

    try {
      const result = await this.pool.query(query);
      const row = result.rows[0];
      return {
        regionsCount: parseInt(row.regions_count),
        nodesCount: parseInt(row.nodes_count),
        citiesCount: parseInt(row.cities_count),
        playersCount: parseInt(row.players_count),
        onlinePlayersCount: parseInt(row.online_players_count)
      };
    } catch (error) {
      logger.error('Erreur getZoneStats:', error);
      throw new Error('Impossible de récupérer les statistiques');
    }
  }
}