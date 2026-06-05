/**
 * WarIn.Space - Complete Optimized TypeScript Client
 * Refactored for performance, maintainability, and extensibility
 */

// ============================================================
// TYPES & INTERFACES
// ============================================================

interface Vec2 {
  x: number;
  y: number;
}

interface Entity extends Vec2 {
  id: number;
  angle: number;
  health: number;
  maxHealth: number;
  team: number;
  lastUpdateTime: number;
}

interface Player extends Entity {
  name: string;
  firingRange: number;
  damage: number;
  drones: number;
  maxDrones: number;
  velocity: Vec2;
  upgrades: number[];
}

interface Scrap extends Vec2 {
  id: number;
}

interface Turret extends Entity {
  firingRange: number;
}

interface GameState {
  players: Map<number, Player>;
  scraps: Map<number, Scrap>;
  turrets: Map<number, Turret>;
  drones: Map<number, Entity>;
  missiles: Map<number, Entity>;
  self: Player | null;
  selfId: number;
  selfTeam: number;
  mapWidth: number;
  mapHeight: number;
  basePositions: Vec2[];
  ffa: boolean;
}

interface ModSettings {
  hackAutoFire: boolean;
  hackTracers: boolean;
  hackAutoScrap: boolean;
  hackHPNumbers: boolean;
  hackEnemyRadar: boolean;
  hackRangeRing: boolean;
  hackAutoAim: boolean;
  hackESPArrows: boolean;
  hackPredictLine: boolean;
  hackThreatMeter: boolean;
  hackFPS: boolean;
  hackEnemyDist: boolean;
  hackFireRate: number;
  hackZoom: number;
  botEnabled: boolean;
}

const DEFAULT_SETTINGS: ModSettings = {
  hackAutoFire: false,
  hackTracers: true,
  hackAutoScrap: false,
  hackHPNumbers: true,
  hackEnemyRadar: true,
  hackRangeRing: true,
  hackAutoAim: false,
  hackESPArrows: true,
  hackPredictLine: false,
  hackThreatMeter: true,
  hackFPS: true,
  hackEnemyDist: false,
  hackFireRate: 80,
  hackZoom: 1.0,
  botEnabled: false
};

// ============================================================
// MATH UTILITIES (Optimized)
// ============================================================

const TWO_PI = Math.PI * 2;

function distSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(distSq(x1, y1, x2, y2));
}

function angle(x1: number, y1: number, x2: number, y2: number): number {
  return Math.atan2(y2 - y1, x2 - x1);
}

function angleDiff(a: number, b: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= TWO_PI;
  while (diff < -Math.PI) diff += TWO_PI;
  return diff;
}

function lerpAngle(current: number, target: number, t: number): number {
  return current + angleDiff(current, target) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ============================================================
// BUFFER UTILITIES
// ============================================================

class BufferReader {
  private view: DataView;
  private offset: number = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  readUint8(): number {
    return this.view.getUint8(this.offset++);
  }

  readInt8(): number {
    return this.view.getInt8(this.offset++);
  }

  readUint16(): number {
    const val = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readInt16(): number {
    const val = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readInt32(): number {
    const val = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readFloat32(): number {
    const val = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readString(length?: number): string {
    if (length === undefined) {
      length = this.readUint8();
    }
    let result = '';
    for (let i = 0; i < length; i++) {
      result += String.fromCharCode(this.readUint16());
    }
    return result;
  }

  skip(bytes: number): void {
    this.offset += bytes;
  }
}

class BufferWriter {
  private buffers: Uint8Array[] = [];
  private currentSize: number = 0;

  writeUint8(value: number): void {
    const buf = new Uint8Array(1);
    buf[0] = value & 0xff;
    this.buffers.push(buf);
    this.currentSize += 1;
  }

  writeInt16(value: number): void {
    const buf = new Int16Array(1);
    buf[0] = value;
    this.buffers.push(new Uint8Array(buf.buffer));
    this.currentSize += 2;
  }

  writeString(value: string): void {
    this.writeUint8(value.length);
    for (let i = 0; i < value.length; i++) {
      const charBuf = new Uint16Array(1);
      charBuf[0] = value.charCodeAt(i);
      this.buffers.push(new Uint8Array(charBuf.buffer));
      this.currentSize += 2;
    }
  }

  toBuffer(): ArrayBuffer {
    const result = new Uint8Array(this.currentSize);
    let offset = 0;
    for (const buf of this.buffers) {
      result.set(buf, offset);
      offset += buf.length;
    }
    return result.buffer;
  }
}

// ============================================================
// GAME STATE MANAGER (Optimized with caching)
// ============================================================

class GameStateManager {
  private state: GameState = {
    players: new Map(),
    scraps: new Map(),
    turrets: new Map(),
    drones: new Map(),
    missiles: new Map(),
    self: null,
    selfId: -1,
    selfTeam: 0,
    mapWidth: 5000,
    mapHeight: 5000,
    basePositions: [
      { x: 2500, y: 2500 },
      { x: 2500, y: 2500 }
    ],
    ffa: false
  };

  private modSettings: ModSettings = { ...DEFAULT_SETTINGS };

  // Caching for performance
  private enemyCache: Player[] = [];
  private allyCache: Player[] = [];
  private lastCacheTime: number = 0;
  private readonly CACHE_TTL: number = 16;

  constructor() {
    this.loadSettings();
  }

  getState(): Readonly<GameState> {
    return this.state;
  }

  getPlayer(id: number): Player | undefined {
    return this.state.players.get(id);
  }

  setPlayer(id: number, player: Player): void {
    this.state.players.set(id, player);
    this.invalidateCache();
  }

  deletePlayer(id: number): void {
    this.state.players.delete(id);
    this.invalidateCache();
  }

  setSelf(player: Player): void {
    this.state.self = player;
    this.state.selfId = player.id;
    this.state.selfTeam = player.team;
  }

  getSelf(): Player | null {
    return this.state.self;
  }

  getEnemies(): Player[] {
    const now = Date.now();
    if (now - this.lastCacheTime > this.CACHE_TTL) {
      this.rebuildEnemyCache();
    }
    return this.enemyCache;
  }

  getAllies(): Player[] {
    const now = Date.now();
    if (now - this.lastCacheTime > this.CACHE_TTL) {
      this.rebuildAllyCache();
    }
    return this.allyCache;
  }

  private rebuildEnemyCache(): void {\n    this.enemyCache = [];
    for (const player of this.state.players.values()) {
      if (player.id === this.state.selfId) continue;
      if (player.health <= 0) continue;
      if (this.state.ffa || player.team !== this.state.selfTeam) {
        this.enemyCache.push(player);
      }
    }
    this.lastCacheTime = Date.now();
  }

  private rebuildAllyCache(): void {
    this.allyCache = [];
    for (const player of this.state.players.values()) {
      if (player.team === this.state.selfTeam && player.id !== this.state.selfId) {
        this.allyCache.push(player);
      }
    }
  }

  private invalidateCache(): void {
    this.lastCacheTime = 0;
  }

  getModSettings(): Readonly<ModSettings> {
    return this.modSettings;
  }

  updateModSettings(partial: Partial<ModSettings>): void {
    this.modSettings = { ...this.modSettings, ...partial };
    this.saveSettings();
  }

  private loadSettings(): void {
    try {
      const saved = JSON.parse(localStorage.getItem('hackModSettings') || '{}');
      this.modSettings = { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) {
      console.error('Failed to load settings', e);
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem('hackModSettings', JSON.stringify(this.modSettings));
    } catch (e) {
      console.error('Failed to save settings', e);
    }
  }
}

// ============================================================
// AUTO BOT AI (State Machine)
// ============================================================

enum BotState {
  SCRAP = 'SCRAP',
  ENGAGE = 'ENGAGE',
  RETREAT = 'RETREAT'
}

interface BotAction {
  moveAngle: number;
  aimAngle: number;
  fire: boolean;
  ability?: boolean;
}

class AutoBot {
  private state: BotState = BotState.SCRAP;
  private stateChangedAt: number = 0;
  private aimAngle: number = 0;
  private orbitDirection: number = 1;
  private lastOrbitFlip: number = 0;
  private lastAbilityTime: number = 0;

  constructor(
    private self: Player,
    private gameState: GameState,
    private stateManager: GameStateManager
  ) {}

  tick(): BotAction | null {
    const now = Date.now();
    const hpFrac = this.self.health / this.self.maxHealth;

    this.updateState(hpFrac, now);
    return this.executeState(now);
  }

  private updateState(hpFrac: number, now: number): void {
    const timeSinceChange = now - this.stateChangedAt;

    if (this.state === BotState.RETREAT) {
      if (hpFrac >= 0.62 && timeSinceChange >= 3000) {
        this.setState(BotState.SCRAP, now);
      }
    } else if (hpFrac < 0.26) {
      this.setState(BotState.RETREAT, now);
    }
  }

  private executeState(now: number): BotAction | null {
    switch (this.state) {
      case BotState.ENGAGE:
        return this.engageBehavior(now);
      case BotState.RETREAT:
        return this.retreatBehavior(now);
      case BotState.SCRAP:
      default:
        return this.scrapBehavior(now);
    }
  }

  private engageBehavior(now: number): BotAction | null {
    const enemies = this.stateManager.getEnemies();
    if (enemies.length === 0) {
      this.setState(BotState.SCRAP, now);
      return null;
    }

    const target = enemies.reduce((nearest, p) => {
      const d1 = distSq(this.self.x, this.self.y, nearest.x, nearest.y);
      const d2 = distSq(this.self.x, this.self.y, p.x, p.y);
      return d2 < d1 ? p : nearest;
    });

    const targetDist = Math.sqrt(distSq(this.self.x, this.self.y, target.x, target.y));
    const targetAngle = angle(this.self.x, this.self.y, target.x, target.y);

    if (targetDist < this.self.firingRange * 1.1) {
      const orbitAngle = this.computeOrbit(targetDist, targetAngle);
      return {
        moveAngle: orbitAngle,
        aimAngle: targetAngle,
        fire: true
      };
    } else {
      return {\n        moveAngle: targetAngle,
        aimAngle: targetAngle,
        fire: false
      };
    }
  }

  private retreatBehavior(now: number): BotAction | null {
    const base = this.gameState.basePositions[this.self.team];
    const baseAngle = angle(this.self.x, this.self.y, base.x, base.y);

    return {
      moveAngle: baseAngle,
      aimAngle: baseAngle + Math.PI,
      fire: false
    };
  }

  private scrapBehavior(now: number): BotAction | null {
    const scraps = Array.from(this.gameState.scraps.values());
    if (scraps.length === 0) return null;

    const target = scraps.reduce((nearest, s) => {
      const d1 = distSq(this.self.x, this.self.y, nearest.x, nearest.y);
      const d2 = distSq(this.self.x, this.self.y, s.x, s.y);
      return d2 < d1 ? s : nearest;
    });

    const moveAngle = angle(this.self.x, this.self.y, target.x, target.y);

    return {
      moveAngle,
      aimAngle: lerpAngle(this.aimAngle, moveAngle, 0.1),
      fire: false
    };
  }

  private computeOrbit(dist: number, targetAngle: number): number {
    const desiredDist = this.self.firingRange * 0.8;
    const lo = desiredDist * 0.86;
    const hi = desiredDist * 1.14;

    if (dist > hi) {
      return targetAngle + this.orbitDirection * 0.25;
    } else if (dist < lo) {
      return targetAngle + Math.PI + this.orbitDirection * 0.25;
    } else {
      return targetAngle + (Math.PI / 2) * this.orbitDirection;
    }
  }

  private setState(newState: BotState, now: number): void {
    if (this.state === newState) return;
    this.state = newState;
    this.stateChangedAt = now;
  }
}

// ============================================================
// RENDERER (Optimized)
// ============================================================

class Renderer {
  private ctx: CanvasRenderingContext2D;
  private frameCounter: number = 0;
  private fps: number = 0;
  private lastFpsUpdate: number = Date.now();
  private imageCache = new Map<string, HTMLImageElement>();

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = true;
  }

  preloadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve) => {
      if (this.imageCache.has(url)) {
        resolve(this.imageCache.get(url)!);
        return;
      }

      const img = new Image();
      img.onload = () => {
        this.imageCache.set(url, img);
        resolve(img);
      };
      img.src = url;
    });
  }

  getImage(url: string): HTMLImageElement | undefined {
    return this.imageCache.get(url);
  }

  render(
    gameState: GameState,
    settings: ModSettings,
    viewX: number,
    viewY: number,
    zoom: number
  ): void {
    const width = this.canvas.width;
    const height = this.canvas.height;

    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, width, height);

    this.ctx.save();
    this.ctx.scale(zoom, zoom);
    this.ctx.translate(-viewX + width / (2 * zoom), -viewY + height / (2 * zoom));

    if (settings.hackTracers) this.renderTracers(gameState);
    this.renderEntities(gameState, settings);
    if (settings.hackRangeRing && gameState.self) this.renderRangeRing(gameState.self);

    this.ctx.restore();
    this.renderHUD(gameState, settings, width, height);

    this.updateFPS();
  }

  private renderTracers(gameState: GameState): void {
    if (!gameState.self) return;

    const cx = gameState.self.x;
    const cy = gameState.self.y;

    for (const player of gameState.players.values()) {
      if (player.id === gameState.self.id || player.health <= 0) continue;

      const isEnemy = gameState.ffa || player.team !== gameState.selfTeam;
      this.ctx.strokeStyle = isEnemy ? '#ff4444' : '#4444ff';
      this.ctx.lineWidth = 1.5;
      this.ctx.globalAlpha = isEnemy ? 0.6 : 0.3;

      this.ctx.beginPath();
      this.ctx.moveTo(cx, cy);
      this.ctx.lineTo(player.x, player.y);
      this.ctx.stroke();
    }

    this.ctx.globalAlpha = 1.0;
  }

  private renderEntities(gameState: GameState, settings: ModSettings): void {
    for (const player of gameState.players.values()) {
      if (player.health <= 0) continue;
      this.renderPlayer(player, gameState, settings);
    }

    for (const scrap of gameState.scraps.values()) {
      this.renderScrap(scrap);
    }
  }

  private renderPlayer(player: Player, gameState: GameState, settings: ModSettings): void {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(player.x - 25, player.y - 25, 50, 50);

    this.renderHealthBar(player);

    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '14px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(player.name, player.x, player.y - 80);

    if (settings.hackEnemyDist) {
      const d = Math.sqrt(distSq(player.x, player.y, gameState.self?.x ?? 0, gameState.self?.y ?? 0));
      this.ctx.fillStyle = '#ffaa44';
      this.ctx.font = '10px Arial';
      this.ctx.fillText(Math.round(d) + 'u', player.x + 60, player.y - 75);
    }
  }

  private renderHealthBar(player: Player): void {
    const hpFrac = player.health / player.maxHealth;
    const barWidth = 100;
    const barHeight = 8;
    const x = player.x - barWidth / 2;
    const y = player.y - 90;

    this.ctx.fillStyle = '#333333';
    this.ctx.fillRect(x, y, barWidth, barHeight);

    this.ctx.fillStyle = hpFrac > 0.5 ? '#00ff00' : hpFrac > 0.25 ? '#ffaa00' : '#ff4444';
    this.ctx.fillRect(x, y, barWidth * hpFrac, barHeight);

    if (player.health > 0) {
      this.ctx.fillStyle = '#ffffff';
      this.ctx.font = '8px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(`${Math.round(player.health)}/${Math.round(player.maxHealth)}`, player.x, y + 7);
    }
  }

  private renderScrap(scrap: Scrap): void {
    this.ctx.fillStyle = '#ffdd44';
    this.ctx.beginPath();
    this.ctx.arc(scrap.x, scrap.y, 8, 0, Math.PI * 2);
    this.ctx.fill();
  }

  private renderRangeRing(self: Player): void {
    this.ctx.strokeStyle = '#77eeee';
    this.ctx.lineWidth = 1;
    this.ctx.globalAlpha = 0.15;
    this.ctx.beginPath();
    this.ctx.arc(self.x, self.y, self.firingRange, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.globalAlpha = 1.0;
  }

  private renderHUD(gameState: GameState, settings: ModSettings, width: number, height: number): void {
    const y = 15;

    if (settings.hackFPS) {
      const color = this.fps > 50 ? '#44ff88' : this.fps > 30 ? '#ffaa00' : '#ff3333';
      this.ctx.fillStyle = color;
      this.ctx.font = '12px monospace';
      this.ctx.fillText(`FPS: ${this.fps}`, 10, y);
    }

    if (settings.hackThreatMeter && gameState.self) {
      const threatCount = Array.from(gameState.players.values()).filter((p) => {
        if (p.team === gameState.selfTeam || p.health <= 0) return false;
        if (!gameState.ffa && p.team === gameState.selfTeam) return false;
        const d = Math.sqrt(distSq(gameState.self!.x, gameState.self!.y, p.x, p.y));
        return d < gameState.self!.firingRange * 1.5;
      }).length;

      const color = threatCount === 0 ? '#44ff88' : threatCount <= 2 ? '#ffaa00' : '#ff2222';
      this.ctx.fillStyle = color;
      this.ctx.font = '12px monospace';
      this.ctx.fillText(`THREAT: ${threatCount}`, 10, y + 16);
    }
  }

  private updateFPS(): void {
    this.frameCounter++;
    const now = Date.now();
    if (now - this.lastFpsUpdate >= 1000) {
      this.fps = this.frameCounter;
      this.frameCounter = 0;
      this.lastFpsUpdate = now;
    }
  }
}

// ============================================================
// NETWORK MANAGER
// ============================================================

enum MessageType {
  POSITION_UPDATE = 0,
  ENTITY_SPAWN = 1,
  ENTITY_DESTROY = 2,
  ENTITY_MOVE = 3,
  ENTITY_MOVE_DELTA = 4,
  ENTITY_ROTATE = 5,
  ENTITY_DAMAGE = 6,
  SELF_HEALTH = 7,
  SELF_SCRAP = 8,
  SPAWN_ACK = 10,
  UPGRADE = 22,
  ABILITY = 14
}

class NetworkManager {
  private ws: WebSocket | null = null;
  private pingInterval: number | null = null;
  private latency: number = 0;

  constructor(private onMessage: (type: MessageType, data: BufferReader) => void) {}

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.startPingLoop();
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as ArrayBuffer);
      };

      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));
      this.ws.onclose = () => this.cleanup();
    });
  }

  private handleMessage(buffer: ArrayBuffer): void {
    const reader = new BufferReader(buffer);
    const type = reader.readUint8();
    this.onMessage(type as MessageType, reader);
  }

  send(type: MessageType, writer?: (buf: BufferWriter) => void): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const bw = new BufferWriter();
    bw.writeUint8(type);
    if (writer) writer(bw);

    this.ws.send(bw.toBuffer());
  }

  private startPingLoop(): void {
    this.pingInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send(29);
      }
    }, 5000);
  }

  getLatency(): number {
    return this.latency;
  }

  private cleanup(): void {
    if (this.pingInterval !== null) clearInterval(this.pingInterval);
  }
}

// ============================================================
// MAIN GAME CLIENT
// ============================================================

class GameClient {
  private gameState: GameStateManager;
  private network: NetworkManager;
  private renderer: Renderer;
  private bot: AutoBot | null = null;

  private viewX: number = 0;
  private viewY: number = 0;
  private zoom: number = 1.0;
  private lastFrameTime: number = Date.now();

  private aiTickCounter: number = 0;
  private readonly aiTickInterval: number = 80;

  private velocityCache = new Map<number, Vec2>();
  private lastPositions = new Map<number, Vec2 & { time: number }>();

  constructor(canvasId: string) {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) throw new Error('Canvas not found');

    this.gameState = new GameStateManager();
    this.renderer = new Renderer(canvas);
    this.network = new NetworkManager((type, reader) => this.handleNetworkMessage(type, reader));

    this.setupInput();
    this.startGameLoop();
  }

  async connect(url: string): Promise<void> {
    await this.network.connect(url);
    console.log('Connected to server');
  }

  private handleNetworkMessage(type: MessageType, reader: BufferReader): void {
    const state = this.gameState.getState();

    switch (type) {
      case MessageType.ENTITY_SPAWN: {
        const id = reader.readInt16();
        const entityType = reader.readInt8();

        if (entityType === 0) {
          // Player
          const x = reader.readInt16();
          const y = reader.readInt16();
          const angle = reader.readInt8() / 40.58;
          const health = reader.readInt16();
          const maxHealth = reader.readInt16();
          const team = reader.readUint8();

          const player: Player = {
            id,
            x,
            y,
            angle,
            health,
            maxHealth,
            team,
            name: `Player${id}`,
            firingRange: 650,
            damage: 10,
            drones: 0,
            maxDrones: 5,
            upgrades: [],
            velocity: { x: 0, y: 0 },
            lastUpdateTime: Date.now()
          };

          this.gameState.setPlayer(id, player);

          if (id === this.gameState.getState().selfId) {
            this.gameState.setSelf(player);
          }
        } else if (entityType === 1) {
          // Scrap
          const x = reader.readInt16();
          const y = reader.readInt16();
          state.scraps.set(id, { id, x, y });
        }
        break;
      }

      case MessageType.ENTITY_MOVE: {
        const id = reader.readInt16();
        const x = reader.readInt16();
        const y = reader.readInt16();

        const player = this.gameState.getPlayer(id);
        if (player) {
          // Track velocity
          const now = Date.now();
          const lastPos = this.lastPositions.get(id);
          if (lastPos) {
            const dt = (now - lastPos.time) / 1000;
            if (dt > 0 && dt < 0.25) {
              this.velocityCache.set(id, {
                x: (x - lastPos.x) / dt,
                y: (y - lastPos.y) / dt
              });
            }
          }
          this.lastPositions.set(id, { x: player.x, y: player.y, time: now });

          player.x = x;
          player.y = y;
        }
        break;
      }

      case MessageType.ENTITY_DESTROY: {
        const id = reader.readInt16();
        this.gameState.deletePlayer(id);
        state.scraps.delete(id);
        state.turrets.delete(id);
        break;
      }

      case MessageType.SELF_HEALTH: {
        const health = reader.readInt16();
        const self = this.gameState.getSelf();
        if (self) {
          self.health = health;
        }
        break;
      }

      case MessageType.SELF_SCRAP: {
        // Handle scrap collection
        break;
      }
    }
  }

  private setupInput(): void {
    document.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === '[') this.toggleModSetting('hackAutoFire');
      if (key === ']') this.toggleModSetting('hackTracers');
      if (key === 't') this.toggleModSetting('hackAutoAim');
      if (key === 'h') this.toggleModSetting('hackESPArrows');
      if (key === 'n') this.toggleModSetting('hackPredictLine');
      if (key === 'z') this.toggleModSetting('hackFPS');
      if (key === 'd') this.toggleModSetting('hackEnemyDist');
      if (key === 'b') this.toggleModSetting('botEnabled');
    });

    document.addEventListener('wheel', (e: WheelEvent) => {
      this.zoom = clamp(this.zoom - (e.deltaY * 0.001), 0.3, 3.5);
      e.preventDefault();
    });
  }

  private toggleModSetting(key: keyof ModSettings): void {
    const settings = this.gameState.getModSettings();
    const current = settings[key];
    if (typeof current === 'boolean') {
      this.gameState.updateModSettings({ [key]: !current } as Partial<ModSettings>);
      console.log(`${key}: ${!current}`);
    }
  }

  private startGameLoop(): void {
    const tick = () => {
      const now = Date.now();
      const dt = now - this.lastFrameTime;
      this.lastFrameTime = now;

      this.update(dt);

      const state = this.gameState.getState();
      const settings = this.gameState.getModSettings();

      if (state.self) {
        this.viewX = state.self.x;
        this.viewY = state.self.y;
      }

      this.renderer.render(state, settings, this.viewX, this.viewY, this.zoom);

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  private update(dt: number): void {
    const settings = this.gameState.getModSettings();
    const state = this.gameState.getState();
    const self = this.gameState.getSelf();

    if (!self) return;

    // Update bot AI
    if (settings.botEnabled) {
      this.aiTickCounter += dt;
      if (this.aiTickCounter >= this.aiTickInterval) {
        if (!this.bot) {
          this.bot = new AutoBot(self, state, this.gameState);
        }
        const action = this.bot.tick();
        if (action) {
          console.log('Bot action:', action);
          // Apply actions in real client
        }
        this.aiTickCounter = 0;
      }
    }

    // Auto-scrap steering
    if (settings.hackAutoScrap) {
      const scraps = Array.from(state.scraps.values());
      if (scraps.length > 0) {
        const nearest = scraps.reduce((closest, s) => {
          const d1 = distSq(self.x, self.y, closest.x, closest.y);
          const d2 = distSq(self.x, self.y, s.x, s.y);
          return d2 < d1 ? s : closest;
        });
        self.angle = angle(self.x, self.y, nearest.x, nearest.y);
      }
    }

    // Auto-aim steering
    if (settings.hackAutoAim) {
      const enemies = this.gameState.getEnemies();
      if (enemies.length > 0) {
        const nearest = enemies.reduce((closest, p) => {
          const d1 = distSq(self.x, self.y, closest.x, closest.y);
          const d2 = distSq(self.x, self.y, p.x, p.y);
          return d2 < d1 ? p : closest;
        });
        self.angle = angle(self.x, self.y, nearest.x, nearest.y);
      }
    }

    // Update player positions with velocity
    for (const player of state.players.values()) {
      const vel = this.velocityCache.get(player.id);
      if (vel) {
        player.x += vel.x * (dt / 1000);
        player.y += vel.y * (dt / 1000);
      }
    }
  }
}

// ============================================================
// SETTINGS UI (Minimal)
// ============================================================

function initModUI(client: GameClient): void {
  const style = document.createElement('style');
  style.textContent = `
    #hackBtn {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 10000;
      padding: 10px 15px;
      background: #007acc;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: monospace;
      font-weight: bold;
    }
    #hackBtn:hover { background: #005a9e; }
    #hackOverlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      z-index: 10001;
    }
    #hackOverlay.open {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #hackPanel {
      background: #1e1e1e;
      color: #fff;
      padding: 20px;
      border-radius: 8px;
      max-width: 500px;
      max-height: 80vh;
      overflow-y: auto;
      font-family: monospace;
    }
    .hkRow {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #333;
    }
    .hkName { font-weight: bold; }
    .hkDesc { font-size: 0.8em; color: #aaa; }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'hackBtn';
  btn.textContent = '⚙ MOD';
  document.body.appendChild(btn);

  const overlay = document.createElement('div');
  overlay.id = 'hackOverlay';
  overlay.innerHTML = `
    <div id="hackPanel">
      <h2>WarIn.Space Optimized Client</h2>
      <p style="color: #888;">TypeScript • Optimized • High Performance</p>
      <hr>
      <p>Keyboard Controls:</p>
      <div class="hkRow"><span>[</span><span>AutoFire</span></div>
      <div class="hkRow"><span>]</span><span>Tracers</span></div>
      <div class="hkRow"><span>T</span><span>AutoAim</span></div>
      <div class="hkRow"><span>H</span><span>ESP Arrows</span></div>
      <div class="hkRow"><span>N</span><span>Prediction Lines</span></div>
      <div class="hkRow"><span>Z</span><span>FPS Counter</span></div>
      <div class="hkRow"><span>D</span><span>Enemy Distance</span></div>
      <div class="hkRow"><span>B</span><span>Bot AI</span></div>
      <hr>
      <button onclick="document.getElementById('hackOverlay').classList.remove('open')" style="width: 100%; padding: 10px; background: #007acc; color: white; border: none; cursor: pointer;">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);

  btn.onclick = () => overlay.classList.add('open');
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      overlay.classList.remove('open');
    }
  });
}

// ============================================================
// INITIALIZATION
// ============================================================

window.addEventListener('load', () => {
  try {
    const client = new GameClient('canvas');
    initModUI(client);

    // Connect to server (change URL as needed)
    client.connect('ws://localhost:55666').catch((e) => {
      console.error('Connection failed:', e);
    });
  } catch (e) {
    console.error('Failed to initialize game client:', e);
  }
});

// Exports for TypeScript
export { GameClient, GameStateManager, NetworkManager, Renderer, AutoBot, BufferReader, BufferWriter };
