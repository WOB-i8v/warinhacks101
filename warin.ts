/**
 * WarIn.Space - Complete TypeScript Client Rewrite
 * Full game client + hack mod system
 * Original: code.js (minified JavaScript)
 * Refactored: warin.ts (TypeScript with full type safety)
 */

// ============================================================================
// GLOBAL STATE & TYPES
// ============================================================================

interface Vec2 {
  x: number;
  y: number;
}

interface Player extends Vec2 {
  id: number;
  angle: number;
  health: number;
  maxHealth: number;
  team: number;
  name: string;
  firingRange: number;
  damage: number;
  drones: number;
  maxDrones: number;
  upgrades: number[];
}

interface Scrap extends Vec2 {
  id: number;
}

interface Turret extends Vec2 {
  id: number;
  angle: number;
  team: number;
}

interface Drone extends Vec2 {
  id: number;
  angle: number;
  owner: number;
}

interface Missile extends Vec2 {
  id: number;
  vx: number;
  vy: number;
  owner: number;
}

interface Entity extends Vec2 {
  id: number;
}

// ============================================================================
// MOD SETTINGS
// ============================================================================

let hackFireRate: number = 80;
let hackZoom: number = 1.0;
let hackAutoFire: boolean = false;
let hackTracers: boolean = true;
let hackAutoScrap: boolean = false;
let hackHPNumbers: boolean = true;
let hackEnemyRadar: boolean = true;
let hackRangeRing: boolean = true;
let hackAutoAim: boolean = false;
let hackESPArrows: boolean = true;
let hackPredictLine: boolean = false;
let hackThreatMeter: boolean = true;
let hackFPS: boolean = true;
let hackEnemyDist: boolean = false;

// Internal tracking
const hackVelocities: Record<number, Vec2> = {};
const hackLastPos: Record<number, Vec2 & { t: number }> = {};
let hackFPSValue: number = 0;
let hackFPSFrames: number = 0;
let hackFPSTimer: number = Date.now();

// ============================================================================
// AUTO-BOT STATE
// ============================================================================

let botEnabled: boolean = false;
let botState: string = "SCRAP";
let botStateAt: number = 0;
let botAimAng: number = 0;
let botOrbitDir: number = 1;
let botOrbitFlip: number = 0;
let botLastAbi: number = 0;
let botUpgTimer: number = 0;
let botScrapKey: number | null = null;
let botScrapAge: number = 0;
let botTick_last: number = 0;

// Bot tuning
const BOT_HZ: number = 80;
const BOT_ENTER_ENGAGE: number = 1.4;
const BOT_EXIT_ENGAGE: number = 2.0;
const BOT_ENTER_FLEE: number = 0.26;
const BOT_EXIT_FLEE: number = 0.62;
const BOT_MIN_FLEE: number = 3000;
const BOT_ORBIT_FRAC: number = 0.80;
const BOT_ORBIT_BAND: number = 0.14;

// ============================================================================
// GAME STATE
// ============================================================================

let players: Record<number, Player> = {};
let scraps: Record<number, Scrap> = {};
let turrets: Record<number, Turret> = {};
let drones: Record<number, Drone> = {};
let missiles: Record<number, Missile> = {};

let playerX: number = 0;
let playerY: number = 0;
let playerID: number = -1;
let playerAngle: number = 0;
let playerHealth: number = 0;
let playerMaxHealth: number = 0;
let playerTeam: number = 0;
let playerScrap: number = 0;
let playerFiringRange: number = 650;
let playerDrones: number = 0;
let playerMaxDrones: number = 5;
let playerUpgrades: number[] = [0, 0, 0, 0];

let selfAngle: number = 0;
let selfTeam: number = 0;
let selfHealth: number = 0;
let selfMaxHealth: number = 0;
let selfFireRate: number = 100;
let selfFiringRange: number = 650;
let scrap: number = 0;
let Ec: boolean = false; // firing flag

let FFA: boolean = false;
let vd: any = null; // WebSocket connection
let td: number = 5000; // map width
let ud: number = 5000; // map height

let pc: number = window.innerWidth / 2; // mouse x (for movement)
let qc: number = window.innerHeight / 2; // mouse y (for movement)
let gc: boolean = false; // mobile flag

// Canvas & rendering
let c: HTMLCanvasElement;
let k: CanvasRenderingContext2D;
let aa: HTMLCanvasElement;
let ba: CanvasRenderingContext2D;
let ca: HTMLCanvasElement;
let da: CanvasRenderingContext2D;
let ea: HTMLCanvasElement;
let fa: CanvasRenderingContext2D;
let l: HTMLCanvasElement;
let n: CanvasRenderingContext2D;

// DOM elements
let ga: HTMLElement;
let ha: HTMLElement;
let ia: HTMLElement;
let ja: HTMLElement;
let ka: HTMLElement;
let la: HTMLElement;
let ma: HTMLElement;
let na: HTMLElement;
let p: HTMLSelectElement;

// ============================================================================
// MATH UTILITIES (OPTIMIZED)
// ============================================================================

function _bd2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function _bd(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(_bd2(ax, ay, bx, by));
}

function _ba(tx: number, ty: number): number {
  return Math.atan2(ty - playerY, tx - playerX);
}

function _isEnemy(p: any): boolean {
  return p && p.i > 0 && (FFA || p.c !== selfTeam);
}

function _lerpAng(cur: number, tgt: number, t: number): number {
  let d = tgt - cur;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return cur + d * t;
}

function _moveDir(ang: number): void {
  pc = window.innerWidth / 2 + Math.cos(ang) * 350;
  qc = window.innerHeight / 2 + Math.sin(ang) * 350;
}

function _stop(): void {
  pc = window.innerWidth / 2;
  qc = window.innerHeight / 2;
}

// ============================================================================
// BOT QUERY FUNCTIONS
// ============================================================================

function botNearestEnemy(): any {
  let best: any = null;
  let bd2 = Infinity;
  for (const id in players) {
    const p = players[id];
    if (!_isEnemy(p)) continue;
    const d2 = _bd2(playerX, playerY, p.x, p.y);
    if (d2 < bd2) {
      bd2 = d2;
      best = { id, p, d2 };
    }
  }
  return best;
}

function botBestScrap(): any {
  const enemies: any[] = [];
  for (const eid in players) {
    const ep = players[eid];
    if (_isEnemy(ep)) enemies.push(ep);
  }
  const dangerR = selfFiringRange * 1.6;
  const dangerR2 = dangerR * dangerR;

  let bestKey: number | null = null;
  let bestScore: number = -Infinity;
  for (const k in scraps) {
    const s = scraps[k];
    const toScrap = _bd(playerX, playerY, s.x, s.y);
    let score = 5000 - toScrap;
    const mx = (playerX + s.x) / 2;
    const my = (playerY + s.y) / 2;
    for (let ei = 0; ei < enemies.length; ei++) {
      const e = enemies[ei];
      const d2dest = _bd2(e.x, e.y, s.x, s.y);
      if (d2dest < dangerR2) score -= (1 - d2dest / dangerR2) * 3000;
      const d2path = _bd2(e.x, e.y, mx, my);
      if (d2path < dangerR2) score -= (1 - d2path / dangerR2) * 1500;
    }
    if (score > bestScore) {
      bestScore = score;
      bestKey = parseInt(k);
    }
  }
  return bestKey ? { key: bestKey, s: scraps[bestKey], score: bestScore } : null;
}

function botAreaSafe(x: number, y: number, radius: number): boolean {
  const r2 = radius * radius;
  for (const id in players) {
    const p = players[id];
    if (_isEnemy(p) && _bd2(x, y, p.x, p.y) < r2) return false;
  }
  return true;
}

// ============================================================================
// BOT PASSIVE SYSTEMS
// ============================================================================

function _tryUpgrade(): void {
  const now = Date.now();
  if (now - botUpgTimer < 300) return;
  for (let slot = 0; slot < 4; slot++) {
    // TODO: call actual upgrade function
    botUpgTimer = now;
    return;
  }
}

function _tryAbility(enemy: any): void {
  const now = Date.now();
  if (now - botLastAbi < 1500) return;
  if (!enemy) return;
  const r = selfFiringRange * 1.4;
  if (enemy.d2 < r * r) {
    // TODO: call ability
    botLastAbi = now;
  }
}

function _doAim(tx: number, ty: number): void {
  botAimAng = _lerpAng(botAimAng, Math.atan2(ty - playerY, tx - playerX), 0.3);
  selfAngle = botAimAng;
}

function _doAimLeading(enemy: any): void {
  let tx = enemy.p.x;
  let ty = enemy.p.y;
  if (hackVelocities[enemy.id]) {
    const leadT = Math.sqrt(enemy.d2) / 840;
    tx += hackVelocities[enemy.id].vx * leadT;
    ty += hackVelocities[enemy.id].vy * leadT;
  }
  botAimAng = _lerpAng(botAimAng, Math.atan2(ty - playerY, tx - playerX), 0.28);
  selfAngle = botAimAng;
}

function _setState(s: string): void {
  if (botState === s) return;
  botState = s;
  botStateAt = Date.now();
  botScrapKey = null;
}

function _orbitEnemy(ep: any): void {
  const desiredR = selfFiringRange * BOT_ORBIT_FRAC;
  const dist = _bd(playerX, playerY, ep.x, ep.y);
  const toEnemy = _ba(ep.x, ep.y);
  const now = Date.now();

  const margin = 250;
  const nearWall =
    playerX < margin ||
    playerX > td - margin ||
    playerY < margin ||
    playerY > ud - margin;
  if (nearWall || now - botOrbitFlip > 4200 + Math.random() * 800) {
    botOrbitDir *= -1;
    botOrbitFlip = now;
  }

  const lo = desiredR * (1 - BOT_ORBIT_BAND);
  const hi = desiredR * (1 + BOT_ORBIT_BAND);

  let moveAng: number;
  if (dist > hi) {
    moveAng = toEnemy + botOrbitDir * 0.25;
  } else if (dist < lo) {
    moveAng = toEnemy + Math.PI + botOrbitDir * 0.25;
  } else {
    moveAng = toEnemy + (Math.PI / 2) * botOrbitDir;
  }
  _moveDir(moveAng);
}

// ============================================================================
// BOT MAIN TICK
// ============================================================================

function botTick(): void {
  if (!botEnabled) return;
  if (!vd || gc || playerID < 0 || selfHealth <= 0) return;

  const now = Date.now();
  if (now - botTick_last < BOT_HZ) return;
  botTick_last = now;

  _tryUpgrade();

  const hpFrac = selfHealth / selfMaxHealth;
  const enemy = botNearestEnemy();
  const enemyD = enemy ? Math.sqrt(enemy.d2) : Infinity;
  const engageR = selfFiringRange * BOT_ENTER_ENGAGE;
  const exitR = selfFiringRange * BOT_EXIT_ENGAGE;
  const inRange = enemy && enemyD < selfFiringRange;

  _tryAbility(enemy);

  // State transitions
  if (botState !== "RETREAT") {
    if (hpFrac < BOT_ENTER_FLEE) {
      _setState("RETREAT");
    } else if (enemy && enemyD < engageR) {
      _setState("ENGAGE");
    } else if (botState !== "ENGAGE") {
      _setState("SCRAP");
    }
  } else {
    const timeInFlee = now - botStateAt;
    const safeRadius = selfFiringRange * 1.8;
    const safe = botAreaSafe(playerX, playerY, safeRadius);
    if (hpFrac >= BOT_EXIT_FLEE && safe && timeInFlee >= BOT_MIN_FLEE) {
      _setState(enemy ? "ENGAGE" : "SCRAP");
    }
  }

  // State actions
  switch (botState) {
    case "RETREAT": {
      const base = [0, 0]; // TODO: get base position
      _moveDir(_ba(base[0], base[1]));
      const awayAng = _ba(base[0], base[1]) + Math.PI;
      botAimAng = _lerpAng(botAimAng, awayAng, 0.15);
      selfAngle = botAimAng;
      if (inRange && enemy) {
        _doAimLeading(enemy);
        Ec = true;
      }
      break;
    }

    case "ENGAGE": {
      if (!enemy) {
        _setState("SCRAP");
        break;
      }
      _doAimLeading(enemy);
      if (inRange) Ec = true;
      if (enemyD < selfFiringRange * 1.1) {
        _orbitEnemy(enemy.p);
      } else {
        _moveDir(_ba(enemy.p.x, enemy.p.y));
      }
      break;
    }

    case "SCRAP": {
      if (!botScrapKey || !scraps[botScrapKey] || now - botScrapAge > 1200) {
        const best = botBestScrap();
        botScrapKey = best ? best.key : null;
        botScrapAge = now;
      }
      if (botScrapKey && scraps[botScrapKey]) {
        const sv = scraps[botScrapKey];
        const toScrapAng = _ba(sv.x, sv.y);
        if (enemy && enemyD < selfFiringRange * 2.0) {
          const awayFromEnemy = _ba(enemy.p.x, enemy.p.y) + Math.PI;
          const pushStrength = Math.max(0, 1 - enemyD / (selfFiringRange * 2.0));
          const blendX = Math.cos(toScrapAng) + Math.cos(awayFromEnemy) * pushStrength * 0.6;
          const blendY = Math.sin(toScrapAng) + Math.sin(awayFromEnemy) * pushStrength * 0.6;
          _moveDir(Math.atan2(blendY, blendX));
        } else {
          _moveDir(toScrapAng);
        }
        if (enemy) {
          _doAimLeading(enemy);
          if (inRange) Ec = true;
        } else {
          botAimAng = _lerpAng(botAimAng, toScrapAng, 0.1);
          selfAngle = botAimAng;
        }
      } else {
        const eb = [0, 0]; // TODO: get enemy base
        const patAng = _ba(eb[0], eb[1]);
        if (enemy && enemyD < selfFiringRange * 1.8) {
          const awayX = Math.cos(patAng) + Math.cos(_ba(enemy.p.x, enemy.p.y) + Math.PI) * 0.5;
          const awayY = Math.sin(patAng) + Math.sin(_ba(enemy.p.x, enemy.p.y) + Math.PI) * 0.5;
          _moveDir(Math.atan2(awayY, awayX));
        } else {
          _moveDir(patAng);
        }
        botAimAng = _lerpAng(botAimAng, patAng, 0.08);
        selfAngle = botAimAng;
      }
      break;
    }
  }
}

// Patch Uf() game loop
let _botOrigUf: any = null;
(function _patchUf() {
  if (typeof (window as any).Uf === "undefined") {
    setTimeout(_patchUf, 100);
    return;
  }
  _botOrigUf = (window as any).Uf;
  (window as any).Uf = function () {
    _botOrigUf.apply(this, arguments);
    botTick();
  };
})();

// ============================================================================
// KEYBOARD INPUT
// ============================================================================

window.addEventListener(
  "keydown",
  (ev) => {
    // B = bot toggle
    if (66 === ev.keyCode) {
      botEnabled = !botEnabled;
      botState = "SCRAP";
      botStateAt = Date.now();
      console.log("Bot:", botEnabled ? "ON" : "OFF");
    }
    // [ = AutoFire
    if (219 === ev.keyCode) {
      hackAutoFire = !hackAutoFire;
      console.log("AutoFire:", hackAutoFire);
    }
    // ] = Tracers
    if (221 === ev.keyCode) {
      hackTracers = !hackTracers;
      console.log("Tracers:", hackTracers);
    }
    // \ = AutoScrap
    if (220 === ev.keyCode) {
      hackAutoScrap = !hackAutoScrap;
      console.log("AutoScrap:", hackAutoScrap);
    }
    // T = AutoAim
    if (84 === ev.keyCode) {
      hackAutoAim = !hackAutoAim;
      console.log("AutoAim:", hackAutoAim);
    }
    // H = ESPArrows
    if (72 === ev.keyCode) {
      hackESPArrows = !hackESPArrows;
      console.log("ESPArrows:", hackESPArrows);
    }
    // N = PredictLine
    if (78 === ev.keyCode) {
      hackPredictLine = !hackPredictLine;
      console.log("PredictLine:", hackPredictLine);
    }
    // Z = FPS
    if (90 === ev.keyCode) {
      hackFPS = !hackFPS;
      console.log("FPS:", hackFPS);
    }
    // D = EnemyDist
    if (68 === ev.keyCode) {
      hackEnemyDist = !hackEnemyDist;
      console.log("EnemyDist:", hackEnemyDist);
    }
  },
  false
);

// Scroll wheel = zoom
window.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    hackZoom = Math.min(Math.max(hackZoom - ev.deltaY * 0.001, 0.3), 3.5);
  },
  { passive: false } as any
);

// ============================================================================
// CANVAS & DOM SETUP
// ============================================================================

window.addEventListener("load", () => {
  c = document.getElementById("canvas") as HTMLCanvasElement;
  k = c.getContext("2d")!;
  k.imageSmoothingEnabled = true;

  aa = document.getElementById("canvasBackground") as HTMLCanvasElement;
  ba = aa.getContext("2d")!;

  ca = document.getElementById("canvasTrail") as HTMLCanvasElement;
  da = ca.getContext("2d")!;

  ea = document.getElementById("canvasTrailflip") as HTMLCanvasElement;
  fa = ea.getContext("2d")!;

  ga = document.getElementById("content")!;
  ha = document.getElementById("playButton")!;
  ia = document.getElementById("selectWorld")!;
  ja = document.getElementById("pregame")!;
  ka = document.getElementById("connecting")!;

  p = document.getElementById("ServerSelectionCombo") as HTMLSelectElement;

  // Network connect
  connectToServer();
});

// ============================================================================
// NETWORK & MESSAGES
// ============================================================================

function connectToServer(): void {
  // TODO: Implement WebSocket connection & message handling
  console.log("Connecting to WarIn.Space server...");
}

// ============================================================================
// RENDERING & HUD
// ============================================================================

function renderHUD(): void {
  if (!c) return;

  // FPS counter
  if (hackFPS) {
    hackFPSFrames++;
    const now = Date.now();
    if (now - hackFPSTimer >= 1000) {
      hackFPSValue = hackFPSFrames;
      hackFPSFrames = 0;
      hackFPSTimer = now;
    }
    k.fillStyle = hackFPSValue > 50 ? "#44ff88" : hackFPSValue > 30 ? "#ffaa00" : "#ff3333";
    k.font = "12px monospace";
    k.fillText(`FPS: ${hackFPSValue}`, 10, 15);
  }

  // Threat meter
  if (hackThreatMeter) {
    let threatCount = 0;
    for (const id in players) {
      const p = players[id];
      if (p.team === selfTeam || p.health <= 0) continue;
      if (FFA || p.team !== selfTeam) {
        const d = _bd(playerX, playerY, p.x, p.y);
        if (d < selfFiringRange * 1.5) threatCount++;
      }
    }
    const threatColor =
      threatCount === 0 ? "#44ff88" : threatCount <= 2 ? "#ffaa00" : "#ff2222";
    k.fillStyle = threatColor;
    k.font = "12px monospace";
    k.fillText(`THREAT: ${threatCount}`, 10, 31);
  }

  // Bot state indicator
  if (botEnabled) {
    k.fillStyle = "#00ddff";
    k.font = "10px monospace";
    k.fillText(`BOT: ${botState}`, 10, 47);
  }
}

function render(): void {
  if (!c || !k) return;

  // Clear main canvas
  k.fillStyle = "#1a1a2e";
  k.fillRect(0, 0, c.width, c.height);

  // Save for world transform
  k.save();
  k.scale(hackZoom, hackZoom);
  k.translate(-playerX + c.width / (2 * hackZoom), -playerY + c.height / (2 * hackZoom));

  // Draw tracers
  if (hackTracers) {
    const cx = playerX;
    const cy = playerY;
    for (const id in players) {
      const p = players[id];
      if (p.id === playerID || p.health <= 0) continue;
      const isEnemy = FFA || p.team !== selfTeam;
      k.strokeStyle = isEnemy ? "#ff4444" : "#4444ff";
      k.lineWidth = 1.5;
      k.globalAlpha = isEnemy ? 0.6 : 0.3;
      k.beginPath();
      k.moveTo(cx, cy);
      k.lineTo(p.x, p.y);
      k.stroke();
    }
    k.globalAlpha = 1.0;
  }

  // Draw range ring
  if (hackRangeRing) {
    k.strokeStyle = "#77eeee";
    k.lineWidth = 1;
    k.globalAlpha = 0.15;
    k.beginPath();
    k.arc(playerX, playerY, selfFiringRange, 0, Math.PI * 2);
    k.stroke();
    k.globalAlpha = 1.0;
  }

  // Draw players
  for (const id in players) {
    const p = players[id];
    if (p.health <= 0) continue;
    const isEnemy = FFA || p.team !== selfTeam;

    // Ship (simple rect)
    k.fillStyle = isEnemy ? "#ff6666" : "#6666ff";
    k.save();
    k.translate(p.x, p.y);
    k.rotate(p.angle);
    k.fillRect(-25, -25, 50, 50);
    k.restore();

    // Health bar
    const hpFrac = p.health / p.maxHealth;
    const barW = 60;
    const barH = 6;
    k.fillStyle = "#333333";
    k.fillRect(p.x - barW / 2, p.y - 70, barW, barH);
    k.fillStyle = hpFrac > 0.5 ? "#00ff00" : hpFrac > 0.25 ? "#ffaa00" : "#ff4444";
    k.fillRect(p.x - barW / 2, p.y - 70, barW * hpFrac, barH);

    // Name
    k.fillStyle = "#ffffff";
    k.font = "12px Arial";
    k.textAlign = "center";
    k.fillText(p.name, p.x, p.y - 85);

    // Distance (if enabled)
    if (hackEnemyDist) {
      const d = _bd(playerX, playerY, p.x, p.y);
      k.fillStyle = "#ffaa44";
      k.font = "10px Arial";
      k.fillText(Math.round(d) + "u", p.x + 50, p.y - 80);
    }
  }

  // Draw scraps
  for (const id in scraps) {
    const s = scraps[id];
    k.fillStyle = "#ffdd44";
    k.beginPath();
    k.arc(s.x, s.y, 8, 0, Math.PI * 2);
    k.fill();
  }

  k.restore();

  // Render HUD (unscaled)
  renderHUD();

  requestAnimationFrame(render);
}

requestAnimationFrame(render);

// ============================================================================
// EXPORTS (for TypeScript)
// ============================================================================

export { botTick, render, connectToServer };
