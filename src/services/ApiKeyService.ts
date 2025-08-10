import { Pool } from 'pg';
import { DatabaseConfig } from '../config/database';
import bcrypt from 'bcrypt';
import { logger } from '../utils/logger';

export interface ApiKey {
  id: number;
  keyName: string;
  apiKey: string;
  permissions: string[];
  isActive: boolean;
  rateLimitPerHour: number;
  rateLimitPerMinute: number;
  lastUsedAt?: Date;
  usageCount: number;
  expiresAt?: Date;
  description?: string;
}

export interface ApiKeyUsage {
  apiKeyId: number;
  endpoint: string;
  requestCount: number;
  windowStart: Date;
  windowEnd: Date;
}

export class ApiKeyService {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConfig.getInstance();
  }

  // Valider une API key et retourner les informations
  async validateApiKey(apiKey: string): Promise<ApiKey | null> {
    const query = `
      SELECT id, key_name, api_key, key_hash, permissions, is_active, 
             rate_limit_per_hour, rate_limit_per_minute, last_used_at, 
             usage_count, expires_at, description
      FROM api_keys 
      WHERE api_key = $1 AND is_active = true
    `;

    try {
      const result = await this.pool.query(query, [apiKey]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      // Vérifier l'expiration
      if (row.expires_at && new Date() > new Date(row.expires_at)) {
        logger.warn('API key expired', { keyName: row.key_name });
        return null;
      }

      return {
        id: row.id,
        keyName: row.key_name,
        apiKey: row.api_key,
        permissions: Array.isArray(row.permissions) ? row.permissions : JSON.parse(row.permissions || '[]'),
        isActive: row.is_active,
        rateLimitPerHour: row.rate_limit_per_hour,
        rateLimitPerMinute: row.rate_limit_per_minute,
        lastUsedAt: row.last_used_at,
        usageCount: row.usage_count,
        expiresAt: row.expires_at,
        description: row.description
      };
    } catch (error) {
      logger.error('Failed to validate API key', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return null;
    }
  }

  // Vérifier les permissions
  hasPermission(apiKey: ApiKey, requiredPermission: string): boolean {
    // Administrateur total
    if (apiKey.permissions.includes('*')) {
      return true;
    }

    // Permission exacte
    if (apiKey.permissions.includes(requiredPermission)) {
      return true;
    }

    // Permission avec wildcard (ex: "player:*" pour "player:read")
    const wildcardPermissions = apiKey.permissions.filter(p => p.endsWith(':*'));
    for (const wildcard of wildcardPermissions) {
      const basePermission = wildcard.replace(':*', '');
      if (requiredPermission.startsWith(basePermission + ':')) {
        return true;
      }
    }

    return false;
  }

  // Vérifier le rate limiting
  async checkRateLimit(apiKeyId: number, endpoint: string, rateLimitPerMinute: number): Promise<boolean> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60000); // 1 minute ago

    const query = `
      SELECT COALESCE(SUM(request_count), 0) as total_requests
      FROM api_key_usage 
      WHERE api_key_id = $1 
        AND endpoint = $2 
        AND window_start >= $3
    `;

    try {
      const result = await this.pool.query(query, [apiKeyId, endpoint, windowStart]);
      const totalRequests = parseInt(result.rows[0].total_requests);

      return totalRequests < rateLimitPerMinute;
    } catch (error) {
      logger.error('Failed to check rate limit', { 
        apiKeyId, 
        endpoint, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false; // En cas d'erreur, bloquer par sécurité
    }
  }

  // Enregistrer l'utilisation d'une API key
  async recordUsage(apiKeyId: number, endpoint: string): Promise<void> {
    const now = new Date();
    const windowStart = new Date(Math.floor(now.getTime() / 60000) * 60000); // Début de la minute courante
    const windowEnd = new Date(windowStart.getTime() + 60000); // Fin de la minute courante

    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Insérer ou mettre à jour le compteur d'usage
      await client.query(`
        INSERT INTO api_key_usage (api_key_id, endpoint, request_count, window_start, window_end)
        VALUES ($1, $2, 1, $3, $4)
        ON CONFLICT (api_key_id, endpoint, window_start) 
        DO UPDATE SET request_count = api_key_usage.request_count + 1
      `, [apiKeyId, endpoint, windowStart, windowEnd]);

      // Mettre à jour les statistiques de l'API key
      await client.query(`
        UPDATE api_keys 
        SET usage_count = usage_count + 1, last_used_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [apiKeyId]);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to record API key usage', { 
        apiKeyId, 
        endpoint, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    } finally {
      client.release();
    }
  }

  // Créer une nouvelle API key
  async createApiKey(
    keyName: string, 
    permissions: string[], 
    description?: string,
    expiresAt?: Date,
    rateLimitPerHour: number = 1000,
    rateLimitPerMinute: number = 60
  ): Promise<string> {
    // Générer une API key sécurisée
    const apiKey = `mk_live_${this.generateRandomKey(64)}`;
    const keyHash = await bcrypt.hash(apiKey, 12);

    const query = `
      INSERT INTO api_keys (
        key_name, api_key, key_hash, permissions, description, 
        expires_at, rate_limit_per_hour, rate_limit_per_minute
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `;

    try {
      await this.pool.query(query, [
        keyName, apiKey, keyHash, JSON.stringify(permissions),
        description, expiresAt, rateLimitPerHour, rateLimitPerMinute
      ]);

      logger.info('API key created', { keyName, permissions });
      return apiKey;
    } catch (error) {
      logger.error('Failed to create API key', { 
        keyName, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw new Error('Unable to create API key');
    }
  }

  // Révoquer une API key
  async revokeApiKey(keyName: string): Promise<boolean> {
    const query = `
      UPDATE api_keys 
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE key_name = $1
    `;

    try {
      const result = await this.pool.query(query, [keyName]);
      
      // ✅ Correction: Vérification null-safe de rowCount
      const revoked = (result.rowCount ?? 0) > 0;
      
      if (revoked) {
        logger.info('API key revoked', { keyName });
      }
      
      return revoked;
    } catch (error) {
      logger.error('Failed to revoke API key', { 
        keyName, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // Obtenir les statistiques d'usage
  async getUsageStats(keyName?: string): Promise<any> {
    let query = `
      SELECT 
        ak.key_name,
        ak.usage_count,
        ak.last_used_at,
        ak.created_at,
        ak.permissions,
        ak.is_active,
        ak.rate_limit_per_minute,
        ak.rate_limit_per_hour,
        ak.expires_at,
        ak.description,
        COUNT(aku.id) as recent_requests
      FROM api_keys ak
      LEFT JOIN api_key_usage aku ON ak.id = aku.api_key_id 
        AND aku.created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      WHERE ak.is_active = true
    `;

    const params: any[] = [];
    
    if (keyName) {
      query += ` AND ak.key_name = $1`;
      params.push(keyName);
    }

    query += ` GROUP BY ak.id, ak.key_name, ak.usage_count, ak.last_used_at, ak.created_at, ak.permissions, ak.is_active, ak.rate_limit_per_minute, ak.rate_limit_per_hour, ak.expires_at, ak.description`;
    query += ` ORDER BY ak.created_at DESC`;

    try {
      const result = await this.pool.query(query, params);
      
      // Traiter les résultats pour parser les permissions JSON
      return result.rows.map(row => ({
        ...row,
        permissions: Array.isArray(row.permissions) ? row.permissions : JSON.parse(row.permissions || '[]'),
        recent_requests: parseInt(row.recent_requests)
      }));
    } catch (error) {
      logger.error('Failed to get usage stats', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return [];
    }
  }

  // Obtenir les détails d'une API key spécifique (sans exposer la clé)
  async getApiKeyDetails(keyName: string): Promise<Omit<ApiKey, 'apiKey'> | null> {
    const query = `
      SELECT id, key_name, permissions, is_active, 
             rate_limit_per_hour, rate_limit_per_minute, last_used_at, 
             usage_count, expires_at, description, created_at
      FROM api_keys 
      WHERE key_name = $1
    `;

    try {
      const result = await this.pool.query(query, [keyName]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        id: row.id,
        keyName: row.key_name,
        permissions: Array.isArray(row.permissions) ? row.permissions : JSON.parse(row.permissions || '[]'),
        isActive: row.is_active,
        rateLimitPerHour: row.rate_limit_per_hour,
        rateLimitPerMinute: row.rate_limit_per_minute,
        lastUsedAt: row.last_used_at,
        usageCount: row.usage_count,
        expiresAt: row.expires_at,
        description: row.description
      } as Omit<ApiKey, 'apiKey'>;
    } catch (error) {
      logger.error('Failed to get API key details', { 
        keyName, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return null;
    }
  }

  // Mettre à jour les permissions d'une API key
  async updateApiKeyPermissions(keyName: string, newPermissions: string[]): Promise<boolean> {
    const query = `
      UPDATE api_keys 
      SET permissions = $1, updated_at = CURRENT_TIMESTAMP
      WHERE key_name = $2 AND is_active = true
    `;

    try {
      const result = await this.pool.query(query, [JSON.stringify(newPermissions), keyName]);
      const updated = (result.rowCount ?? 0) > 0;
      
      if (updated) {
        logger.info('API key permissions updated', { keyName, newPermissions });
      }
      
      return updated;
    } catch (error) {
      logger.error('Failed to update API key permissions', { 
        keyName, 
        newPermissions, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // Mettre à jour les limites de taux d'une API key
  async updateApiKeyRateLimits(keyName: string, rateLimitPerHour: number, rateLimitPerMinute: number): Promise<boolean> {
    const query = `
      UPDATE api_keys 
      SET rate_limit_per_hour = $1, rate_limit_per_minute = $2, updated_at = CURRENT_TIMESTAMP
      WHERE key_name = $3 AND is_active = true
    `;

    try {
      const result = await this.pool.query(query, [rateLimitPerHour, rateLimitPerMinute, keyName]);
      const updated = (result.rowCount ?? 0) > 0;
      
      if (updated) {
        logger.info('API key rate limits updated', { keyName, rateLimitPerHour, rateLimitPerMinute });
      }
      
      return updated;
    } catch (error) {
      logger.error('Failed to update API key rate limits', { 
        keyName, 
        rateLimitPerHour, 
        rateLimitPerMinute, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // Nettoyer les anciens logs d'usage (à appeler périodiquement)
  async cleanupOldUsageLogs(): Promise<number> {
    const query = `
      DELETE FROM api_key_usage 
      WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '7 days'
    `;

    try {
      const result = await this.pool.query(query);
      const deletedCount = result.rowCount ?? 0;
      
      if (deletedCount > 0) {
        logger.info('Cleaned up old API usage logs', { deletedCount });
      }
      
      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup old usage logs', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return 0;
    }
  }

  // Obtenir les endpoints les plus utilisés
  async getTopEndpoints(limit: number = 10): Promise<Array<{endpoint: string, totalRequests: number}>> {
    const query = `
      SELECT endpoint, SUM(request_count) as total_requests
      FROM api_key_usage 
      WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
      GROUP BY endpoint
      ORDER BY total_requests DESC
      LIMIT $1
    `;

    try {
      const result = await this.pool.query(query, [limit]);
      return result.rows.map(row => ({
        endpoint: row.endpoint,
        totalRequests: parseInt(row.total_requests)
      }));
    } catch (error) {
      logger.error('Failed to get top endpoints', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return [];
    }
  }

  // Générer une clé aléatoire sécurisée
  private generateRandomKey(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // Valider le format d'une permission
  static isValidPermission(permission: string): boolean {
    const validPermissions = [
      'player:read', 'player:write', 'player:*',
      'zone:read', 'zone:write', 'zone:*',
      'chunk:read', 'stats:read', 'batch:manage',
      'admin:*', 'api:read', '*'
    ];
    
    return validPermissions.includes(permission);
  }

  // Obtenir toutes les permissions disponibles
  static getAvailablePermissions(): Record<string, string[]> {
    return {
      player: ['player:read', 'player:write', 'player:*'],
      zone: ['zone:read', 'zone:write', 'zone:*'],
      chunk: ['chunk:read'],
      stats: ['stats:read'],
      admin: ['admin:*'],
      batch: ['batch:manage'],
      api: ['api:read'],
      all: ['*']
    };
  }
}