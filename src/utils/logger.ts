import winston from 'winston';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';

const logLevel = process.env.LOG_LEVEL || 'info';
const logFile = process.env.LOG_FILE || 'logs/app.log';

// Créer le dossier logs s'il n'existe pas
async function ensureLogDirectory(): Promise<void> {
  try {
    await mkdir(dirname(logFile), { recursive: true });
    await mkdir('logs', { recursive: true });
  } catch (error) {
    console.warn('Impossible de créer le dossier logs:', error);
  }
}

// Initialiser le dossier
ensureLogDirectory().catch(console.warn);

export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'minecraft-zones-backend' },
  transports: [
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
      maxFiles: 5,
      handleExceptions: true,
      handleRejections: true
    })
  ],
  exitOnError: false
});

// Console en développement avec gestion d'erreurs
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
    handleExceptions: true,
    handleRejections: true
  }));
}

// Gestion des erreurs non capturées
logger.exceptions.handle(
  new winston.transports.File({ filename: 'logs/exceptions.log' })
);

logger.rejections.handle(
  new winston.transports.File({ filename: 'logs/rejections.log' })
);