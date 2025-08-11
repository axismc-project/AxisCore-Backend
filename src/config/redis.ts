import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export class RedisConfig {
  private static client: RedisClientType;
  private static publisher: RedisClientType;
  private static subscriber: RedisClientType;

  static async getClient(): Promise<RedisClientType> {
    if (!RedisConfig.client) {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error('REDIS_URL environment variable is required');
      }

      RedisConfig.client = createClient({
        url: redisUrl,
        password: process.env.REDIS_PASSWORD || undefined,
        database: parseInt(process.env.REDIS_DB || '0'),
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 50, 1000)
        }
      });

      RedisConfig.client.on('error', (err) => {
        logger.error('Erreur Redis Client:', err);
      });

      RedisConfig.client.on('connect', () => {
        logger.debug('Redis Client connecté');
      });

      await RedisConfig.client.connect();
    }

    return RedisConfig.client;
  }

  static async getPublisher(): Promise<RedisClientType> {
    if (!RedisConfig.publisher) {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error('REDIS_URL environment variable is required');
      }

      RedisConfig.publisher = createClient({
        url: redisUrl,
        password: process.env.REDIS_PASSWORD || undefined,
        database: parseInt(process.env.REDIS_DB || '0')
      });

      await RedisConfig.publisher.connect();
      logger.debug('Redis Publisher connecté');
    }

    return RedisConfig.publisher;
  }

  static async getSubscriber(): Promise<RedisClientType> {
    if (!RedisConfig.subscriber) {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error('REDIS_URL environment variable is required');
      }

      RedisConfig.subscriber = createClient({
        url: redisUrl,
        password: process.env.REDIS_PASSWORD || undefined,
        database: parseInt(process.env.REDIS_DB || '0')
      });

      await RedisConfig.subscriber.connect();
      logger.debug('Redis Subscriber connecté');
    }

    return RedisConfig.subscriber;
  }

  

  static async closeAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (RedisConfig.client) {
      promises.push(RedisConfig.client.quit().then(() => {}));
    }
    if (RedisConfig.publisher) {
      promises.push(RedisConfig.publisher.quit().then(() => {}));
    }
    if (RedisConfig.subscriber) {
      promises.push(RedisConfig.subscriber.quit().then(() => {}));
    }

    await Promise.all(promises);
    logger.info('Connexions Redis fermées');
  }
}