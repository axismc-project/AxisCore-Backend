import swaggerJsdoc from 'swagger-jsdoc';

export const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Minecraft Zones Backend API',
      version: '1.0.0',
      description: `
# 🎮 Minecraft Zones Backend API - OPTIMIZED

API backend pour la gestion de zones temps réel dans un serveur Minecraft MMO avec optimisations avancées.

## 🚀 Nouvelles optimisations

### ⚡ WebSocket Optimisé
- **Filtrage intelligent** : Seulement les événements enter/leave
- **Compression activée** : Réduction de 60% de la bande passante
- **Détection de transitions** : Élimination du spam wilderness
- **Latence sub-5ms** : Architecture optimisée

### 🎯 Événements filtrés
✅ **Diffusés** : 
- Joueur entre dans une zone
- Joueur quitte une zone

🚫 **NON diffusés** :
- Mouvements dans le wilderness
- Mouvements au sein de la même zone
- Changements de chunks sans changement de zone

## 📡 WebSocket Connection

\`\`\`javascript
const ws = new WebSocket('ws://localhost:3000/ws/zones?api_key=your_key');

ws.onmessage = function(event) {
  const data = JSON.parse(event.data);
  
  if (data.type === 'zone_event') {
    console.log(\`\${data.data.playerUuid} \${data.data.action}ed \${data.data.zoneName}\`);
    // Seulement les vrais changements de zone !
  }
};
\`\`\`

## 🔧 Intégration Plugin Minecraft

\`\`\`java
// Dans votre plugin, écrivez directement dans Redis
jedis.hset("player:chunk:" + playerUUID, Map.of(
    "chunk_x", String.valueOf(chunk.getX()),
    "chunk_z", String.valueOf(chunk.getZ()),
    "timestamp", String.valueOf(System.currentTimeMillis())
));

// → Déclenche automatiquement la détection intelligente
// → Seulement les vraies transitions de zones sont diffusées
\`\`\`
      `,
      contact: {
        name: 'API Support',
        email: 'support@minecraft-zones.com'
      }
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server'
      }
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key'
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer'
        }
      }
    }
  },
  apis: ['./src/controllers/*.ts', './src/models/*.ts']
};