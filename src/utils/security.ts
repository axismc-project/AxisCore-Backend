import crypto from 'crypto';

export class SecurityUtils {
  /**
   * Timing-safe string comparison to prevent timing attacks
   */
  static timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    
    try {
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }

  /**
   * Validate UUID format
   */
  static isValidUUID(uuid: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Validate Redis pattern to prevent injection
   */
  static isValidRedisPattern(pattern: string): boolean {
    // Allow only specific patterns for chunk zones
    return /^chunk:zone:[*\d:-]+$/.test(pattern);
  }

  /**
   * Sanitize player name
   */
  static sanitizePlayerName(name: string): string {
    return name.replace(/[^\w\-_.]/g, '').substring(0, 16);
  }

  /**
   * Validate coordinates are within reasonable bounds
   */
  static isValidCoordinate(coord: number, min: number = -30000000, max: number = 30000000): boolean {
    return Number.isFinite(coord) && coord >= min && coord <= max;
  }

  /**
   * Validate chunk coordinates
   */
  static isValidChunkCoordinate(chunkCoord: number): boolean {
    const minChunk = parseInt(process.env.CHUNK_MIN || '-2000');
    const maxChunk = parseInt(process.env.CHUNK_MAX || '2000');
    return Number.isInteger(chunkCoord) && chunkCoord >= minChunk && chunkCoord <= maxChunk;
  }
}