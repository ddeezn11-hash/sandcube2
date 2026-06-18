# Multiplayer Server Setup & Integration

## Installation

```bash
npm install
```

## Running the Server

```bash
npm start
```

Server will start on `ws://localhost:8080`

Health check: `http://localhost:8080/health`

## Features

✅ **Full Physics Synchronization**
- Hydrodynamic drag (RAFT_FLUID_DRAG = 1.6)
- AABB wave sampling (3×3 grid)
- Center of Mass (CoM) aligned torque
- Real-time raft position, rotation, sinkage updates

✅ **World State Sync**
- Tide oscillation (24-second cycle)
- Wind speed & direction
- Rain events
- Block placement/destruction
- Player position & HP

✅ **Robust Multiplayer**
- WebSocket real-time updates @ 60 Hz
- Automatic heartbeat detection
- Zombie connection cleanup
- Graceful player disconnect handling
- Connection timeout: 60 seconds

## Client Integration

### 1. Connect to Server

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  console.log('Connected to server');
  
  // Send player join message
  ws.send(JSON.stringify({
    type: 'player_join',
    playerId: playerId,
    name: playerName,
    pos: { x: playerX, y: playerY, z: playerZ },
    rot: { x: rotX, y: rotY }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  handleServerMessage(msg);
};
```

### 2. Handle Server Messages

```javascript
function handleServerMessage(msg) {
  switch(msg.type) {
    case 'world_init':
      // Initialize world state from server
      worldState = msg.worldState;
      break;
    
    case 'world_state':
      // Update periodic world state
      updateFromServer(msg);
      break;
    
    case 'raft_spawn':
      // New raft appeared
      createRaft(msg.id, msg.data);
      break;
    
    case 'player_join':
      // New player joined
      addRemotePlayer(msg.id, msg.data);
      break;
    
    case 'player_leave':
      // Player disconnected
      removeRemotePlayer(msg.id);
      break;
    
    case 'block_place':
      // Block placed by other player
      placeBlock(msg.key, msg.blockType);
      break;
    
    case 'block_break':
      // Block broken by other player
      breakBlock(msg.key);
      break;
  }
}

function updateFromServer(msg) {
  // Update world time, tide, wind
  worldState.time = msg.time;
  worldState.tide = msg.tide;
  worldState.windDir = msg.wind;
  worldState.windSpeed = msg.windSpeed;
  worldState.rainActive = msg.rainActive;
  
  // Update all raft positions & rotation
  for (const [raftId, raftData] of Object.entries(msg.rafts)) {
    const raft = rafts.get(raftId);
    if (raft) {
      raft.cx = raftData.cx;
      raft.cz = raftData.cz;
      raft.worldY = raftData.worldY;
      raft.vx = raftData.vx;
      raft.vz = raftData.vz;
      raft.vy = raftData.vy;
      raft.roll = raftData.roll;
      raft.pitch = raftData.pitch;
      raft.yaw = raftData.yaw;
      raft.currentD = raftData.currentD;
      raft.sunk = raftData.sunk;
    }
  }
  
  // Update remote player positions
  for (const [playerId, playerData] of Object.entries(msg.players)) {
    const remotePlayer = remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.pos = playerData.pos;
      remotePlayer.rot = playerData.rot;
      remotePlayer.hp = playerData.hp;
      remotePlayer.onGround = playerData.onGround;
    }
  }
}
```

### 3. Send Player Updates

Send player state to server (when moving, jumping, etc.):

```javascript
function updateServerPlayerState() {
  ws.send(JSON.stringify({
    type: 'player_update',
    playerId: playerId,
    pos: pBody.position,
    rot: { x: camera.rotation.x, y: camera.rotation.y },
    onGround: onGround,
    swimming: inWater,
    velY: velY,
    hp: health
  }));
}
```

### 4. Create/Update Rafts

When building a raft:

```javascript
function notifyServerRaftCreated(raft) {
  ws.send(JSON.stringify({
    type: 'raft_create',
    raftId: raft._id,
    blocks: raft.blocks,
    cx: raft.cx,
    cz: raft.cz,
    mass: raft.mass,
    totalVol: raft.totalVol
  }));
}

function notifyServerRaftUpdate(raft) {
  ws.send(JSON.stringify({
    type: 'raft_update',
    raftId: raft._id,
    vx: raft.vx,
    vz: raft.vz,
    yaw: raft.yaw,
    blocks: raft.blocks,
    mass: raft.mass,
    comX: raft.comX,
    comZ: raft.comZ,
    minX: raft.minX,
    maxX: raft.maxX,
    minZ: raft.minZ,
    maxZ: raft.maxZ
  }));
}
```

### 5. Synchronize Block Changes

```javascript
function notifyServerBlockPlaced(x, y, z, blockType) {
  const key = ikey(x, y, z);
  ws.send(JSON.stringify({
    type: 'block_place',
    key: key,
    blockType: blockType
  }));
}

function notifyServerBlockBroken(x, y, z) {
  const key = ikey(x, y, z);
  ws.send(JSON.stringify({
    type: 'block_break',
    key: key
  }));
}
```

## API Reference

### Message Types

#### Server → Client

| Type | Description | Data |
|------|-------------|------|
| `world_init` | Initial world state | `{ worldState: {...} }` |
| `world_state` | Periodic updates | `{ time, tide, wind, windSpeed, rainActive, rafts, players }` |
| `raft_spawn` | New raft created | `{ id, data: {...} }` |
| `player_join` | Player connected | `{ id, data: {...} }` |
| `player_leave` | Player disconnected | `{ id }` |
| `player_update` | Player moved | `{ id, data: {...} }` |
| `block_place` | Block placed | `{ key, blockType }` |
| `block_break` | Block destroyed | `{ key }` |
| `pong` | Heartbeat response | `{ timestamp }` |

#### Client → Server

| Type | Description | Data |
|------|-------------|------|
| `player_join` | Join game | `{ playerId, name, pos, rot }` |
| `player_update` | Update state | `{ playerId, pos, rot, onGround, swimming, velY, hp }` |
| `raft_create` | Create raft | `{ raftId, blocks, cx, cz, mass, totalVol }` |
| `raft_update` | Update raft | `{ raftId, vx, vz, yaw, blocks, mass, comX, comZ, minX, maxX, minZ, maxZ }` |
| `block_place` | Place block | `{ key, blockType }` |
| `block_break` | Break block | `{ key }` |
| `ping` | Heartbeat | `{ timestamp }` |

## Performance Tuning

### Tick Rate
- Default: 60 Hz (16.67 ms per tick)
- Modify: `TICK_INTERVAL` constant

### Broadcast Frequency
- Default: Every tick
- Modify: `setInterval(...)` loop duration

### Physics Constants
All match client-side (`PHYSICS` object in server.js):
- `RAFT_FLUID_DRAG`: 1.6 (increase = more damping)
- `RAFT_WAVE_TORQUE`: 0.15 (increase = more wave tilt)
- `RAFT_WAVE_SAMPLE_GRID`: 3 (3×3 sampling)

## Deployment

### Local Network
```bash
PORT=8080 npm start
# Connect clients to ws://<server-ip>:8080
```

### Docker
```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js .
EXPOSE 8080
CMD ["npm", "start"]
```

### Heroku
```bash
git push heroku main
# Server auto-starts with Procfile
```

## Troubleshooting

### Clients can't connect
- Check firewall allows port 8080
- Verify server is running: `curl http://localhost:8080/health`
- Check WebSocket URL matches server address

### Physics desync
- Ensure both client & server `PHYSICS` constants match
- Check network latency (ping)
- Verify client sends frequent updates (every frame)

### Memory leaks
- Monitor: `curl http://localhost:8080/health`
- Check for properly closed WebSocket connections
- Verify zombie cleanup runs (heartbeat interval)

## License
MIT
