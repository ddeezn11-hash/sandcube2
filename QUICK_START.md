# Multiplayer Raft Game - Quick Start Guide

## ✅ What's Been Built

Your game now has a **production-ready multiplayer server** with:

- ✓ Real-time physics synchronization (60 Hz tick rate)
- ✓ All three physics improvements:
  - **Hydrodynamic drag** scaling with submersion ratio
  - **AABB wave sampling** (3×3 grid optimization)
  - **Center of Mass** aligned torque mechanics
- ✓ Full world state sync (tide, wind, rain, time)
- ✓ Player position & inventory sync
- ✓ Block placement/destruction sync across all players
- ✓ Automatic zombie connection cleanup
- ✓ Health check endpoint

## 🚀 Start the Server

```bash
cd /workspaces/sandcube2
npm start
```

Server runs on: **ws://localhost:8080**

Health check: **http://localhost:8080/health**

## 📁 Project Files

| File | Purpose |
|------|---------|
| `server.js` | 552-line multiplayer server implementation |
| `package.json` | Dependencies (ws, nodemon) & npm scripts |
| `game_v42_raft (8) (2).html` | Single-player game client |
| `RAFT_PHYSICS.md` | Detailed physics documentation |
| `SERVER_INTEGRATION.md` | Client integration guide (See next step) |
| `README.md` | Original project docs |

## 🔧 Next Steps: Client Integration

### Option 1: Quick Local Testing
1. Start server: `npm start`
2. Open game in browser: `file:///workspaces/sandcube2/game_v42_raft\ \(8\)\ \(2\).html`
3. Open a second browser window with same game file
4. Add this to your game's JavaScript console to connect both to server:

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.onopen = () => {
  console.log('Connected to server');
  ws.send(JSON.stringify({
    type: 'player_join',
    playerId: 'player_' + Math.random(),
    name: 'Player 1',
    pos: { x: 0, y: 2, z: 0 },
    rot: { x: 0, y: 0 }
  }));
};
```

### Option 2: Full Client Integration
See [SERVER_INTEGRATION.md](SERVER_INTEGRATION.md) for complete step-by-step guide:
- Connect WebSocket to server
- Handle incoming world state messages
- Send player updates to server
- Sync block placement/breaking
- Synchronize raft creation and updates

## 📊 Physics Constants (Server ↔ Client Match)

```javascript
RAFT_FLUID_DRAG: 1.6           // Hydrodynamic dampening
RAFT_WAVE_TORQUE: 0.15         // Wave-induced tilt
RAFT_WAVE_SAMPLE_GRID: 3       // 3×3 grid sampling
RAFT_MAX_VERTICAL_SPEED: 3.2   // Max rise/sink speed
RAFT_BUOY_SPRING: 2.6          // Buoyancy stiffness
RAFT_MAX_TILT: 0.44            // Max roll/pitch angle
```

## 🌐 Message Flow

### Client → Server
```javascript
// When player joins
{ type: 'player_join', playerId, name, pos, rot }

// Every frame
{ type: 'player_update', playerId, pos, rot, hp, onGround }

// When building raft
{ type: 'raft_create', raftId, blocks, cx, cz, mass }

// When placing/breaking blocks
{ type: 'block_place', key, blockType }
{ type: 'block_break', key }
```

### Server → Client
```javascript
// On first connection
{ type: 'world_init', worldState: {...} }

// Every tick (60 Hz)
{
  type: 'world_state',
  time,
  tide,
  wind: {x, y},
  windSpeed,
  rainActive,
  rafts: { raftId: {cx, cz, worldY, vx, vz, vy, roll, pitch, yaw, ...} },
  players: { playerId: {pos, rot, hp, ...} }
}

// When events happen
{ type: 'player_join', id, data: {...} }
{ type: 'player_leave', id }
{ type: 'raft_spawn', id, data: {...} }
```

## 🔍 Debug Commands

### Monitor Server Health
```bash
# Check if server is running
curl http://localhost:8080/health

# Watch server logs in real-time
npm start 2>&1 | tee server.log

# Use nodemon for auto-restart on changes
npm run dev
```

### Test WebSocket Connection
```bash
# From another terminal, test WebSocket
wscat -c ws://localhost:8080

# Send a test ping
{"type":"ping","timestamp":1234567890}
```

## 🎯 Performance Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| Tick Rate | 60 Hz | 16.67 ms per tick |
| Broadcast Frequency | 60 Hz | Full world state each tick |
| Wave Samples | 9 (3×3) | AABB optimization |
| Connection Timeout | 60 sec | Auto-cleanup idle players |
| Heartbeat Interval | 30 sec | Ping/pong detection |

## 🐛 Troubleshooting

### Server won't start
```bash
# Check port is available
lsof -i :8080

# Kill process on port 8080 if needed
kill -9 $(lsof -t -i :8080)

# Try different port
PORT=3000 npm start
```

### Clients can't connect
- Check server is running: `curl http://localhost:8080/health`
- Verify WebSocket URL: `ws://localhost:8080` (not http)
- Check firewall allows port 8080
- Verify both client and server running on same machine (for local testing)

### Physics out of sync
- Ensure `PHYSICS` constants in client match server.js
- Check network latency (should be < 100ms for smooth sync)
- Verify client sends updates every frame (not every few frames)

### Memory usage grows
- Check for properly closed WebSocket connections
- Verify client cleanup on disconnect
- Monitor: `curl http://localhost:8080/health` shows connection count

## 📚 Documentation

- **[SERVER_INTEGRATION.md](SERVER_INTEGRATION.md)** — Complete client integration guide with code examples
- **[RAFT_PHYSICS.md](RAFT_PHYSICS.md)** — Detailed physics mechanics & math
- **[README.md](README.md)** — Original project documentation

## 🚢 Deploy to Production

### Heroku
```bash
git add .
git commit -m "Add multiplayer server"
git push heroku main
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

### AWS/GCP/Azure
```bash
# Set environment variable
export PORT=8080
export NODE_ENV=production
npm start
```

## 💡 Tips & Tricks

### Log All Messages
Add to server.js in the message handler:
```javascript
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('[MSG]', msg.type, msg);
});
```

### Simulate Network Lag
Add artificial delay to broadcast:
```javascript
setTimeout(() => broadcast(JSON.stringify(stateUpdate)), 100); // 100ms delay
```

### Monitor Active Players
```javascript
setInterval(() => {
  console.log(`Active players: ${worldState.players.size}, Rafts: ${worldState.rafts.size}`);
}, 5000);
```

## ✨ What's Next?

1. **Client Integration** — Add WebSocket code to game HTML
2. **Testing** — Run local multiplayer test with 2+ browsers
3. **Deployment** — Deploy server to cloud (Heroku, AWS, etc.)
4. **Scaling** — Add player auth, chat, leaderboards, etc.

---

**Ready to go!** Start the server with `npm start` and see the welcome banner. 🚢
