import { Pool, PoolClient } from 'pg';
import { DatabaseConfig } from '../config/database';
import { Region, Node, City, ZoneHierarchy, PostgresNotification } from '../models/Zone';
import { Player, PlayerWithZones } from '../models/Player';
import { logger } from '../utils/logger';

interface PlayerBatchUpdate {
  uuid: string;
  name: string;
  x: number;
  y: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  regionId?: number;
  nodeId?: number;
  cityId?: number;
  timestamp: number;
}
interface PlayerConnectionBatchUpdate {
  uuid: string;
  name: string;
  isOnline: boolean;
  timestamp: number;
}

export class DatabaseService {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConfig.getInstance();
  }

  // Helper function to safely parse JSON
  private safeJsonParse(jsonString: any, fallback: any = []): any {
    try {
      if (typeof jsonString === 'string') {
        return JSON.parse(jsonString);
      } else if (typeof jsonString === 'object' && jsonString !== null) {
        // Already parsed by PostgreSQL driver
        return jsonString;
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

  // ========== ZONES ==========
  async getAllRegions(): Promise<Region[]> {
    const query = 'SELECT * FROM regions WHERE is_active = true ORDER BY name';
    try {
      const result = await this.pool.query(query);
      return result.rows.map(row => {
        try {
          return {
            ...row,
            chunk_boundary: this.safeJsonParse(row.chunk_boundary, []),
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
          };
        } catch (error) {
          logger.error('Failed to process region row', { 
            regionId: row.id, 
            regionName: row.name,
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
          throw error;
        }
      });
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
      return result.rows.map(row => {
        try {
          return {
            ...row,
            chunk_boundary: this.safeJsonParse(row.chunk_boundary, []),
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
          };
        } catch (error) {
          logger.error('Failed to process node row', { 
            nodeId: row.id, 
            nodeName: row.name,
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
          throw error;
        }
      });
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
      return result.rows.map(row => {
        try {
          return {
            ...row,
            chunk_boundary: this.safeJsonParse(row.chunk_boundary, []),
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
          };
        } catch (error) {
          logger.error('Failed to process city row', { 
            cityId: row.id, 
            cityName: row.name,
            error: error instanceof Error ? error.message : 'Unknown error' 
          });
          throw error;
        }
      });
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

  async batchUpdatePlayers(updates: PlayerBatchUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Prepare batch insert/update using UNNEST
      const values = updates.map((update, index) => {
        const baseIndex = index * 11;
        return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11})`;
      }).join(',');

      const flatParams = updates.flatMap(update => [
        update.uuid,
        update.name,
        update.x,
        update.y,
        update.z,
        update.chunkX,
        update.chunkZ,
        update.regionId || null,
        update.nodeId || null,
        update.cityId || null,
        new Date(update.timestamp)
      ]);

      const query = `
        INSERT INTO players (
          player_uuid, player_name, x, y, z, chunk_x, chunk_z,
          region_id, node_id, city_id, last_updated
        ) 
        VALUES ${values}
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
          is_online = true,
          redis_synced = false
      `;

      await client.query(query, flatParams);
      await client.query('COMMIT');

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Batch update players failed', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        playersCount: updates.length 
      });
      throw error;
    } finally {
      client.release();
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
        chunk_boundary: this.safeJsonParse(row.chunk_boundary, []),
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

  // ========== JOUEURS ==========
  async getPlayerByUuid(uuid: string): Promise<PlayerWithZones | null> {
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
      const result = await this.pool.query(query, [uuid]);
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        ...row,
        last_updated: new Date(row.last_updated)
      };
    } catch (error) {
      logger.error('Failed to fetch player by UUID', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch player');
    }
  }
async batchUpdatePlayerConnections(connections: PlayerConnectionBatchUpdate[]): Promise<void> {
  if (connections.length === 0) return;

  const client = await this.pool.connect();
  
  try {
    await client.query('BEGIN');

    // Préparer les valeurs pour le batch insert/update
    const values = connections.map((connection, index) => {
      const baseIndex = index * 4;
      return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4})`;
    }).join(',');

    const flatParams = connections.flatMap(connection => [
      connection.uuid,
      connection.name,
      connection.isOnline,
      new Date(connection.timestamp)
    ]);

    const query = `
      INSERT INTO players (
        player_uuid, player_name, is_online, last_updated,
        x, y, z, chunk_x, chunk_z, redis_synced
      ) 
      VALUES ${values.replace(/\$(\d+)/g, (match, num) => {
        const paramNum = parseInt(num);
        if (paramNum % 4 === 1) return `$${paramNum}`;  // uuid
        if (paramNum % 4 === 2) return `$${paramNum}`;  // name
        if (paramNum % 4 === 3) return `$${paramNum}`;  // is_online
        if (paramNum % 4 === 0) return `$${paramNum}`;  // timestamp
        return match;
      }).replace(/\) VALUES \(/g, ', 0, 0, 0, 0, 0, false) VALUES (')}
      ON CONFLICT (player_uuid) DO UPDATE SET
        player_name = EXCLUDED.player_name,
        is_online = EXCLUDED.is_online,
        last_updated = EXCLUDED.last_updated,
        x = CASE 
          WHEN players.x IS NULL OR players.x = 0 THEN 0
          ELSE players.x
        END,
        y = CASE 
          WHEN players.y IS NULL OR players.y = 0 THEN 0
          ELSE players.y
        END,
        z = CASE 
          WHEN players.z IS NULL OR players.z = 0 THEN 0
          ELSE players.z
        END,
        chunk_x = CASE 
          WHEN players.chunk_x IS NULL OR players.chunk_x = 0 THEN 0
          ELSE players.chunk_x
        END,
        chunk_z = CASE 
          WHEN players.chunk_z IS NULL OR players.chunk_z = 0 THEN 0
          ELSE players.chunk_z
        END,
        redis_synced = false
    `;

    // Reconstruire la requête manuellement pour les valeurs par défaut
// Ligne 148 environ - Remplacer la requête par :
const finalQuery = `
  WITH new_values AS (
    SELECT * FROM (VALUES ${connections.map((_, index) => {
      const base = index * 4;
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(',')}) AS t(player_uuid, player_name, is_online, last_updated)
  )
  INSERT INTO players (
    player_uuid, player_name, is_online, last_updated,
    x, y, z, chunk_x, chunk_z, redis_synced
  )
  SELECT 
    player_uuid, player_name, is_online, last_updated,
    0, 0, 0, 0, 0, false
  FROM new_values
  ON CONFLICT (player_uuid) DO UPDATE SET
    player_name = EXCLUDED.player_name,
    is_online = EXCLUDED.is_online,
    last_updated = EXCLUDED.last_updated,
    x = CASE 
      WHEN players.x IS NULL OR players.x = 0 THEN 0
      ELSE players.x
    END,
    y = CASE 
      WHEN players.y IS NULL OR players.y = 0 THEN 0
      ELSE players.y
    END,
    z = CASE 
      WHEN players.z IS NULL OR players.z = 0 THEN 0
      ELSE players.z
    END,
    chunk_x = CASE 
      WHEN players.chunk_x IS NULL OR players.chunk_x = 0 THEN 0
      ELSE players.chunk_x
    END,
    chunk_z = CASE 
      WHEN players.chunk_z IS NULL OR players.chunk_z = 0 THEN 0
      ELSE players.chunk_z
    END,
    redis_synced = false
`;

    await client.query(finalQuery, flatParams);
    await client.query('COMMIT');

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Batch update player connections failed', { 
      error: error instanceof Error ? error.message : 'Unknown error',
      playersCount: connections.length 
    });
    throw error;
  } finally {
    client.release();
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
      logger.error('Failed to update player position', { 
        uuid, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to update player position');
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
      // Don't throw - logging failure shouldn't break main operation
      logger.warn('Zone event logging failed, continuing operation');
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

  // ========== DIAGNOSTICS ==========
  async checkDatabaseIntegrity(): Promise<{
    regionsWithInvalidJson: number;
    nodesWithInvalidJson: number;
    citiesWithInvalidJson: number;
    totalIssues: number;
  }> {
    try {
      const [regionsResult, nodesResult, citiesResult] = await Promise.all([
        this.pool.query(`
          SELECT id, name, chunk_boundary 
          FROM regions 
          WHERE is_active = true
        `),
        this.pool.query(`
          SELECT id, name, chunk_boundary 
          FROM nodes 
          WHERE is_active = true
        `),
        this.pool.query(`
          SELECT id, name, chunk_boundary 
          FROM cities 
          WHERE is_active = true
        `)
      ]);

      let regionsWithInvalidJson = 0;
      let nodesWithInvalidJson = 0;
      let citiesWithInvalidJson = 0;

      // Check regions
      for (const row of regionsResult.rows) {
        try {
          this.safeJsonParse(row.chunk_boundary);
        } catch {
          regionsWithInvalidJson++;
          logger.warn('Invalid JSON in region', { 
            regionId: row.id, 
            regionName: row.name 
          });
        }
      }

      // Check nodes
      for (const row of nodesResult.rows) {
        try {
          this.safeJsonParse(row.chunk_boundary);
        } catch {
          nodesWithInvalidJson++;
          logger.warn('Invalid JSON in node', { 
            nodeId: row.id, 
            nodeName: row.name 
          });
        }
      }

      // Check cities
      for (const row of citiesResult.rows) {
        try {
          this.safeJsonParse(row.chunk_boundary);
        } catch {
          citiesWithInvalidJson++;
          logger.warn('Invalid JSON in city', { 
            cityId: row.id, 
            cityName: row.name 
          });
        }
      }

      const totalIssues = regionsWithInvalidJson + nodesWithInvalidJson + citiesWithInvalidJson;

      return {
        regionsWithInvalidJson,
        nodesWithInvalidJson,
        citiesWithInvalidJson,
        totalIssues
      };
    } catch (error) {
      logger.error('Failed to check database integrity', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to check database integrity');
    }
  }

// Ajouter dans DatabaseService

async updateZonePolygon(
  zoneType: 'region' | 'node' | 'city', 
  id: number, 
  newPolygon: any[]
): Promise<void> {
  const tableName = zoneType === 'region' ? 'regions' : zoneType === 'node' ? 'nodes' : 'cities';
  
  const query = `
    UPDATE ${tableName} 
    SET chunk_boundary = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
  `;

  try {
    await this.pool.query(query, [JSON.stringify(newPolygon), id]);
  } catch (error) {
    logger.error('Failed to update zone polygon', { 
      zoneType, 
      zoneId: id, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
    throw new Error('Unable to update zone polygon');
  }
}

async createZone(
  zoneType: 'region' | 'node' | 'city',
  name: string,
  description: string | null,
  polygon: any[],
  parentId?: number
): Promise<number> {
  const client = await this.pool.connect();
  
  try {
    await client.query('BEGIN');
    
    let query: string;
    let params: any[];
    
    if (zoneType === 'region') {
      query = `
        INSERT INTO regions (name, description, chunk_boundary, boundary_cache, is_active)
        VALUES ($1, $2, $3, $4, true)
        RETURNING id
      `;
      params = [name, description, JSON.stringify(polygon), JSON.stringify(polygon)];
    } else if (zoneType === 'node') {
      query = `
        INSERT INTO nodes (name, description, region_id, chunk_boundary, boundary_cache, is_active)
        VALUES ($1, $2, $3, $4, $5, true)
        RETURNING id
      `;
      params = [name, description, parentId, JSON.stringify(polygon), JSON.stringify(polygon)];
    } else {
      query = `
        INSERT INTO cities (name, description, node_id, chunk_boundary, boundary_cache, is_active)
        VALUES ($1, $2, $3, $4, $5, true)
        RETURNING id
      `;
      params = [name, description, parentId, JSON.stringify(polygon), JSON.stringify(polygon)];
    }
    
    const result = await client.query(query, params);
    const newId = result.rows[0].id;
    
    await client.query('COMMIT');
    return newId;
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to create zone', { 
      zoneType, 
      name, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
    throw new Error('Unable to create zone');
  } finally {
    client.release();
  }
}
// Ajouter dans DatabaseService

async createPlayer(
  uuid: string, 
  name: string, 
  x: number, 
  y: number, 
  z: number
): Promise<void> {
  const chunkX = Math.floor(x / 16);
  const chunkZ = Math.floor(z / 16);

  const query = `
    INSERT INTO players (
      player_uuid, player_name, x, y, z, chunk_x, chunk_z,
      region_id, node_id, city_id, last_updated, is_online, redis_synced
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, CURRENT_TIMESTAMP, false, true)
  `;

  try {
    await this.pool.query(query, [uuid, name, x, y, z, chunkX, chunkZ]);
  } catch (error) {
    logger.error('Failed to create player', { 
      uuid, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
    throw new Error('Unable to create player');
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
      logger.error('Failed to fetch zone statistics', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to fetch statistics');
    }
  }
}