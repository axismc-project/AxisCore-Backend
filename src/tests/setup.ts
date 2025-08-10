// Configuration globale des tests
import { logger } from '../utils/logger';

// Désactiver les logs pendant les tests
logger.transports.forEach(transport => {
  transport.silent = true;
});

// Configuration des timeouts avec déclaration globale
declare global {
  namespace jest {
    interface Global {
      setTimeout: (timeout: number) => void;
    }
  }
  
  var afterEach: (fn: () => void | Promise<void>) => void;
  var jest: {
    setTimeout: (timeout: number) => void;
    clearAllMocks: () => void;
    fn: () => any;
  };
}

// Configuration des timeouts
(global as any).jest = {
  setTimeout: (timeout: number) => {
    // Configuration Jest
  },
  clearAllMocks: () => {
    // Clear mocks
  },
  fn: () => () => {}
};

// Variables d'environnement pour les tests
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/minecraft_zones_test';
process.env.CACHE_TTL_CHUNKS = '3600';
process.env.CACHE_TTL_ZONES = '1800';
process.env.CHUNK_MIN = '-100';
process.env.CHUNK_MAX = '100';
process.env.PRECOMPUTE_BATCH_SIZE = '100';

// Nettoyer après chaque test
if (typeof afterEach !== 'undefined') {
  afterEach(async () => {
    // Nettoyer les mocks si nécessaire
    if (global.jest && global.jest.clearAllMocks) {
      global.jest.clearAllMocks();
    }
  });
}

// Configuration globale des mocks
global.console = {
  ...console,
  // Garder seulement error et warn en test
  log: () => {},
  info: () => {},
  debug: () => {},
  warn: console.warn,
  error: console.error,
};