import { Pool, PoolConfig } from 'pg';
import { logger } from '../utils/logger';

export class DatabaseConfig {
  private static instance: Pool;

  static getInstance(): Pool {
    if (!DatabaseConfig.instance) {
      const config: PoolConfig = {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        min: parseInt(process.env.DB_POOL_MIN || '5'),
        max: parseInt(process.env.DB_POOL_MAX || '20'),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      };

      DatabaseConfig.instance = new Pool(config);

      DatabaseConfig.instance.on('connect', () => {
        logger.debug('Nouvelle connexion PostgreSQL établie');
      });

      DatabaseConfig.instance.on('error', (err) => {
        logger.error('Erreur PostgreSQL:', err);
      });
    }

    return DatabaseConfig.instance;
  }

  static async closeAll(): Promise<void> {
    if (DatabaseConfig.instance) {
      await DatabaseConfig.instance.end();
      logger.info('Pool PostgreSQL fermé');
    }
  }
}