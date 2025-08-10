import { DatabaseService } from './DatabaseService';
import { RedisService } from './RedisService';
import { ChunkCalculatorService } from './ChunkCalculatorService';
import { Region, Node, City, PostgresNotification } from '../models/Zone';
import { logger } from '../utils/logger';

export class ZoneSyncService {
  private isInitialized = false;
  private lastSyncTime: Date | null = null;
  private syncInProgress = false;

  constructor(
    private db: DatabaseService,
    private redis: RedisService,
    private calculator: ChunkCalculatorService
  ) {}

  async init(): Promise<void> {
    if (this.isInitialized) return;

    logger.info('🔄 Initialisation ZoneSyncService...');
    
    try {
      // Synchronisation complète initiale
      await this.fullSync();
      
      // Démarrer l'écoute des changements
      await this.startIncrementalSync();
      
      // Programmer le nettoyage automatique
      this.scheduleCleanup();
      
      this.isInitialized = true;
      logger.info('✅ ZoneSyncService initialisé avec succès');
    } catch (error) {
      logger.error('❌ Erreur initialisation ZoneSyncService:', error);
      throw new Error('Impossible d\'initialiser le service de synchronisation');
    }
  }

  // ========== SYNCHRONISATION COMPLÈTE ==========
  async fullSync(): Promise<{
    duration: number;
    regionsCount: number;
    nodesCount: number;
    citiesCount: number;
    chunksProcessed: number;
  }> {
    if (this.syncInProgress) {
      throw new Error('Une synchronisation est déjà en cours');
    }

    this.syncInProgress = true;
    const startTime = Date.now();
    
    try {
      logger.info('🔄 Début synchronisation complète...');
      
      // 1. Charger toutes les zones depuis PostgreSQL
      const [regions, nodes, cities] = await Promise.all([
        this.db.getAllRegions(),
        this.db.getAllNodes(),
        this.db.getAllCities()
      ]);

      logger.info(`📦 Chargé ${regions.length} régions, ${nodes.length} nodes, ${cities.length} villes`);

      // 2. Valider les données
      await this.validateZonesData(regions, nodes, cities);

      // 3. Pré-calculer tous les chunks
      const chunksProcessed = await this.precomputeAllChunks(regions, nodes, cities);

      // 4. Mettre en cache les métadonnées des zones
      await this.cacheZoneMetadata(regions, nodes, cities);

      const duration = Date.now() - startTime;
      this.lastSyncTime = new Date();
      
      logger.info(`✅ Synchronisation terminée en ${duration}ms - ${chunksProcessed} chunks traités`);
      
      return {
        duration,
        regionsCount: regions.length,
        nodesCount: nodes.length,
        citiesCount: cities.length,
        chunksProcessed
      };
    } catch (error) {
      logger.error('❌ Erreur synchronisation complète:', error);
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }

  private async validateZonesData(regions: Region[], nodes: Node[], cities: City[]): Promise<void> {
    logger.info('🔍 Validation des données de zones...');
    
    // Valider les polygones
    for (const region of regions) {
      const validation = this.calculator.validatePolygon(region.chunk_boundary);
      if (!validation.valid) {
        throw new Error(`Région ${region.name} invalide: ${validation.error}`);
      }
    }

    for (const node of nodes) {
      const validation = this.calculator.validatePolygon(node.chunk_boundary);
      if (!validation.valid) {
        throw new Error(`Node ${node.name} invalide: ${validation.error}`);
      }
    }

    for (const city of cities) {
      const validation = this.calculator.validatePolygon(city.chunk_boundary);
      if (!validation.valid) {
        throw new Error(`Ville ${city.name} invalide: ${validation.error}`);
      }
    }

    // Valider les relations hiérarchiques
    const regionIds = new Set(regions.map(r => r.id));
    for (const node of nodes) {
      if (!regionIds.has(node.region_id)) {
        throw new Error(`Node ${node.name} référence une région inexistante: ${node.region_id}`);
      }
    }

    const nodeIds = new Set(nodes.map(n => n.id));
    for (const city of cities) {
      if (!nodeIds.has(city.node_id)) {
        throw new Error(`Ville ${city.name} référence un node inexistant: ${city.node_id}`);
      }
    }

    logger.info('✅ Validation des données terminée');
  }

  private async precomputeAllChunks(regions: Region[], nodes: Node[], cities: City[]): Promise<number> {
    const minChunk = parseInt(process.env.CHUNK_MIN || '-2000');
    const maxChunk = parseInt(process.env.CHUNK_MAX || '2000');
    const batchSize = parseInt(process.env.PRECOMPUTE_BATCH_SIZE || '10000');
    
    let processedChunks = 0;
    const totalChunks = (maxChunk - minChunk + 1) ** 2;
    
    logger.info(`🔢 Calcul de ${totalChunks.toLocaleString()} chunks...`);

    // Traitement par batch pour éviter de surcharger la mémoire
    const chunkPromises: Promise<void>[] = [];
    
    for (let chunkX = minChunk; chunkX <= maxChunk; chunkX++) {
      for (let chunkZ = minChunk; chunkZ <= maxChunk; chunkZ++) {
        chunkPromises.push(this.processChunk(chunkX, chunkZ, regions, nodes, cities));
        
        // Traiter par batch
        if (chunkPromises.length >= batchSize) {
          await Promise.all(chunkPromises);
chunkPromises.length = 0;
         
         processedChunks += batchSize;
         if (processedChunks % 50000 === 0) {
           const progress = Math.round((processedChunks / totalChunks) * 100);
           logger.info(`📊 Traité ${processedChunks.toLocaleString()}/${totalChunks.toLocaleString()} chunks (${progress}%)`);
         }
       }
     }
   }
   
   // Traiter le dernier batch
   if (chunkPromises.length > 0) {
     await Promise.all(chunkPromises);
     processedChunks += chunkPromises.length;
   }

   logger.info(`🎯 Pré-calcul terminé: ${processedChunks.toLocaleString()} chunks traités`);
   return processedChunks;
 }

 private async processChunk(
   chunkX: number, 
   chunkZ: number, 
   regions: Region[], 
   nodes: Node[], 
   cities: City[]
 ): Promise<void> {
   try {
     const zoneData = this.calculator.calculateChunkZones(chunkX, chunkZ, regions, nodes, cities);
     
     // Sauvegarder seulement si le chunk appartient à une zone
     if (zoneData.regionId) {
       await this.redis.setChunkZone(chunkX, chunkZ, zoneData);
     }
   } catch (error) {
     logger.error(`Erreur processChunk (${chunkX}, ${chunkZ}):`, error);
     // Continuer le traitement même en cas d'erreur sur un chunk
   }
 }

 private async cacheZoneMetadata(regions: Region[], nodes: Node[], cities: City[]): Promise<void> {
   logger.info('💾 Mise en cache des métadonnées...');
   
   const promises: Promise<void>[] = [];

   // Cache régions
   for (const region of regions) {
     promises.push(
       this.redis.cacheZoneMetadata('region', region.id, {
         name: region.name,
         description: region.description || '',
         is_active: region.is_active,
         created_at: region.created_at.toISOString()
       })
     );
   }

   // Cache nodes
   for (const node of nodes) {
     promises.push(
       this.redis.cacheZoneMetadata('node', node.id, {
         name: node.name,
         description: node.description || '',
         level: node.node_level,
         region_id: node.region_id,
         experience_points: node.experience_points,
         is_active: node.is_active,
         created_at: node.created_at.toISOString()
       })
     );
   }

   // Cache villes
   for (const city of cities) {
     promises.push(
       this.redis.cacheZoneMetadata('city', city.id, {
         name: city.name,
         description: city.description || '',
         level: city.city_level,
         population: city.population,
         max_population: city.max_population,
         node_id: city.node_id,
         is_active: city.is_active,
         created_at: city.created_at.toISOString()
       })
     );
   }

   await Promise.all(promises);
   logger.info(`💾 Métadonnées mises en cache: ${promises.length} zones`);
 }

 // ========== SYNCHRONISATION INCRÉMENTALE ==========
 async startIncrementalSync(): Promise<void> {
   logger.info('👂 Démarrage de la synchronisation incrémentale...');
   
   try {
     await this.db.listenToChanges(async (notification: PostgresNotification) => {
       logger.info(`🔄 Changement détecté: ${notification.operation} sur ${notification.table} (ID: ${notification.id})`);
       
       try {
         await this.handlePostgresNotification(notification);
       } catch (error) {
         logger.error('❌ Erreur traitement notification:', error);
         // Ne pas faire échouer le processus pour une erreur de sync
       }
     });
     
     logger.info('✅ Synchronisation incrémentale démarrée');
   } catch (error) {
     logger.error('❌ Erreur démarrage sync incrémentale:', error);
     throw new Error('Impossible de démarrer la synchronisation incrémentale');
   }
 }

 private async handlePostgresNotification(notification: PostgresNotification): Promise<void> {
   const { table, operation, id } = notification;
   
   switch (operation) {
     case 'INSERT':
     case 'UPDATE':
       await this.handleZoneUpdate(table, id);
       break;
     case 'DELETE':
       await this.handleZoneDelete(table, id);
       break;
     default:
       logger.warn(`Opération inconnue: ${operation}`);
   }
 }

 private async handleZoneUpdate(table: string, zoneId: number): Promise<void> {
   try {
     // 1. Invalider le cache Redis de cette zone
     const zoneType = table.slice(0, -1) as 'region' | 'node' | 'city'; // regions -> region
     await this.redis.invalidateZoneCache(zoneType, zoneId);
     
     // 2. Recharger la zone depuis la DB
     const zone = await this.db.getZoneById(zoneType, zoneId);
     if (!zone) {
       logger.warn(`Zone ${table}:${zoneId} non trouvée après UPDATE`);
       return;
     }

     // 3. Recalculer les chunks affectés
     await this.recalculateZoneChunks(zoneType, zone);
     
     // 4. Mettre à jour le cache métadonnées
     await this.updateZoneMetadataCache(zoneType, zone);
     
     logger.info(`✅ Zone ${table}:${zoneId} mise à jour`);
   } catch (error) {
     logger.error(`Erreur handleZoneUpdate ${table}:${zoneId}:`, error);
     throw error;
   }
 }

 private async handleZoneDelete(table: string, zoneId: number): Promise<void> {
   try {
     const zoneType = table.slice(0, -1) as 'region' | 'node' | 'city';
     
     // 1. Invalider le cache de cette zone
     await this.redis.invalidateZoneCache(zoneType, zoneId);
     
     // 2. Supprimer tous les chunks qui référençaient cette zone
     let deletedChunks = 0;
     
     if (zoneType === 'region') {
       deletedChunks = await this.redis.deleteChunkZonesByPattern(`chunk:zone:*`);
       // Après suppression d'une région, tout recalculer
       await this.recalculateAllChunks();
     } else if (zoneType === 'node') {
       // Recalculer les chunks de la région parente
       await this.recalculateNodeParentChunks(zoneId);
     } else if (zoneType === 'city') {
       // Recalculer les chunks du node parent
       await this.recalculateCityParentChunks(zoneId);
     }
     
     logger.info(`🗑️ Zone ${table}:${zoneId} supprimée (${deletedChunks} chunks affectés)`);
   } catch (error) {
     logger.error(`Erreur handleZoneDelete ${table}:${zoneId}:`, error);
     throw error;
   }
 }

 private async recalculateZoneChunks(
   zoneType: 'region' | 'node' | 'city', 
   zone: Region | Node | City
 ): Promise<void> {
   logger.info(`🔄 Recalcul chunks pour ${zoneType}:${zone.id}`);
   
   try {
     // Obtenir tous les chunks dans le polygone de cette zone
     const chunks = this.calculator.getChunksInPolygon(zone.chunk_boundary);
     
     if (zoneType === 'region') {
       // Pour une région, recalculer avec tous les nodes et villes
       const [nodes, cities] = await Promise.all([
         this.db.getAllNodes(),
         this.db.getAllCities()
       ]);
       
       const regionArray = [zone as Region];
       
       for (const chunk of chunks) {
         const zoneData = this.calculator.calculateChunkZones(
           chunk.x, chunk.z, regionArray, nodes, cities
         );
         await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
       }
     } else if (zoneType === 'node') {
       // Pour un node, recalculer avec sa région parent et toutes les villes
       const nodeObj = zone as Node;
       const [region, cities] = await Promise.all([
         this.db.getZoneById('region', nodeObj.region_id),
         this.db.getAllCities()
       ]);
       
       if (!region) {
         throw new Error(`Région parent ${nodeObj.region_id} non trouvée`);
       }
       
       const regions = [region as Region];
       const nodes = [nodeObj];
       
       for (const chunk of chunks) {
         const zoneData = this.calculator.calculateChunkZones(
           chunk.x, chunk.z, regions, nodes, cities
         );
         await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
       }
     } else {
       // Pour une ville, recalculer avec son node et région parents
       const cityObj = zone as City;
       const [node, regions, nodes, cities] = await Promise.all([
         this.db.getZoneById('node', cityObj.node_id),
         this.db.getAllRegions(),
         this.db.getAllNodes(),
         this.db.getAllCities()
       ]);
       
       if (!node) {
         throw new Error(`Node parent ${cityObj.node_id} non trouvé`);
       }
       
       for (const chunk of chunks) {
         const zoneData = this.calculator.calculateChunkZones(
           chunk.x, chunk.z, regions, nodes, cities
         );
         await this.redis.setChunkZone(chunk.x, chunk.z, zoneData);
       }
     }
     
     logger.info(`✅ ${chunks.length} chunks recalculés pour ${zoneType}:${zone.id}`);
   } catch (error) {
     logger.error(`Erreur recalculateZoneChunks ${zoneType}:${zone.id}:`, error);
     throw error;
   }
 }

 private async updateZoneMetadataCache(
   zoneType: 'region' | 'node' | 'city',
   zone: Region | Node | City
 ): Promise<void> {
   let metadata: Record<string, any>;
   
   if (zoneType === 'region') {
     const region = zone as Region;
     metadata = {
       name: region.name,
       description: region.description || '',
       is_active: region.is_active,
       created_at: region.created_at.toISOString()
     };
   } else if (zoneType === 'node') {
     const node = zone as Node;
     metadata = {
       name: node.name,
       description: node.description || '',
       level: node.node_level,
       region_id: node.region_id,
       experience_points: node.experience_points,
       is_active: node.is_active,
       created_at: node.created_at.toISOString()
     };
   } else {
     const city = zone as City;
     metadata = {
       name: city.name,
       description: city.description || '',
       level: city.city_level,
       population: city.population,
       max_population: city.max_population,
       node_id: city.node_id,
       is_active: city.is_active,
       created_at: city.created_at.toISOString()
     };
   }
   
   await this.redis.cacheZoneMetadata(zoneType, zone.id, metadata);
 }

 private async recalculateAllChunks(): Promise<void> {
   logger.warn('🔄 Recalcul complet de tous les chunks...');
   
   try {
     const [regions, nodes, cities] = await Promise.all([
       this.db.getAllRegions(),
       this.db.getAllNodes(),
       this.db.getAllCities()
     ]);
     
     await this.precomputeAllChunks(regions, nodes, cities);
     logger.info('✅ Recalcul complet terminé');
   } catch (error) {
     logger.error('❌ Erreur recalcul complet:', error);
     throw error;
   }
 }

 private async recalculateNodeParentChunks(nodeId: number): Promise<void> {
   // TODO: Implémenter recalcul spécifique pour node supprimé
   logger.info(`🔄 Recalcul chunks après suppression node:${nodeId}`);
   // Pour l'instant, recalcul complet (optimisation future possible)
   await this.recalculateAllChunks();
 }

 private async recalculateCityParentChunks(cityId: number): Promise<void> {
   // TODO: Implémenter recalcul spécifique pour ville supprimée
   logger.info(`🔄 Recalcul chunks après suppression city:${cityId}`);
   // Pour l'instant, recalcul complet (optimisation future possible)
   await this.recalculateAllChunks();
 }

 // ========== NETTOYAGE ET MAINTENANCE ==========
 private scheduleCleanup(): void {
   // Nettoyage automatique toutes les heures
   setInterval(async () => {
     try {
       await this.performCleanup();
     } catch (error) {
       logger.error('Erreur nettoyage automatique:', error);
     }
   }, 60 * 60 * 1000); // 1 heure

   logger.info('🧹 Nettoyage automatique programmé (toutes les heures)');
 }

 async performCleanup(): Promise<{
   deletedPlayers: number;
   deletedChunks: number;
 }> {
   logger.info('🧹 Début nettoyage automatique...');
   
   try {
     const result = await this.redis.cleanupExpiredData();
     
     logger.info(`🧹 Nettoyage terminé: ${result.deletedPlayers} joueurs, ${result.deletedChunks} chunks supprimés`);
     return result;
   } catch (error) {
     logger.error('❌ Erreur nettoyage:', error);
     throw error;
   }
 }

 // ========== DIAGNOSTICS ET MONITORING ==========
 async getHealthStatus(): Promise<{
   isHealthy: boolean;
   lastSyncTime: Date | null;
   syncInProgress: boolean;
   issues: string[];
 }> {
   const issues: string[] = [];
   
   try {
     // Vérifier Redis
     await this.redis.getStats();
   } catch (error) {
     issues.push('Redis inaccessible');
   }
   
   try {
     // Vérifier PostgreSQL
     await this.db.getZoneStats();
   } catch (error) {
     issues.push('PostgreSQL inaccessible');
   }
   
   // Vérifier si la dernière sync n'est pas trop ancienne
   if (this.lastSyncTime) {
     const timeSinceLastSync = Date.now() - this.lastSyncTime.getTime();
     if (timeSinceLastSync > 24 * 60 * 60 * 1000) { // 24 heures
       issues.push('Dernière synchronisation trop ancienne');
     }
   } else {
     issues.push('Aucune synchronisation effectuée');
   }
   
   return {
     isHealthy: issues.length === 0,
     lastSyncTime: this.lastSyncTime,
     syncInProgress: this.syncInProgress,
     issues
   };
 }

 async getDetailedStats(): Promise<{
   database: any;
   redis: any;
   sync: {
     lastSyncTime: Date | null;
     syncInProgress: boolean;
   };
 }> {
   const [dbStats, redisStats] = await Promise.all([
     this.db.getZoneStats(),
     this.redis.getStats()
   ]);
   
   return {
     database: dbStats,
     redis: redisStats,
     sync: {
       lastSyncTime: this.lastSyncTime,
       syncInProgress: this.syncInProgress
     }
   };
 }

 // ========== MÉTHODES PUBLIQUES ==========
 isReady(): boolean {
   return this.isInitialized && !this.syncInProgress;
 }

 getLastSyncTime(): Date | null {
   return this.lastSyncTime;
 }

 isSyncInProgress(): boolean {
   return this.syncInProgress;
 }

 async forceFreshSync(): Promise<void> {
   if (this.syncInProgress) {
     throw new Error('Une synchronisation est déjà en cours');
   }
   
   logger.info('🔄 Synchronisation forcée démarrée...');
   await this.fullSync();
 }
}