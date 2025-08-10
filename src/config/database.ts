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
        connectionTimeoutMillis: 5000
      };

      DatabaseConfig.instance = new Pool(config);

      DatabaseConfig.instance.on('connect', (client) => {
        logger.debug('Nouvelle connexion PostgreSQL établie');
        
        // Configuration de session par défaut - CORRECTION
        client.query("SET application_name = 'minecraft-zones-backend'")
          .catch(err => logger.warn('Erreur configuration session:', err));
      });

      DatabaseConfig.instance.on('acquire', () => {
        logger.debug('Connexion PostgreSQL acquise du pool');
      });

      DatabaseConfig.instance.on('release', () => {
        logger.debug('Connexion PostgreSQL retournée au pool');
      });

      DatabaseConfig.instance.on('error', (err, client) => {
        logger.error('Erreur PostgreSQL:', err);
        if (client) {
          logger.error('Client en erreur, suppression du pool');
        }
      });

      DatabaseConfig.instance.on('remove', () => {
        logger.debug('Connexion PostgreSQL supprimée du pool');
      });
    }

    return DatabaseConfig.instance;
  }

  static async testConnection(): Promise<boolean> {
    try {
      const pool = DatabaseConfig.getInstance();
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch (error) {
      logger.error('Test connexion PostgreSQL échoué:', error);
      return false;
    }
  }

  static getPoolStats(): {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  } {
    if (!DatabaseConfig.instance) {
      return { totalCount: 0, idleCount: 0, waitingCount: 0 };
    }

    return {
      totalCount: DatabaseConfig.instance.totalCount,
      idleCount: DatabaseConfig.instance.idleCount,
      waitingCount: DatabaseConfig.instance.waitingCount
    };
  }

  static async closeAll(): Promise<void> {
    if (DatabaseConfig.instance) {
      try {
        await DatabaseConfig.instance.end();
        logger.info('Pool PostgreSQL fermé');
      } catch (error) {
        logger.error('Erreur fermeture pool PostgreSQL:', error);
      } finally {
        DatabaseConfig.instance = null as any;
      }
    }
  }
}