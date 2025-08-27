import { Pool, PoolClient } from 'pg';
import { DatabaseConfig } from '../config/database';
import { Region, Node, City, ZoneHierarchy, PostgresNotification } from '../models/Zone';
import { Player, PlayerWithZones } from '../models/Player';
import { logger } from '../utils/logger';

interface PlayerBatchUpdate {
  server_uuid: string;
  name: string;
  x: number;
  y: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  regionId: number | null;
  nodeId: number | null;
  cityId: number | null;
  timestamp: number;
}

interface PlayerConnectionBatchUpdate {
  server_uuid: string;
  name: string;
  isOnline: boolean;
  timestamp: number;
}

export class DatabaseService {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConfig.getInstance();
  }

  private safeJsonParse(jsonString: any, fallback: any = []): any {
    try {
      if (typeof jsonString === 'object' && jsonString !== null) {
        return jsonString;
      } else if (typeof jsonString === 'string') {
        return JSON.parse(jsonString);
      } else {
        logger.warn('Invalid JSON data type', { type: typeof jsonString, value: jsonString });
        return fallback;
      }
    } catch (error) {
      logger.error('Failed to parse JSON', { 
        jsonString, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return fallback;
    }
  }

  // ========== PLAYER METHODS WITH server_uuid ==========

  async getPlayerByServerUuid(server_uuid: string): Promise<PlayerWithZones | null> {
    const query = `
      SELECT 
        p.*,
        r.name as region_name,
        n.name as node_name,
        c.name as city_name
      FROM players p
      LEFT JOIN regions r ON p.region_id = r.id
      LEFT JOIN nodes n ON p.node_id = n.id
      LEFT JOIN cities c ON p.city_id = c.id
      WHERE p.server_uuid = $1
    `;

    try {
      const result = await this.pool.query(query, [server_uuid]);
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        ...row,
        last_updated: new Date(row.last_updated)
      };
    } catch (error) {
      logger.error('Failed to fetch player by server UUID', { 
        server_uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch player');
    }
  }

  async getPlayerByPlayerUuid(player_uuid: string): Promise<PlayerWithZones | null> {
    const query = `
      SELECT 
        p.*,
        r.name as region_name,
        n.name as node_name,
        c.name as city_name
      FROM players p
      LEFT JOIN regions r ON p.region_id = r.id
      LEFT JOIN nodes n ON p.node_id = n.id
      LEFT JOIN cities c ON p.city_id = c.id
      WHERE p.player_uuid = $1
    `;

    try {
      const result = await this.pool.query(query, [player_uuid]);
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        ...row,
        last_updated: new Date(row.last_updated)
      };
    } catch (error) {
      logger.error('Failed to fetch player by player UUID', { 
        player_uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch player');
    }
  }

  async getPlayerByPlayerName(player_name: string): Promise<PlayerWithZones | null> {
    const query = `
      SELECT 
        p.*,
        r.name as region_name,
        n.name as node_name,
        c.name as city_name
      FROM players p
      LEFT JOIN regions r ON p.region_id = r.id
      LEFT JOIN nodes n ON p.node_id = n.id
      LEFT JOIN cities c ON p.city_id = c.id
      WHERE p.player_name = $1
      ORDER BY p.last_updated DESC
      LIMIT 1
    `;

    try {
      const result = await this.pool.query(query, [player_name]);
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        ...row,
        last_updated: new Date(row.last_updated)
      };
    } catch (error) {
      logger.error('Failed to fetch player by name', { 
        player_name, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch player');
    }
  }

  async updatePlayerServerUuid(
    player_uuid: string, 
    new_server_uuid: string, 
    name: string, 
    is_online: boolean
  ): Promise<void> {
    const query = `
      UPDATE players 
      SET server_uuid = $1, 
          player_name = $2, 
          is_online = $3, 
          last_updated = CURRENT_TIMESTAMP
      WHERE player_uuid = $4
    `;

    try {
      await this.pool.query(query, [new_server_uuid, name, is_online, player_uuid]);
    } catch (error) {
      logger.error('Failed to update player server UUID', { 
        player_uuid, 
        new_server_uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to update player server UUID');
    }
  }

  async createPlayerWithUuids(
    server_uuid: string, 
    player_uuid: string, 
    name: string, 
    is_online: boolean
  ): Promise<void> {
    const query = `
      INSERT INTO players (
        server_uuid, player_uuid, player_name, x, y, z, chunk_x, chunk_z,
        region_id, node_id, city_id, last_updated, is_online, redis_synced
      ) VALUES ($1, $2, $3, 0, 0, 0, 0, 0, NULL, NULL, NULL, CURRENT_TIMESTAMP, $4, false)
    `;

    try {
      await this.pool.query(query, [server_uuid, player_uuid, name, is_online]);
    } catch (error) {
      logger.error('Failed to create player with UUIDs', { 
        server_uuid, 
        player_uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to create player');
    }
  }

  // ========== OPTIMIZED BATCH UPDATES ==========

  async batchUpdatePlayerPositions(updates: PlayerBatchUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      const batchSize = 500;
      
      for (let i = 0; i < updates.length; i += batchSize) {
        const batch = updates.slice(i, i + batchSize);
        
        const valuesRows = batch.map((_, index) => {
          const baseIndex = index * 10;
          return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10})`;
        }).join(',');

        const params = batch.flatMap(update => [
          update.server_uuid,
          update.x,
          update.y,
          update.z,
          update.chunkX,
          update.chunkZ,
          update.regionId,
          update.nodeId,
          update.cityId,
          new Date(update.timestamp)
        ]);

        const query = `
          UPDATE players 
          SET 
            x = batch_data.x,
            y = batch_data.y,
            z = batch_data.z,
            chunk_x = batch_data.chunk_x,
            chunk_z = batch_data.chunk_z,
            region_id = batch_data.region_id,
            node_id = batch_data.node_id,
            city_id = batch_data.city_id,
            last_updated = batch_data.last_updated,
            redis_synced = true
          FROM (
            VALUES ${valuesRows}
          ) AS batch_data(server_uuid, x, y, z, chunk_x, chunk_z, region_id, node_id, city_id, last_updated)
          WHERE players.server_uuid = batch_data.server_uuid
        `;

        const result = await client.query(query, params);
        
        logger.debug('✅ Batch positions updated', { 
          batchSize: batch.length, 
          updatedRows: result.rowCount || 0,
          batchIndex: Math.floor(i / batchSize) + 1
        });
      }

      await client.query('COMMIT');
      logger.info('✅ All player positions batch updated', { 
        totalPlayers: updates.length,
        batches: Math.ceil(updates.length / batchSize)
      });

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('❌ Failed to batch update player positions', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        count: updates.length 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async markPlayerRedisSynced(server_uuid: string, synced: boolean = true): Promise<void> {
    const query = `
      UPDATE players 
      SET redis_synced = $1, last_updated = CURRENT_TIMESTAMP
      WHERE server_uuid = $2
    `;

    try {
      const result = await this.pool.query(query, [synced, server_uuid]);
      
      if ((result.rowCount || 0) === 0) {
        logger.warn('⚠️ Player not found for Redis sync update', { 
          server_uuid: server_uuid.substring(0, 8) + '...' 
        });
      } else {
        logger.debug('✅ Player Redis sync status updated', { 
          server_uuid: server_uuid.substring(0, 8) + '...',
          synced 
        });
      }
      
    } catch (error) {
      logger.error('❌ Failed to update Redis sync status', { 
        server_uuid: server_uuid.substring(0, 8) + '...',
        synced,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  async getUnsyncedPlayers(limit: number = 100): Promise<Array<{
    id: number;
    server_uuid: string;
    player_uuid: string;
    player_name: string;
    x: number;
    y: number;
    z: number;
    chunk_x: number;
    chunk_z: number;
    last_updated: Date;
  }>> {
    const query = `
      SELECT id, server_uuid, player_uuid, player_name, x, y, z, chunk_x, chunk_z, last_updated
      FROM players 
      WHERE redis_synced = false 
        AND is_online = true
        AND server_uuid IS NOT NULL
      ORDER BY last_updated ASC
      LIMIT $1
    `;

    try {
      const result = await this.pool.query(query, [limit]);
      return result.rows.map(row => ({
        ...row,
        last_updated: new Date(row.last_updated)
      }));
    } catch (error) {
      logger.error('❌ Failed to get unsynced players', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  async batchUpdatePlayerConnections(connections: PlayerConnectionBatchUpdate[]): Promise<void> {
    if (connections.length === 0) return;

    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      const valuesRows = connections.map((_, index) => {
        const baseIndex = index * 4;
        return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4})`;
      }).join(',');

      const params = connections.flatMap(conn => [
        conn.server_uuid,
        conn.name,
        conn.isOnline,
        new Date(conn.timestamp)
      ]);

      const query = `
        INSERT INTO players (
          server_uuid, player_name, is_online, last_updated,
          x, y, z, chunk_x, chunk_z, redis_synced
        )
        SELECT 
          server_uuid, player_name, is_online, last_updated,
          0, 0, 0, 0, 0, false
        FROM (
          VALUES ${valuesRows}
        ) AS new_data(server_uuid, player_name, is_online, last_updated)
        ON CONFLICT (server_uuid) DO UPDATE SET
          player_name = EXCLUDED.player_name,
          is_online = EXCLUDED.is_online,
          last_updated = EXCLUDED.last_updated,
          redis_synced = false
      `;

      const result = await client.query(query, params);
      await client.query('COMMIT');

      logger.info('✅ Player connections batch updated', { 
        connections: connections.length,
        upserted: result.rowCount || 0
      });

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('❌ Failed to batch update player connections', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        count: connections.length 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // ========== ZONES ==========

  async getAllRegions(): Promise<Region[]> {
    const query = 'SELECT * FROM regions WHERE is_active = true ORDER BY name';
    try {
      const result = await this.pool.query(query);
      return result.rows.map(row => ({
        ...row,
        chunk_boundary: row.chunk_boundary || [],
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at)
      }));
    } catch (error) {
      logger.error('Failed to fetch regions', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch regions');
    }
  }

  async getAllNodes(): Promise<Node[]> {
    const query = 'SELECT * FROM nodes WHERE is_active = true ORDER BY region_id, name';
    try {
      const result = await this.pool.query(query);
      return result.rows.map(row => ({
        ...row,
        chunk_boundary: row.chunk_boundary || [],
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at)
      }));
    } catch (error) {
      logger.error('Failed to fetch nodes', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch nodes');
    }
  }

  async getAllCities(): Promise<City[]> {
    const query = 'SELECT * FROM cities WHERE is_active = true ORDER BY node_id, name';
    try {
      const result = await this.pool.query(query);
      return result.rows.map(row => ({
        ...row,
        chunk_boundary: row.chunk_boundary || [],
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at)
      }));
    } catch (error) {
      logger.error('Failed to fetch cities', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch cities');
    }
  }

  async getAllOnlinePlayers(): Promise<Player[]> {
    const query = `
      SELECT * FROM players 
      WHERE is_online = true 
      ORDER BY last_updated DESC
    `;

    try {
      const result = await this.pool.query(query);
      return result.rows.map(row => ({
        ...row,
        last_updated: new Date(row.last_updated)
      }));
    } catch (error) {
      logger.error('Failed to fetch online players', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch online players');
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
        n.is_active as node_active,
        c.id as city_id,
        c.name as city_name,
        c.description as city_description,
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
      logger.error('Failed to fetch zone hierarchy', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch zone hierarchy');
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
        chunk_boundary: row.chunk_boundary || [],
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at)
      };
    } catch (error) {
      logger.error('Failed to fetch zone by ID', { 
        zoneType, 
        zoneId: id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error(`Unable to fetch zone ${zoneType}:${id}`);
    }
  }

  // ========== COMPATIBILITY METHODS ==========

  async getPlayerByUuid(uuid: string): Promise<PlayerWithZones | null> {
    return this.getPlayerByServerUuid(uuid);
  }

  async updatePlayerPosition(
    server_uuid: string, 
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
      UPDATE players 
      SET player_name = $2,
          x = $3,
          y = $4,
          z = $5,
          chunk_x = $6,
          chunk_z = $7,
          region_id = $8,
          node_id = $9,
          city_id = $10,
          last_updated = CURRENT_TIMESTAMP,
          is_online = true,
          redis_synced = true
      WHERE server_uuid = $1
    `;

    try {
      const result = await this.pool.query(query, [
        server_uuid, name, x, y, z, chunkX, chunkZ, 
        regionId, nodeId, cityId
      ]);

      if ((result.rowCount || 0) === 0) {
        logger.warn('⚠️ No player found for position update', { 
          server_uuid: server_uuid.substring(0, 8) + '...' 
        });
      }
      
    } catch (error) {
      logger.error('Failed to update player position', { 
        server_uuid: server_uuid.substring(0, 8) + '...', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to update player position');
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
      logger.error('Failed to fetch players in zone', { 
        zoneType, 
        zoneId, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error(`Unable to fetch players in zone ${zoneType}:${zoneId}`);
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
      logger.error('Failed to log zone event', { 
        playerUuid, 
        eventType, 
        zoneType, 
        zoneId,
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      logger.warn('Zone event logging failed, continuing operation');
    }
  }

  // ========== UTILITIES ==========

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
            logger.error('Failed to parse PostgreSQL notification', { 
              error: error instanceof Error ? error.message : 'Unknown error' 
            });
          }
        }
      });

      logger.info('PostgreSQL notification listener started');
      return client;
    } catch (error) {
      client.release();
      logger.error('Failed to setup PostgreSQL listener', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to listen to PostgreSQL changes');
    }
  }

  async executeQuery(query: string, params?: any[]): Promise<any> {
    try {
      const result = await this.pool.query(query, params);
      return result;
    } catch (error) {
      logger.error('Database query failed', { 
        query: query.substring(0, 100) + '...', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Database query execution failed');
    }
  }

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
      logger.error('Failed to fetch zone statistics', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch statistics');
    }
  }
}