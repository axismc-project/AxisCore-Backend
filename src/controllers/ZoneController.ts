// src/controllers/ZoneController.ts
import { Request, Response } from 'express';
import { RedisService } from '../services/RedisService';
import { DatabaseService } from '../services/DatabaseService';
import { logger } from '../utils/logger';

export class ZoneController {
  constructor(
    private redis: RedisService,
    private db: DatabaseService
  ) {}

  async getZoneHierarchy(req: Request, res: Response): Promise<void> {
    try {
      const hierarchy = await this.db.getZoneHierarchy();
      
      res.json({
        message: 'Zone hierarchy retrieved',
        count: hierarchy.length,
        data: hierarchy
      });
      
    } catch (error) {
logger.error('❌ Failed to get zone hierarchy', { error });
     res.status(500).json({ 
       error: 'Server error',
       message: 'Unable to get zone hierarchy'
     });
   }
 }

 async getZoneById(req: Request, res: Response): Promise<void> {
   try {
     const { zoneType, zoneId } = req.params;
     
     if (!['region', 'node', 'city'].includes(zoneType)) {
       res.status(400).json({ 
         error: 'Invalid zone type',
         message: 'Type must be: region, node, or city'
       });
       return;
     }
     
     const id = parseInt(zoneId);
     if (isNaN(id) || id <= 0) {
       res.status(400).json({ 
         error: 'Invalid zone ID',
         message: 'ID must be a positive integer'
       });
       return;
     }
     
     const zone = await this.db.getZoneById(zoneType as any, id);
     
     if (!zone) {
       res.status(404).json({ 
         error: 'Zone not found',
         message: `No zone ${zoneType} with ID ${id}`
       });
       return;
     }
     
     res.json({
       message: 'Zone found',
       data: zone
     });
     
   } catch (error) {
     logger.error('❌ Failed to get zone by ID', { 
       zoneType: req.params.zoneType, 
       zoneId: req.params.zoneId,
       error
     });
     res.status(500).json({ 
       error: 'Server error',
       message: 'Unable to get zone'
     });
   }
 }
}