import { logger } from '../utils/logger';

export interface MojangProfile {
  id: string;
  name: string;
}

export class MojangApiService {
  private static readonly MOJANG_API_BASE = 'https://api.mojang.com';
  private static readonly REQUEST_TIMEOUT = 5000;

  static async getPlayerUUIDByUsername(username: string): Promise<string | null> {
    if (!username || typeof username !== 'string' || username.length === 0) {
      throw new Error('Username is required');
    }

    const cleanUsername = username.replace(/[^\w]/g, '').substring(0, 16);
    if (cleanUsername.length < 3) {
      throw new Error('Invalid username format');
    }

    try {
      logger.info('🔍 Fetching UUID from Mojang API', { username: cleanUsername });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);

      const response = await fetch(
        `${this.MOJANG_API_BASE}/users/profiles/minecraft/${encodeURIComponent(cleanUsername)}`,
        {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': 'MinecraftZonesBackend/1.0.0',
            'Accept': 'application/json'
          }
        }
      );

      clearTimeout(timeoutId);

      if (response.status === 404) {
        logger.warn('👤 Player not found on Mojang', { username: cleanUsername });
        return null;
      }

      if (!response.ok) {
        throw new Error(`Mojang API error: ${response.status} ${response.statusText}`);
      }

      // ✅ FIX: Typage correct pour response.json()
      const profileData = await response.json() as unknown;
      
      // ✅ FIX: Validation du format avant cast
      if (!this.isValidMojangProfile(profileData)) {
        throw new Error('Invalid response format from Mojang API');
      }
      
      const profile = profileData as MojangProfile;
      
      if (!profile.id || !profile.name) {
        throw new Error('Invalid response from Mojang API');
      }

      const formattedUuid = this.formatMojangUUID(profile.id);

      logger.info('✅ UUID retrieved from Mojang', { 
        username: cleanUsername, 
        playerUuid: formattedUuid,
        mojangName: profile.name
      });

      return formattedUuid;

    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.error('⏰ Mojang API request timeout', { username: cleanUsername });
          throw new Error('Mojang API request timeout');
        }
        
        logger.error('❌ Mojang API error', { 
          username: cleanUsername, 
          error: error.message 
        });
        throw error;
      }
      
      throw new Error('Unknown error occurred while fetching from Mojang API');
    }
  }

  // ✅ FIX: Nouvelle méthode de validation
  private static isValidMojangProfile(data: unknown): data is MojangProfile {
    return (
      typeof data === 'object' &&
      data !== null &&
      'id' in data &&
      'name' in data &&
      typeof (data as any).id === 'string' &&
      typeof (data as any).name === 'string'
    );
  }

  private static formatMojangUUID(mojangUuid: string): string {
    if (!mojangUuid || mojangUuid.length !== 32) {
      throw new Error('Invalid Mojang UUID format');
    }

    return [
      mojangUuid.slice(0, 8),
      mojangUuid.slice(8, 12),
      mojangUuid.slice(12, 16),
      mojangUuid.slice(16, 20),
      mojangUuid.slice(20, 32)
    ].join('-').toLowerCase();
  }

  static isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  static async testConnection(): Promise<boolean> {
    try {
      const testUuid = await this.getPlayerUUIDByUsername('Notch');
      return testUuid !== null;
    } catch (error) {
      logger.error('Mojang API connection test failed', { 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      return false;
    }
  }
}