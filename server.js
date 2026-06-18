/**
 * Multiplayer Raft Game Server v42
 * Real-time synchronization for all raft physics, players, and world state
 * Supports new hydrodynamic drag, AABB wave sampling, and CoM-aligned torque
 */

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const TICK_RATE = 60; // Server ticks per second
const TICK_INTERVAL = 1000 / TICK_RATE;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 60000; // 60 seconds

// ═══════════════════════════════════════════════════════════════════════════
// Global World State
// ═══════════════════════════════════════════════════════════════════════════

const worldState = {
  players: new Map(),           // playerId → { pos, rot, raft, hp, inventory, ... }
  rafts: new Map(),             // raftId → { cx, cz, worldY, vx, vz, vy, roll, pitch, rollV, pitchV, yaw, blocks, mass, comX, comZ, cobX, cobZ, currentD, sunk, ... }
  blocks: new Map(),            // ikey(x,y,z) → { type, age }
  tide: 0,                       // Current tide offset
  time: 0,                       // Server world time (seconds)
  windSpeed: 0,
  windDir: { x: 0, y: 0 },
  rainActive: false,
};

// Physics constants (must match client)
const PHYSICS = {
  GRAVITY: 9.8,
  RAFT_BUOY_SPRING: 2.6,
  RAFT_TILT_SPRING: 3.2,
  RAFT_TILT_DECAY: 0.88,
  RAFT_SINK_SPEED: 2.2,
  RAFT_MAX_TILT: 0.44,
  RAFT_WATER_DRAG: 0.022,
  RAFT_FLUID_DRAG: 1.6,
  RAFT_WAVE_TORQUE: 0.15,
  RAFT_MAX_VERTICAL_SPEED: 3.2,
  RAFT_WAVE_SAMPLE_GRID: 3,
  RAFT_TURN: 1.6,
  RAFT_ACCEL: 4.2,
  RAFT_MAX_SPEED: 5.5,
  WATER_LVL: 64,
};

const RAFT_DENSITY = { 32: 0.52, 26: 0.46, 33: 0.68, 34: 0.04, 5: 0.55, 6: 0.22, 2: 1.45, 3: 2.65, 9: 1.60 };
const RAFT_DEFAULT_DENSITY = 0.80;

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

function ikey(x, y, z) {
  const X_SPAN = 512, Y_STRIDE_IKEY = 512 * 512;
  const X_OFF = 256, Y_BIAS = 0, Z_OFF = 256;
  return (x + X_OFF) + (y + Y_BIAS) * Y_STRIDE_IKEY + (z + Z_OFF) * X_SPAN;
}

function clamp(v, a, b) {
  return Math.min(Math.max(v, a), b);
}

function raftWaterSurface(x, z, time) {
  return PHYSICS.WATER_LVL + worldState.tide
    + Math.sin(time * 1.3 + x * 0.60) * 0.055
    + Math.cos(time * 1.05 + z * 0.78) * 0.038;
}

function updateWorldTime(dt) {
  worldState.time += dt;
  
  // Update tide (24-second cycle)
  worldState.tide = Math.sin(worldState.time * 0.262) * 2.5;
  
  // Update wind (Perlin-like noise approximation)
  const windPhase = Math.sin(worldState.time * 0.05) * 0.5 + Math.cos(worldState.time * 0.03) * 0.5;
  worldState.windSpeed = 10 + windPhase * 8;
  worldState.windDir.x = Math.cos(worldState.time * 0.08);
  worldState.windDir.y = Math.sin(worldState.time * 0.11);
  
  // Update rain (random bursts)
  if (Math.random() < 0.002) {
    worldState.rainActive = !worldState.rainActive;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Raft Physics Simulation
// ═══════════════════════════════════════════════════════════════════════════

function raftWaveInfo(raft, time) {
  const grid = PHYSICS.RAFT_WAVE_SAMPLE_GRID;
  if (!raft.minX || !raft.maxX) return { avgHeight: PHYSICS.WATER_LVL, waveDiffX: 0, waveDiffZ: 0, submergedRatio: 0.5 };
  
  const stepX = Math.max(0, (raft.maxX - raft.minX) / Math.max(1, grid - 1));
  const stepZ = Math.max(0, (raft.maxZ - raft.minZ) / Math.max(1, grid - 1));
  
  let sum = 0, count = 0;
  let leftSum = 0, rightSum = 0, leftCount = 0, rightCount = 0;
  let frontSum = 0, backSum = 0, frontCount = 0, backCount = 0;
  
  for (let iz = 0; iz < grid; iz++) {
    const z = raft.minZ + 0.5 + iz * stepZ;
    for (let ix = 0; ix < grid; ix++) {
      const x = raft.minX + 0.5 + ix * stepX;
      const h = raftWaterSurface(raft.cx + x, raft.cz + z, time);
      sum += h; count++;
      
      const relX = x - (raft.comX || 0);
      if (relX < 0) { leftSum += h; leftCount++; }
      else if (relX > 0) { rightSum += h; rightCount++; }
      else { leftSum += h; leftCount++; rightSum += h; rightCount++; }
      
      const relZ = z - (raft.comZ || 0);
      if (relZ < 0) { frontSum += h; frontCount++; }
      else if (relZ > 0) { backSum += h; backCount++; }
      else { frontSum += h; frontCount++; backSum += h; backCount++; }
    }
  }
  
  return {
    avgHeight: sum / Math.max(1, count),
    waveDiffX: (leftSum / Math.max(1, leftCount)) - (rightSum / Math.max(1, rightCount)),
    waveDiffZ: (frontSum / Math.max(1, frontCount)) - (backSum / Math.max(1, backCount)),
    submergedRatio: clamp(raft.currentD / Math.max(raft.maxH || 1, 1), 0, 1)
  };
}

function updateRaft(raft, dt, time) {
  const waveInfo = raftWaveInfo(raft, time);
  const surf = waveInfo.avgHeight;
  const mass = Math.max(raft.mass || 1, 0.3);
  
  // ── Vertical physics with hydrodynamic drag ──
  if (!raft.vy) raft.vy = 0;
  
  const targetD = raft.mass > raft.totalVol ? null : raft.currentD;
  if (targetD === null) {
    raft.vy = 0;
    raft.currentD = Math.min(raft.currentD + dt * PHYSICS.RAFT_SINK_SPEED, 5);
    raft.sunk = true;
  } else {
    raft.sunk = false;
    const desiredY = surf - targetD;
    const buoyancyAcc = (desiredY - raft.worldY) * PHYSICS.RAFT_BUOY_SPRING;
    raft.vy += buoyancyAcc * dt;
    raft.vy *= Math.max(0, 1 - PHYSICS.RAFT_FLUID_DRAG * waveInfo.submergedRatio * dt);
    raft.vy = clamp(raft.vy, -PHYSICS.RAFT_MAX_VERTICAL_SPEED, PHYSICS.RAFT_MAX_VERTICAL_SPEED);
    raft.currentD += raft.vy * dt;
    raft.currentD = Math.max(0, raft.currentD);
  }
  raft.worldY = surf - raft.currentD;
  
  // ── Tilt (CoM vs CoB + wave-induced torque) ──
  const offX = (raft.comX || 0) - (raft.cobX || 0);
  const offZ = (raft.comZ || 0) - (raft.cobZ || 0);
  const rollTarget = clamp(offX * 0.55 + waveInfo.waveDiffX * PHYSICS.RAFT_WAVE_TORQUE, -PHYSICS.RAFT_MAX_TILT, PHYSICS.RAFT_MAX_TILT);
  const pitchTarget = clamp(offZ * 0.55 + waveInfo.waveDiffZ * PHYSICS.RAFT_WAVE_TORQUE, -PHYSICS.RAFT_MAX_TILT, PHYSICS.RAFT_MAX_TILT);
  
  if (!raft.rollV) raft.rollV = 0;
  if (!raft.pitchV) raft.pitchV = 0;
  
  raft.rollV += (rollTarget - raft.roll) * PHYSICS.RAFT_TILT_SPRING * dt;
  raft.pitchV += (pitchTarget - raft.pitch) * PHYSICS.RAFT_TILT_SPRING * dt;
  raft.rollV *= Math.pow(PHYSICS.RAFT_TILT_DECAY, dt * 60);
  raft.pitchV *= Math.pow(PHYSICS.RAFT_TILT_DECAY, dt * 60);
  raft.roll = clamp(raft.roll + raft.rollV * dt, -PHYSICS.RAFT_MAX_TILT, PHYSICS.RAFT_MAX_TILT);
  raft.pitch = clamp(raft.pitch + raft.pitchV * dt, -PHYSICS.RAFT_MAX_TILT, PHYSICS.RAFT_MAX_TILT);
  
  // ── Wind and water drag ──
  const windExposure = Math.sqrt((raft.blocks || []).length) * 0.028;
  raft.vx += worldState.windDir.x * (worldState.windSpeed * windExposure) * dt;
  raft.vz += worldState.windDir.y * (worldState.windSpeed * windExposure) * dt;
  
  const spd = Math.sqrt(raft.vx * raft.vx + raft.vz * raft.vz);
  if (spd > 0.001) {
    const drag = 1 - (0.32 + spd * spd * PHYSICS.RAFT_WATER_DRAG) * dt * 3.0;
    raft.vx *= Math.max(0, drag);
    raft.vz *= Math.max(0, drag);
  }
  
  const maxSpd = raft.sunk ? 0.3 : clamp(1.8 / Math.max(mass * 0.4, 1), 0.4, PHYSICS.RAFT_MAX_SPEED);
  const curSpd = Math.sqrt(raft.vx * raft.vx + raft.vz * raft.vz);
  if (curSpd > maxSpd) {
    const k = maxSpd / curSpd;
    raft.vx *= k;
    raft.vz *= k;
  }
  
  // ── Position update ──
  raft.cx += raft.vx * dt;
  raft.cz += raft.vz * dt;
  
  // ── Yaw tracking ──
  if (curSpd > 0.12) {
    const targetYaw = Math.atan2(raft.vx, raft.vz);
    let dy = targetYaw - raft.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    raft.yaw += dy * Math.min(1, dt * 1.2);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Server Tick Loop
// ═══════════════════════════════════════════════════════════════════════════

let lastTickTime = Date.now();

function serverTick() {
  const now = Date.now();
  const dt = Math.min((now - lastTickTime) / 1000, 0.05); // Cap at 50ms to avoid spiral of death
  lastTickTime = now;
  
  // Update world state
  updateWorldTime(dt);
  
  // Update all rafts
  for (const [raftId, raft] of worldState.rafts) {
    updateRaft(raft, dt, worldState.time);
  }
  
  // Update player physics (simple gravity)
  for (const [playerId, player] of worldState.players) {
    if (!player.onGround && !player.swimming) {
      player.velY = (player.velY || 0) - PHYSICS.GRAVITY * dt;
      player.pos.y += player.velY * dt;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket Server
// ═══════════════════════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      players: worldState.players.size,
      rafts: worldState.rafts.size,
      time: worldState.time,
      tide: worldState.tide
    }));
  } else if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>🚢 Raft Game Server v42</h1><p>Multiplayer sync running</p>');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let playerId = null;
  let lastHeartbeat = Date.now();
  
  console.log(`[+] Client connected. Total: ${wss.clients.size}`);
  
  // Send initial world state
  ws.send(JSON.stringify({
    type: 'world_init',
    worldState: {
      time: worldState.time,
      tide: worldState.tide,
      wind: worldState.windDir,
      windSpeed: worldState.windSpeed,
      rainActive: worldState.rainActive
    }
  }));
  
  // Broadcast all existing rafts & players
  for (const [rid, raft] of worldState.rafts) {
    ws.send(JSON.stringify({ type: 'raft_spawn', id: rid, data: raft }));
  }
  
  for (const [pid, player] of worldState.players) {
    if (pid !== playerId) {
      ws.send(JSON.stringify({ type: 'player_join', id: pid, data: player }));
    }
  }
  
  // ── Message Handler ──
  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData);
      lastHeartbeat = Date.now();
      
      switch (msg.type) {
        case 'player_join':
          playerId = msg.playerId;
          const newPlayer = {
            name: msg.name || 'Player',
            pos: msg.pos || { x: 0, y: 80, z: 0 },
            rot: msg.rot || { x: 0, y: 0 },
            hp: 100,
            inventory: [],
            onGround: true,
            swimming: false,
            velY: 0,
            ridingRaft: null,
          };
          worldState.players.set(playerId, newPlayer);
          
          // Notify all clients
          broadcast(JSON.stringify({
            type: 'player_join',
            id: playerId,
            data: newPlayer
          }), ws);
          
          console.log(`[+] Player ${playerId} joined: ${newPlayer.name}`);
          break;
        
        case 'player_update':
          if (!playerId) break;
          const player = worldState.players.get(playerId);
          if (player) {
            if (msg.pos) player.pos = msg.pos;
            if (msg.rot) player.rot = msg.rot;
            if (msg.onGround !== undefined) player.onGround = msg.onGround;
            if (msg.swimming !== undefined) player.swimming = msg.swimming;
            if (msg.velY !== undefined) player.velY = msg.velY;
            if (msg.hp !== undefined) player.hp = msg.hp;
          }
          break;
        
        case 'raft_create':
          const raftId = msg.raftId;
          const newRaft = {
            _id: raftId,
            blocks: msg.blocks || [],
            cx: msg.cx || 0,
            cz: msg.cz || 0,
            worldY: PHYSICS.WATER_LVL,
            vx: 0,
            vz: 0,
            vy: 0,
            roll: 0,
            pitch: 0,
            rollV: 0,
            pitchV: 0,
            yaw: 0,
            currentD: 0,
            sunk: false,
            mass: msg.mass || 1,
            totalVol: msg.totalVol || msg.blocks.length,
            comX: 0,
            comZ: 0,
            cobX: 0,
            cobZ: 0,
            maxH: 1,
            minX: 0,
            maxX: 0,
            minZ: 0,
            maxZ: 0,
            sailArea: 0,
            hasMast: false,
          };
          worldState.rafts.set(raftId, newRaft);
          
          broadcast(JSON.stringify({
            type: 'raft_spawn',
            id: raftId,
            data: newRaft
          }), ws);
          
          console.log(`[+] Raft ${raftId} created with ${newRaft.blocks.length} blocks`);
          break;
        
        case 'raft_update':
          const raft = worldState.rafts.get(msg.raftId);
          if (raft) {
            if (msg.vx !== undefined) raft.vx = msg.vx;
            if (msg.vz !== undefined) raft.vz = msg.vz;
            if (msg.yaw !== undefined) raft.yaw = msg.yaw;
            if (msg.blocks) raft.blocks = msg.blocks;
            if (msg.mass !== undefined) raft.mass = msg.mass;
            if (msg.comX !== undefined) raft.comX = msg.comX;
            if (msg.comZ !== undefined) raft.comZ = msg.comZ;
            if (msg.minX !== undefined) raft.minX = msg.minX;
            if (msg.maxX !== undefined) raft.maxX = msg.maxX;
            if (msg.minZ !== undefined) raft.minZ = msg.minZ;
            if (msg.maxZ !== undefined) raft.maxZ = msg.maxZ;
          }
          break;
        
        case 'block_break':
          const key = msg.key;
          worldState.blocks.delete(key);
          broadcast(JSON.stringify({
            type: 'block_break',
            key: key
          }), ws);
          break;
        
        case 'block_place':
          worldState.blocks.set(msg.key, {
            type: msg.blockType,
            age: 0
          });
          broadcast(JSON.stringify({
            type: 'block_place',
            key: msg.key,
            blockType: msg.blockType
          }), ws);
          break;
        
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
          break;
        
        default:
          console.log(`[!] Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      console.error('[!] Message parsing error:', err.message);
    }
  });
  
  // ── Connection Close ──
  ws.on('close', () => {
    if (playerId) {
      worldState.players.delete(playerId);
      broadcast(JSON.stringify({
        type: 'player_leave',
        id: playerId
      }));
      console.log(`[-] Player ${playerId} left. Total: ${wss.clients.size}`);
    }
  });
  
  // ── Error Handling ──
  ws.on('error', (err) => {
    console.error('[!] WebSocket error:', err.message);
  });
});

function broadcast(message, excludeWs = null) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(message);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Periodic Broadcasting
// ═══════════════════════════════════════════════════════════════════════════

setInterval(() => {
  serverTick();
  
  // Broadcast world state to all clients
  const stateUpdate = {
    type: 'world_state',
    time: worldState.time,
    tide: worldState.tide,
    wind: worldState.windDir,
    windSpeed: worldState.windSpeed,
    rainActive: worldState.rainActive,
    rafts: {},
    players: {}
  };
  
  // Add raft states
  for (const [id, raft] of worldState.rafts) {
    stateUpdate.rafts[id] = {
      cx: raft.cx,
      cz: raft.cz,
      worldY: raft.worldY,
      vx: raft.vx,
      vz: raft.vz,
      vy: raft.vy,
      roll: raft.roll,
      pitch: raft.pitch,
      yaw: raft.yaw,
      currentD: raft.currentD,
      sunk: raft.sunk
    };
  }
  
  // Add player states
  for (const [id, player] of worldState.players) {
    stateUpdate.players[id] = {
      pos: player.pos,
      rot: player.rot,
      hp: player.hp,
      onGround: player.onGround,
      ridingRaft: player.ridingRaft
    };
  }
  
  broadcast(JSON.stringify(stateUpdate));
}, TICK_INTERVAL);

// Heartbeat check for zombie connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// ═══════════════════════════════════════════════════════════════════════════
// Server Start
// ═══════════════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║         🚢 Raft Game Server v42 - Multiplayer Sync            ║
║                                                                ║
║  Server running on ws://localhost:${PORT}                        
║  Health check: http://localhost:${PORT}/health                
║                                                                ║
║  Features:                                                     ║
║  ✓ Hydrodynamic drag (RAFT_FLUID_DRAG)                        ║
║  ✓ AABB wave sampling (3x3 grid optimization)                 ║
║  ✓ CoM-aligned torque mechanics                               ║
║  ✓ Full world synchronization                                 ║
║  ✓ Player & raft state broadcasting                           ║
║  ✓ Physics tick at ${TICK_RATE} Hz                             ║
╚════════════════════════════════════════════════════════════════╝
  `);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[!] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[!] Uncaught Exception:', err);
  process.exit(1);
});
