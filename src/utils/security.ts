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
   * Validate UUID format (compatible with Minecraft UUIDs)
   * Supports both standard UUID format and Minecraft-specific variations
   * 
   * Minecraft UUIDs can be:
   * - Version 3 (MD5 hash-based, older accounts)
   * - Version 4 (random, most common)
   * - With or without dashes
   * - Case insensitive
   */
  static isValidUUID(uuid: string): boolean {
    if (!uuid || typeof uuid !== 'string') {
      return false;
    }

    // Trim whitespace
    const trimmed = uuid.trim();

    // Regex permissive pour les UUIDs Minecraft
    // Format avec tirets : 8-4-4-4-12 (versions 1-5, variants standard)
    const uuidWithDashesRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    // Format sans tirets (accepté par certains systèmes Minecraft)
    const uuidWithoutDashesRegex = /^[0-9a-f]{32}$/i;
    
    // Format très permissif pour compatibilité maximale (32 caractères hex)
    const hexOnlyRegex = /^[0-9a-f]{32}$/i;
    
    // Si format avec tirets, vérifier la structure UUID standard
    if (trimmed.includes('-')) {
      return uuidWithDashesRegex.test(trimmed);
    }
    
    // Si format sans tirets, vérifier que c'est 32 caractères hex
    return hexOnlyRegex.test(trimmed);
  }

  /**
   * Normalize UUID to standard format (with dashes, lowercase)
   * Convertit tous les formats en format standard : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   */
  static normalizeUUID(uuid: string): string {
    if (!uuid || typeof uuid !== 'string') {
      return uuid;
    }
    
    // Supprimer tous les tirets et espaces, convertir en minuscules
    const cleaned = uuid.trim().replace(/-/g, '').toLowerCase();
    
    // Si ce n'est pas exactement 32 caractères hexadécimaux, retourner tel quel
    if (!/^[0-9a-f]{32}$/i.test(cleaned)) {
      return uuid.trim();
    }
    
    // Reformater avec les tirets au bon endroit : 8-4-4-4-12
    return [
      cleaned.slice(0, 8),
      cleaned.slice(8, 12),
      cleaned.slice(12, 16),
      cleaned.slice(16, 20),
      cleaned.slice(20, 32)
    ].join('-');
  }

  /**
   * Validate and normalize UUID in one step
   * Retourne un objet avec le statut de validation et l'UUID normalisé
   */
  static validateAndNormalizeUUID(uuid: string): { 
    isValid: boolean; 
    normalizedUuid: string; 
    error?: string 
  } {
    if (!SecurityUtils.isValidUUID(uuid)) {
      return {
        isValid: false,
        normalizedUuid: uuid,
        error: 'Invalid UUID format. Expected 32 hexadecimal characters with or without dashes (e.g., xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)'
      };
    }

    return {
      isValid: true,
      normalizedUuid: SecurityUtils.normalizeUUID(uuid)
    };
  }

  /**
   * Validate Redis pattern to prevent injection
   */
  static isValidRedisPattern(pattern: string): boolean {
    // Allow only specific patterns for chunk zones
    return /^chunk:zone:[*\d:-]+$/.test(pattern);
  }

  /**
   * Sanitize player name according to Minecraft rules
   * Minecraft usernames: 3-16 characters, alphanumeric + underscore
   */
  static sanitizePlayerName(name: string): string {
    if (!name || typeof name !== 'string') {
      return '';
    }
    
    // Minecraft usernames: only alphanumeric and underscore, 3-16 characters
    const sanitized = name.replace(/[^\w]/g, '').substring(0, 16);
    
    // Ensure minimum length
    return sanitized.length >= 3 ? sanitized : '';
  }

  /**
   * Validate Minecraft player name
   */
  static isValidPlayerName(name: string): boolean {
    if (!name || typeof name !== 'string') {
      return false;
    }
    
    // Minecraft username rules: 3-16 characters, alphanumeric + underscore
    return /^[a-zA-Z0-9_]{3,16}$/.test(name);
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

  /**
   * Validate world coordinates and convert to chunk coordinates
   */
  static worldToChunk(worldCoord: number): number {
    return Math.floor(worldCoord / 16);
  }

  /**
   * Validate chunk coordinates and convert to world coordinates (center of chunk)
   */
  static chunkToWorld(chunkCoord: number): number {
    return chunkCoord * 16 + 8; // Center of the chunk
  }

  /**
   * Sanitize string for safe database/Redis storage
   */
  static sanitizeString(input: string, maxLength: number = 255): string {
    if (!input || typeof input !== 'string') {
      return '';
    }
    
    return input
      .trim()
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '') // Remove control characters
      .substring(0, maxLength);
  }

  /**
   * Validate API key format
   */
  static isValidApiKey(apiKey: string): boolean {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }
    
    // Format: mk_live_[64 caractères alphanumériques]
    return /^mk_live_[a-zA-Z0-9]{64}$/.test(apiKey);
  }

  /**
   * Generate secure random string for API keys
   */
  static generateSecureRandomString(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    const randomBytes = crypto.randomBytes(length);
    
    for (let i = 0; i < length; i++) {
      result += chars[randomBytes[i] % chars.length];
    }
    
    return result;
  }

  /**
   * Test various UUID formats commonly used by Minecraft
   * Utilisé pour le développement et les tests
   */
  static testMinecraftUUIDs(): void {
    const testUUIDs = [
      // UUIDs valides
      'f47ac10b-58cc-4372-a567-0e02b2c3d479', // UUID v4 standard
      'f47ac10b-58cc-3372-a567-0e02b2c3d479', // UUID v3 (MD5)
      'f47ac10b58cc4372a5670e02b2c3d479',     // Sans tirets
      '069a79f4-44e9-4726-a5be-fca90e38aaf5', // Minecraft UUID réel
      'F47AC10B-58CC-4372-A567-0E02B2C3D479', // Majuscules
      ' f47ac10b-58cc-4372-a567-0e02b2c3d479 ', // Avec espaces
      
      // UUIDs invalides
      'invalid-uuid',
      '123',
      '',
      'f47ac10b-58cc-6372-a567-0e02b2c3d479', // Version invalide (6)
      'f47ac10b-58cc-4372-c567-0e02b2c3d479', // Variant invalide (c)
      'f47ac10b-58cc-4372-a567-0e02b2c3d47',  // Trop court
      'f47ac10b-58cc-4372-a567-0e02b2c3d4799' // Trop long
    ];

    console.log('🧪 Testing Minecraft UUID validation:');
    console.log('=====================================');
    
    testUUIDs.forEach(uuid => {
      const validation = SecurityUtils.validateAndNormalizeUUID(uuid);
      const status = validation.isValid ? '✅' : '❌';
      
      console.log(`${status} "${uuid}"`);
      console.log(`   Valid: ${validation.isValid}`);
      console.log(`   Normalized: "${validation.normalizedUuid}"`);
      if (validation.error) {
        console.log(`   Error: ${validation.error}`);
      }
      console.log('');
    });
  }

  /**
   * Validate JSON string to prevent injection
   */
  static isValidJsonString(jsonString: string): boolean {
    try {
      JSON.parse(jsonString);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sanitize zone name for safe storage
   */
  static sanitizeZoneName(name: string): string {
    if (!name || typeof name !== 'string') {
      return '';
    }
    
    return name
      .trim()
      .replace(/[<>'"&]/g, '') // Remove potentially dangerous characters
      .substring(0, 100); // Limit length
  }

  /**
   * Validate zone polygon coordinates
   */
  static isValidPolygonPoint(x: number, z: number): boolean {
    return SecurityUtils.isValidChunkCoordinate(x) && 
           SecurityUtils.isValidChunkCoordinate(z);
  }

  /**
   * Validate permission string format
   */
  static isValidPermission(permission: string): boolean {
    if (!permission || typeof permission !== 'string') {
      return false;
    }
    
    const validPermissions = [
      'player:read', 'player:write', 'player:*',
      'zone:read', 'zone:write', 'zone:*',
      'chunk:read', 'stats:read', 'batch:manage',
      'admin:*', 'api:read', '*'
    ];
    
    return validPermissions.includes(permission);
  }

  /**
   * Rate limiting helper - check if timestamp is within window
   */
  static isWithinTimeWindow(timestamp: number, windowMs: number): boolean {
    const now = Date.now();
    return (now - timestamp) <= windowMs;
  }

  /**
   * Generate hash for sensitive data storage
   */
  static generateHash(data: string, salt?: string): string {
    const actualSalt = salt || crypto.randomBytes(16).toString('hex');
    return crypto.createHash('sha256').update(data + actualSalt).digest('hex');
  }

  /**
   * Validate IP address format (for logging/security)
   */
  static isValidIPAddress(ip: string): boolean {
    if (!ip || typeof ip !== 'string') {
      return false;
    }
    
    // IPv4
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    
    // IPv6 (basique)
    const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
  }
}