// Global test configuration
import { logger } from '../utils/logger';

// Disable logs during tests
logger.transports.forEach(transport => {
  transport.silent = true;
});

// Test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/minecraft_zones_test';
process.env.CACHE_TTL_CHUNKS = '3600';
process.env.CACHE_TTL_ZONES = '1800';
process.env.CHUNK_MIN = '-100';
process.env.CHUNK_MAX = '100';
process.env.PRECOMPUTE_BATCH_SIZE = '100';

// Global console mock configuration
global.console = {
  ...console,
  // Keep only error and warn in tests
  log: () => {},
  info: () => {},
  debug: () => {},
  warn: console.warn,
  error: console.error,
};