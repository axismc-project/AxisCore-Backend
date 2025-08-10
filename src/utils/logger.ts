import winston from 'winston';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

const logLevel = process.env.LOG_LEVEL || 'info';
const serviceName = process.env.SERVICE_NAME || 'minecraft-zones-backend';
const environment = process.env.NODE_ENV || 'development';
const lokiUrl = process.env.LOKI_URL;
const logFile = process.env.LOG_FILE || 'logs/app.log';

// Create logs directory if it doesn't exist
async function ensureLogDirectory(): Promise<void> {
  try {
    await mkdir(dirname(logFile), { recursive: true });
    await mkdir('logs', { recursive: true });
  } catch (error) {
    console.warn('Unable to create logs directory:', error);
  }
}

// Initialize log directory (only in development)
if (environment === 'development') {
  ensureLogDirectory().catch(console.warn);
}

const format = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transports: winston.transport[] = [
  // Console transport (always active)
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
    handleExceptions: true,
    handleRejections: true
  })
];

// Add file transports only in development
if (environment === 'development') {
  transports.push(
    new winston.transports.File({
      filename: logFile,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      handleExceptions: true,
      handleRejections: true
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10485760,
      maxFiles: 5
    })
  );
}

export const logger = winston.createLogger({
  level: logLevel,
  format,
  defaultMeta: { 
    service: serviceName,
    environment,
    version: process.env.npm_package_version || '1.0.0',
    instance: process.env.RAILWAY_SERVICE_NAME || process.env.HOSTNAME || 'local'
  },
  transports,
  exitOnError: false
});

// Add Loki transport ONLY in production AND with valid URL
if (environment === 'production' && lokiUrl) {
  logger.info('Attempting to configure Loki transport', { lokiUrl });
  
  // Dynamic import to avoid loading winston-loki in development
  import('winston-loki').then((LokiModule) => {
    const LokiTransport = LokiModule.default;
    
    try {
      const lokiTransport = new LokiTransport({
        host: lokiUrl,
        labels: { 
          service: serviceName,
          environment,
          instance: process.env.RAILWAY_SERVICE_NAME || process.env.HOSTNAME || 'unknown',
          version: process.env.npm_package_version || '1.0.0'
        },
        json: true,
        format: winston.format.json(),
        replaceTimestamp: true,
        timeout: 10000,
        batching: true,
        interval: 5000,
        onConnectionError: (err: Error) => {
          console.error('Loki connection error:', err.message);
          // Don't throw, just log the error
        }
      });
      
      logger.add(lokiTransport);
      logger.info('Loki transport configured successfully');
    } catch (error) {
      console.warn('Failed to create Loki transport:', error);
    }
  }).catch((error) => {
    console.warn('winston-loki module not available:', error.message);
  });
} else {
  const reason = environment !== 'production' 
    ? `Environment is ${environment} (need production)` 
    : 'No LOKI_URL provided';
  
  logger.info('Loki transport disabled', { reason });
}

// Handle uncaught exceptions and rejections
if (environment === 'development') {
  logger.exceptions.handle(
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  );
  
  logger.rejections.handle(
    new winston.transports.File({ filename: 'logs/rejections.log' })
  );
} else {
  logger.exceptions.handle(
    new winston.transports.Console({
      format: winston.format.simple()
    })
  );
  
  logger.rejections.handle(
    new winston.transports.Console({
      format: winston.format.simple()
    })
  );
}