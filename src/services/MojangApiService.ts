// src/services/MojangApiService.ts
import { logger } from '../utils/logger';

export interface MojangProfile {
  id: string;
  name: string;
}

export interface MojangApiResponse {
  id: string;
  name: string;
}

export class MojangApiService {
  private static readonly MOJANG_API_BASE = 'https://api.mojang.com';
  private static readonly REQUEST_TIMEOUT = 5000;
  private static readonly CACHE_TTL = 300000; // 5 minutes
  private static readonly uuidCache = new Map<string, { uuid: string; timestamp: number }>();

  static async getPlayerUUIDByUsername(username: string): Promise<string | null> {
    if (!this.isValidUsername(username)) {
      throw new Error(`Invalid username format: ${username}`);
    }

    const cleanUsername = this.sanitizeUsername(username);
    
    // Check cache first
    const cached = this.getCachedUUID(cleanUsername);
    if (cached) {
      logger.debug('🎯 Mojang UUID found in cache', { 
        username: cleanUsername,
        uuid: cached.substring(0, 8) + '...'
      });
      return cached;
    }

    try {
      logger.info('🔍 Fetching UUID from Mojang API', { username: cleanUsername });

      const response = await this.makeApiRequest(cleanUsername);
      
      if (!response) {
        logger.warn('👤 Player not found on Mojang servers', { username: cleanUsername });
        return null;
      }

      const formattedUuid = this.formatMojangUUID(response.id);
      
      // Cache the result
      this.cacheUUID(cleanUsername, formattedUuid);

      logger.info('✅ UUID retrieved from Mojang API', { 
        username: cleanUsername, 
        uuid: formattedUuid.substring(0, 8) + '...',
        mojangName: response.name
      });

      return formattedUuid;

    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.error('⏰ Mojang API request timeout', { username: cleanUsername });
          throw new Error(`Mojang API timeout for username: ${cleanUsername}`);
        }
        
        logger.error('❌ Mojang API error', { 
          username: cleanUsername, 
          error: error.message 
        });
        throw error;
      }
      
      throw new Error(`Unknown error fetching UUID for username: ${cleanUsername}`);
    }
  }

  private static async makeApiRequest(username: string): Promise<MojangApiResponse | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);

    try {
      const url = `${this.MOJANG_API_BASE}/users/profiles/minecraft/${encodeURIComponent(username)}`;
      
      logger.debug('🌐 Making Mojang API request', { url, timeout: this.REQUEST_TIMEOUT });

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'MinecraftZonesBackend/2.0.0',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate'
        }
      });

      clearTimeout(timeoutId);

      if (response.status === 404) {
        return null; // Player not found
      }

      if (response.status === 429) {
        throw new Error('Mojang API rate limit exceeded - please try again later');
      }

      if (!response.ok) {
        throw new Error(`Mojang API HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(`Invalid response content type: ${contentType}`);
      }

      const data: unknown = await response.json();
      
      if (!this.isValidMojangProfile(data)) {
        throw new Error('Invalid response format from Mojang API');
      }
      
      return data;

    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  private static isValidUsername(username: string): boolean {
    if (!username || typeof username !== 'string') {
      return false;
    }
    
    const trimmed = username.trim();
    
    // Minecraft username rules: 3-16 characters, alphanumeric + underscore only
    return /^[a-zA-Z0-9_]{3,16}$/.test(trimmed);
  }

  private static sanitizeUsername(username: string): string {
    return username.trim().replace(/[^\w]/g, '').substring(0, 16);
  }

  private static isValidMojangProfile(data: unknown): data is MojangApiResponse {
    return (
      typeof data === 'object' &&
      data !== null &&
      'id' in data &&
      'name' in data &&
      typeof (data as any).id === 'string' &&
      typeof (data as any).name === 'string' &&
      (data as any).id.length === 32 && // Mojang UUIDs are 32 hex chars without dashes
      /^[0-9a-f]{32}$/i.test((data as any).id) &&
      (data as any).name.length >= 3 &&
      (data as any).name.length <= 16
    );
  }

  private static formatMojangUUID(mojangUuid: string): string {
    if (!mojangUuid || mojangUuid.length !== 32) {
      throw new Error(`Invalid Mojang UUID format: ${mojangUuid}`);
    }

    if (!/^[0-9a-f]{32}$/i.test(mojangUuid)) {
      throw new Error(`Invalid Mojang UUID characters: ${mojangUuid}`);
    }

    // Convert to standard UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    return [
      mojangUuid.slice(0, 8),
      mojangUuid.slice(8, 12),
      mojangUuid.slice(12, 16),
      mojangUuid.slice(16, 20),
      mojangUuid.slice(20, 32)
    ].join('-').toLowerCase();
  }

  // ========== CACHING ==========
  
  private static getCachedUUID(username: string): string | null {
    const cached = this.uuidCache.get(username.toLowerCase());
    
    if (!cached) {
      return null;
    }
    
    // Check if cache is still valid
    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.uuidCache.delete(username.toLowerCase());
      logger.debug('🗑️ Expired UUID cache entry removed', { username });
      return null;
    }
    
    return cached.uuid;
  }

  private static cacheUUID(username: string, uuid: string): void {
    this.uuidCache.set(username.toLowerCase(), {
      uuid,
      timestamp: Date.now()
    });
    
    logger.debug('💾 UUID cached', { 
      username, 
      uuid: uuid.substring(0, 8) + '...',
      cacheSize: this.uuidCache.size
    });
    
    // Cleanup old cache entries if cache gets too large
    if (this.uuidCache.size > 1000) {
      this.cleanupCache();
    }
  }

  private static cleanupCache(): void {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [username, entry] of this.uuidCache.entries()) {
      if (now - entry.timestamp > this.CACHE_TTL) {
        this.uuidCache.delete(username);
        cleanedCount++;
      }
    }
    
    logger.debug('🧹 UUID cache cleaned', { 
      removed: cleanedCount,
      remaining: this.uuidCache.size
    });
  }

  // ========== VALIDATION UTILITIES ==========
  
  static isValidUUID(uuid: string): boolean {
    if (!uuid || typeof uuid !== 'string') {
      return false;
    }

    const trimmed = uuid.trim();
    
    // Standard UUID format with dashes
    const uuidWithDashesRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    // Mojang format without dashes
    const uuidWithoutDashesRegex = /^[0-9a-f]{32}$/i;
    
    return uuidWithDashesRegex.test(trimmed) || uuidWithoutDashesRegex.test(trimmed);
  }

  static normalizeUUID(uuid: string): string {
    if (!uuid || typeof uuid !== 'string') {
      return uuid;
    }
    
    const cleaned = uuid.trim().replace(/-/g, '').toLowerCase();
    
    if (!/^[0-9a-f]{32}$/i.test(cleaned)) {
      return uuid.trim(); // Return original if invalid
    }
    
    return this.formatMojangUUID(cleaned);
  }

  // ========== BATCH OPERATIONS ==========
  
  static async getMultiplePlayerUUIDs(usernames: string[]): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    const batchSize = 10; // Limit concurrent requests to avoid rate limiting
    
    logger.info('📋 Batch UUID lookup started', { 
      usernames: usernames.length,
      batchSize
    });
    
    for (let i = 0; i < usernames.length; i += batchSize) {
      const batch = usernames.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (username) => {
        try {
          const uuid = await this.getPlayerUUIDByUsername(username);
          return { username, uuid };
        } catch (error) {
          logger.warn('⚠️ Failed to get UUID for username', { 
            username,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          return { username, uuid: null };
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          results.set(result.value.username, result.value.uuid);
        }
      });
      
      // Rate limiting delay between batches
      if (i + batchSize < usernames.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    logger.info('✅ Batch UUID lookup completed', { 
      total: usernames.length,
      successful: Array.from(results.values()).filter(uuid => uuid !== null).length,
      failed: Array.from(results.values()).filter(uuid => uuid === null).length
    });
    
    return results;
  }

  // ========== HEALTH CHECK ==========
  
  static async testConnection(): Promise<boolean> {
    try {
      logger.info('🧪 Testing Mojang API connection...');
      
      // Test with a well-known username that should exist
      const testResult = await this.getPlayerUUIDByUsername('Notch');
      const isHealthy = testResult !== null;
      
      logger.info('🧪 Mojang API connection test result', { 
        healthy: isHealthy,
        testUsername: 'Notch',
        foundUuid: isHealthy
      });
      
      return isHealthy;
    } catch (error) {
      logger.error('❌ Mojang API connection test failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }

  // ========== STATISTICS ==========
  
  static getStats(): {
    cacheSize: number;
    cacheHitRate: number;
    lastCleanup: Date | null;
  } {
    return {
      cacheSize: this.uuidCache.size,
      cacheHitRate: 0, // Would need tracking to implement properly
      lastCleanup: null // Would need tracking to implement properly
    };
  }

  // ========== CLEANUP ==========
  
  static clearCache(): void {
    const size = this.uuidCache.size;
    this.uuidCache.clear();
    logger.info('🗑️ Mojang UUID cache cleared', { previousSize: size });
  }
}