import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  Extension,
  FurniData,
  FurniDataUtils,
  HDirection,
  HInventoryItem,
  HMessage,
  HPacket,
  HProductType,
  Hotel
} from 'gnode-api';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AppState,
  BoxState,
  FurniCard,
  LootEntry,
  Notice,
  PriceInfo,
  PrizeLevel,
  QueueEntry,
  RecycleFurni,
  RecyclerPhase,
  RecyclerState,
  Settings
} from './recycle-furni';

const BATCH_SIZE = 8;              // the Furni-Matic only takes full batches
const MIN_BATCH_GAP = 3000;        // never feed it faster than this, even when the hotel reports no pause
const STATUS_TIMEOUT = 4000;       // then the batch waits out the hotel's pause instead of asking again
const LATE_STATUS_WINDOW = 15000;  // answers to our status request that come late are still ours
const PAUSE_MARGIN = 1500;         // on top of the pause the hotel asked for, when it stops answering
const DEFAULT_PAUSE = 10000;       // what habbo.es asks between batches, until the hotel tells otherwise
const REFUSED_RETRIES = 2;
const FINISH_TIMEOUT = 15000;
const INVENTORY_TIMEOUT = 4000;
const PRICE_TIMEOUT = 4000;
const PRICE_GAP = 300;
const BOX_OPEN_DELAY = 1000;       // gives the hotel time to put the prize box in the inventory
const PRIZE_BOX_WAIT = 3000;       // how long the new box gets to show up before trusting the prize id
const BOX_STEP_TIMEOUT = 5000;
const BOX_STEP_GAP = 400;          // between placing and opening, and between opening and picking up
const BOX_GAP = 1200;
const COST_WINDOW = 10000;
const ECHO_WINDOW = 4000;          // hotel reactions to our own actions that the game shouldn't see
const LOOT_LIMIT = 500;            // prizes kept in the log, across sessions
const PRICE_TTL = 12 * 60 * 60 * 1000;  // Marketplace prices are reused for this long before asking again
// The Furni-Matic's prize box ("Caja Misteriosa", type 4392 on habbo.es) and the old Ecotron one.
// Gifts from other people (present_*) are never opened
const PRIZE_BOXES = new Set(['matic_box', 'ecotron_box']);
const isPrizeBox = (data?: { classname: string }) => !!data && PRIZE_BOXES.has(data.classname);

// Codes as the Habbo client reads them from RecyclerStatus, RecyclerFinished and the activity points
const RECYCLER_OPEN = 1;
const RECYCLER_COOLDOWN = 3;
const RECYCLE_OK = 1;
const DUCKETS = 0;

const HOTELS: Record<string, { hotel: Hotel; name: string }> = {
  'game-nl.habbo.com': { hotel: Hotel.NL, name: 'habbo.nl' },
  'game-br.habbo.com': { hotel: Hotel.COMBR, name: 'habbo.com.br' },
  'game-tr.habbo.com': { hotel: Hotel.COMTR, name: 'habbo.com.tr' },
  'game-de.habbo.com': { hotel: Hotel.DE, name: 'habbo.de' },
  'game-fr.habbo.com': { hotel: Hotel.FR, name: 'habbo.fr' },
  'game-fi.habbo.com': { hotel: Hotel.FI, name: 'habbo.fi' },
  'game-es.habbo.com': { hotel: Hotel.ES, name: 'habbo.es' },
  'game-it.habbo.com': { hotel: Hotel.IT, name: 'habbo.it' },
  'game-us.habbo.com': { hotel: Hotel.COM, name: 'habbo.com' },
  'game-s2.habbo.com': { hotel: Hotel.SANDBOX, name: 'sandbox.habbo.com' },
};

const DEFAULT_SETTINGS: Settings = {
  priceCap: 3,
  defaultKeep: 0,
  hideExpensive: true,
  autoOpen: true,
  alwaysOnTop: false,
  language: 'auto',
  locked: [],
  spots: {},
};

const LANGUAGES: Settings['language'][] = ['auto', 'en', 'es', 'pt'];

type InventoryRequest = 'RequestFurniInventory' | 'RequestFurniInventoryWhenNotInRoom';

interface PrizeBox {
  placeId: number;
}

// A box goes through the room: placed on the chosen tile, opened, and its prize picked back up
interface BoxJob {
  id: number;
  entry: LootEntry;
  step: 'placing' | 'opening' | 'pickingUp';
  prizeId?: number;
  timer: NodeJS.Timeout;
}

// Colour variants are named "chair*3" in furnidata but "chair_3" on the image server
const iconUrl = (data: RecycleFurni['data']) =>
  data ? `https://images.habbo.com/dcr/hof_furni/${data.revision}/${data.classname.replace('*', '_')}_icon.png` : '';

// LTDs and rentals stay out even when the hotel flags them as recyclable
const canRecycle = (item: HInventoryItem) =>
  item.isRecyclable &&
  item.secondsToExpiration <= 0 &&
  !item.hasRentPeriodStarted &&
  (item.stuffCategory & 0xff00 & 0x100) === 0;

// Diagnostics in the terminal that runs the extension (yarn start)
const log = (...args: unknown[]) => console.log('[G-FurniMatic]', ...args);

class Ui {
  public win?: BrowserWindow;

  constructor() {
    ipcMain.on('window:minimize', () => this.win?.minimize());
    ipcMain.on('window:maximize', () =>
      this.win?.isMaximized() ? this.win.unmaximize() : this.win?.maximize()
    );
    ipcMain.on('window:close', () => this.win?.close());

    // Closing the window only hides the UI: the extension keeps running and G-Earth's button reopens it
    app.on('window-all-closed', () => {});
  }

  public startUi(alwaysOnTop: boolean) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    this.win = new BrowserWindow({
      width: 980,
      height: 760,
      minWidth: 760,
      minHeight: 480,
      frame: false,
      show: false,
      backgroundColor: '#1f2b33',
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, '../renderer/preload.js'),
      },
    });

    this.win.loadFile(path.join(__dirname, '../renderer/index.html'));
    this.win.once('ready-to-show', () => this.win?.show());
    this.win.setAlwaysOnTop(alwaysOnTop);

    this.win.on('closed', () => {
      this.win = undefined;
    });
  }

  public setAlwaysOnTop(state: boolean) {
    this.win?.setAlwaysOnTop(state);
  }

  // The window usually sits behind the game: blink in the taskbar when a run ends
  public flash() {
    const win = this.win;
    if (!win || win.isDestroyed() || win.isFocused()) return;
    win.flashFrame(true);
    win.once('focus', () => win.flashFrame(false));
  }

  public sendState(state: AppState) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('state', state);
  }
}

class GFurniMatic {
  private readonly ui = new Ui();
  private readonly ext: Extension;
  private readonly settingsFile = path.join(app.getPath('userData'), 'settings.json');
  private settings: Settings = this.loadSettings();

  private hotel: string | null = null;
  private furniData?: FurniData;
  private furniDataStatus: AppState['furniData'] = 'waiting';
  private readonly furniDataReady: Promise<void>;
  private resolveFurniDataReady!: () => void;

  private furniture: Map<number, RecycleFurni> = new Map();
  private inventoryStatus: AppState['inventory']['status'] = 'idle';
  private inventoryProgress: [number, number] | null = null;
  private inventoryVersion = 0;
  private inventoryRequest: InventoryRequest = 'RequestFurniInventory';
  private inventoryTimer?: NodeJS.Timeout;

  // typeId -> how many of that furni to keep, in the order they were queued
  private queue: Map<number, number> = new Map();
  private allowed: Set<number> = new Set();
  private prices: Map<number, PriceInfo> = new Map();
  private priceAt: Map<number, number> = new Map();
  private priceQueue: number[] = [];
  private pricePending?: { typeId: number; timer: NodeJS.Timeout };
  private saveTimers: Map<string, NodeJS.Timeout> = new Map();

  // The Furni-Matic's prize table: which furni can come out of a box, at which level and how often
  private prizeTable: Map<string, { level: number; odds: number }> = new Map();
  private prizeLevels: PrizeLevel[] = [];
  private awaitingPrizes = false;

  private recycler: Pick<RecyclerState, 'running' | 'phase' | 'cooldownUntil' | 'cooldownTotal' | 'batchesSent' | 'notice'> = {
    running: false,
    phase: 'idle',
    cooldownUntil: null,
    cooldownTotal: null,
    batchesSent: 0,
    notice: null,
  };
  private runBatches = 0;
  private runStartedAt = 0;
  private runOnce = false;
  private pendingBatch?: HInventoryItem[];
  private loopTimer?: NodeJS.Timeout;
  private hotelTimer?: NodeJS.Timeout;
  private lastSentAt = 0;
  private lastBatchAt = 0;

  // The hotel's answers to our own requests are kept from the game, or it plays sounds and shows
  // popups for things the person never did in the client
  private awaitingStatus = false;
  private statusAskedAt = 0;
  private statusUnanswered = false;
  private ownActionAt = 0;
  // The full pause the hotel asks for after a batch, learned from its answers
  private hotelPause = DEFAULT_PAUSE;
  private refusedRetries = 0;

  private duckets: number | null = null;
  private batchCost: number | null = null;
  private loot: LootEntry[] = [];
  private lootKey = 0;

  private room: { id: number; owner: boolean } | null = null;
  private roomUnknown = false;
  // Prize boxes in the inventory by furni id, with the id the inventory uses to place them. A box only
  // gets a line in the prize log once it's opened, so a box can never show up twice
  private boxes: Map<number, PrizeBox> = new Map();
  private boxQueue: number[] = [];
  private boxRun: { done: number; total: number } | null = null;
  private boxFailed: BoxState['failed'] = null;
  private boxJob?: BoxJob;
  private boxTimer?: NodeJS.Timeout;
  private pickingSpot = false;
  // Boxes owed by finished batches that haven't shown up in the inventory yet (below 0 when a box
  // arrived before its RecyclerFinished)
  private boxesOwed = 0;
  private boxCheckTimer?: NodeJS.Timeout;
  private openBoxesAfterRefresh = false;

  private statePending = false;

  constructor() {
    const extensionInfo = JSON.parse(
      readFileSync(new URL('./extension.json', import.meta.url)).toString()
    );

    this.furniDataReady = new Promise((resolve) => {
      this.resolveFurniDataReady = resolve;
    });

    // G-Earth passes -p when it launches the extension; fall back to its default port when run standalone
    const args = process.argv.some((arg) => ['-p', '--port'].includes(arg.toLowerCase()))
      ? process.argv
      : [...process.argv, '-p', '9092'];

    this.ext = new Extension(extensionInfo, args);
    this.loadLoot();

    this.ext.on('click', () => this.openUi());
    this.ext.on('connect', (host: string) => this.onConnect(host));
    // G-Earth (and the extension store) expect the process to end once the connection is gone
    this.ext.on('socketdisconnect', () => app.quit());
    this.ext.run();

    this.registerInterceptors();
    this.registerIpc();
  }

  // A packet that doesn't look like expected (the hotel changes them now and then) is logged and
  // skipped: it must never take the extension down with an error dialog
  private safely(name: string, handler: (hMessage: HMessage) => unknown) {
    return (hMessage: HMessage) => {
      const fail = (err: unknown) => console.error(`Couldn't handle ${name}:`, err);
      try {
        Promise.resolve(handler.call(this, hMessage)).catch(fail);
      } catch (err) {
        fail(err);
      }
    };
  }

  private registerInterceptors() {
    const on = (name: string, handler: (hMessage: HMessage) => unknown) =>
      this.ext.interceptByNameOrHash(HDirection.TOCLIENT, name, this.safely(name, handler));

    on('FurniList', this.onFurniList);
    on('FurniListAddOrUpdate', this.onFurniListAddOrUpdate);
    on('FurniListRemove', this.onFurniListRemove);
    on('FurniListInvalidate', () => {
      if (this.inventoryStatus !== 'idle') this.refreshInventory();
    });
    on('RecyclerStatus', this.onRecyclerStatus);
    on('RecyclerPrizes', this.onRecyclerPrizes);
    on('RecyclerFinished', this.onRecyclerFinished);
    on('PresentOpened', this.onPresentOpened);
    on('MarketplaceItemStats', this.onMarketplaceItemStats);
    on('ActivityPoints', this.onActivityPoints);
    on('HabboActivityPointNotification', this.onActivityPointNotification);
    on('RoomEntryInfo', this.onRoomEntryInfo);
    on('CloseConnection', this.leaveRoom);
    on('ObjectAdd', this.onObjectAdd);
    on('ObjectRemove', this.onObjectRemove);
    this.ext.interceptByNameOrHash(HDirection.TOSERVER, 'OpenFlatConnection', this.safely('OpenFlatConnection', this.leaveRoom));
    this.ext.interceptByNameOrHash(HDirection.TOSERVER, 'MoveAvatar', this.safely('MoveAvatar', this.onMoveAvatar));

    // "New item" badges and hotel popups that follow a batch or a box we opened
    const hideEcho = (hMessage: HMessage) => {
      if (this.isEcho()) hMessage.blocked = true;
    };
    on('UnseenItems', hideEcho);
    // Logged to see why the hotel refuses something; reading them must never get in the way
    const peek = (read: () => unknown) => {
      try {
        return read();
      } catch {
        return '?';
      }
    };
    on('NotificationDialog', (hMessage) => {
      if (this.isEcho()) log('NotificationDialog after our action:', peek(() => hMessage.getPacket().readString(6)));
      hideEcho(hMessage);
    });
    on('PurchaseError', (hMessage) => {
      if (this.isEcho()) log('PurchaseError after our action, code', peek(() => hMessage.getPacket().readInteger(6)));
    });
  }

  private isEcho() {
    return Date.now() - this.ownActionAt < ECHO_WINDOW;
  }

  private registerIpc() {
    const isId = (value: unknown): value is number => Number.isInteger(value);

    // The window asks for the whole state when it loads, then gets every change pushed
    ipcMain.handle('state:get', () => this.snapshot());

    ipcMain.on('inventory:refresh', () => this.refreshInventory());
    ipcMain.on('queue:toggle', (_event, typeId: unknown) => {
      if (isId(typeId)) this.toggleQueue(typeId);
    });
    ipcMain.on('queue:keep', (_event, typeId: unknown, keep: unknown) => {
      if (isId(typeId) && Number.isFinite(keep)) this.setKeep(typeId, keep as number);
    });
    ipcMain.on('queue:allow', (_event, typeId: unknown) => {
      if (isId(typeId)) this.toggleAllowed(typeId);
    });
    // The answer to the "too expensive" warning: these go into batches despite the price limit
    ipcMain.on('queue:allowMany', (_event, typeIds: unknown) => {
      if (!Array.isArray(typeIds)) return;
      for (const typeId of typeIds.filter(isId)) if (this.queue.has(typeId)) this.allowed.add(typeId);
      this.pushState();
    });
    ipcMain.on('queue:remove', (_event, typeId: unknown) => {
      if (isId(typeId)) this.removeFromQueue(typeId);
    });
    ipcMain.on('queue:addMany', (_event, typeIds: unknown) => {
      if (Array.isArray(typeIds)) this.addManyToQueue(typeIds.filter(isId));
    });
    ipcMain.on('queue:clear', () => this.clearQueue());
    ipcMain.on('furni:lock', (_event, typeId: unknown) => {
      if (isId(typeId)) this.toggleLock(typeId);
    });
    ipcMain.on('recycler:start', () => this.start(false));
    ipcMain.on('recycler:once', () => this.start(true));
    ipcMain.on('recycler:stop', () => this.stop());
    ipcMain.on('boxes:open', () => this.openBoxes([...this.boxes.keys()]));
    ipcMain.on('boxes:stop', () => this.stopBoxes());
    ipcMain.on('boxes:pickSpot', (_event, picking: unknown) => this.setPickingSpot(picking === true));
    // Locks and box tiles have their own actions; the window only edits the plain options
    ipcMain.on('settings:update', (_event, patch: unknown) => {
      if (!patch || typeof patch !== 'object') return;
      const { locked, spots, ...options } = patch as Partial<Settings>;
      this.updateSettings(options);
    });
  }

  private openUi() {
    this.ui.startUi(this.settings.alwaysOnTop);
    this.refreshInventory();
    this.requestPrizeTable();
  }

  // ---- Files next to the settings: prize log and Marketplace prices ----

  private dataFile(name: string) {
    return path.join(path.dirname(this.settingsFile), name);
  }

  private readData<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.dataFile(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  // Writes are bundled: a batch can change the log and several prices within a second
  private saveSoon(name: string, data: () => unknown) {
    clearTimeout(this.saveTimers.get(name));
    this.saveTimers.set(name, setTimeout(() => {
      try {
        mkdirSync(path.dirname(this.settingsFile), { recursive: true });
        writeFileSync(this.dataFile(name), JSON.stringify(data()));
      } catch (err) {
        console.error(`Could not save ${name}:`, err);
      }
    }, 1000));
  }

  private loadLoot() {
    const saved = this.readData<LootEntry[]>('prizes.json', []);
    // A box that was opening when the app closed never got its answer
    this.loot = saved.filter((entry) => entry.status === 'opened');
    this.lootKey = Math.max(0, ...this.loot.map((entry) => entry.key));
  }

  private saveLoot() {
    this.saveSoon('prizes.json', () => this.loot);
  }

  private pricesFile() {
    return `prices-${this.hotel ?? 'unknown'}.json`;
  }

  private loadPrices() {
    const saved = this.readData<Record<string, { price: PriceInfo; at: number }>>(this.pricesFile(), {});
    for (const [typeId, { price, at }] of Object.entries(saved)) {
      if (Date.now() - at > PRICE_TTL) continue;
      this.prices.set(Number(typeId), price);
      this.priceAt.set(Number(typeId), at);
    }
  }

  private savePrices() {
    const file = this.pricesFile();
    this.saveSoon(file, () => {
      const out: Record<number, { price: PriceInfo; at: number }> = {};
      for (const [typeId, price] of this.prices) {
        const at = this.priceAt.get(typeId);
        if (at && (price.status === 'known' || price.status === 'none')) out[typeId] = { price, at };
      }
      return out;
    });
  }

  // ---- Prize table ----

  private requestPrizeTable() {
    if (this.prizeLevels.length > 0 || this.awaitingPrizes || !this.hotel) return;
    this.awaitingPrizes = true;
    this.ext.sendToServer(new HPacket('GetRecyclerPrizes', HDirection.TOSERVER));
    setTimeout(() => (this.awaitingPrizes = false), STATUS_TIMEOUT);
  }

  private onRecyclerPrizes(hMessage: HMessage) {
    if (this.awaitingPrizes) hMessage.blocked = true; // the game's own catalog page still gets its copy
    this.awaitingPrizes = false;

    const levels = this.readPrizeTable(hMessage.getPacket());
    if (!levels) {
      console.warn('RecyclerPrizes came in a layout this version does not know; prizes are logged without rarity');
      return;
    }

    this.prizeTable.clear();
    for (const { level, odds, prizes } of levels) {
      for (const [type, typeId] of prizes) this.prizeTable.set(`${type.toLowerCase()}${typeId}`, { level, odds });
    }

    // Rarity goes by how unlikely a level is, whatever number the hotel gives it
    const byOdds = levels.map(({ level, odds }) => ({ level, odds })).sort((a, b) => a.odds - b.odds);
    const top = Math.max(1, byOdds.length - 1);
    this.prizeLevels = byOdds.map((entry, rank) => ({ ...entry, tier: Math.round((rank * 4) / top) }));
    this.pushState();
  }

  // The prize table has had several shapes over the client versions. Each level is always
  // [level][1 in N][prize count]; what changes is each prize. The right shape is the one that reads
  // the packet to its last byte
  private readPrizeTable(packet: HPacket) {
    const products = (): [string, number][] => {
      const size = packet.readInteger();
      if (size < 0 || size > 50) throw new Error(`unlikely bundle size ${size}`);
      return size <= 1 ? [packet.read('Si') as [string, number]] : Array.from({ length: size }, () => packet.read('Si') as [string, number]);
    };
    const prizeShapes = [
      () => (packet.readString(), products()),                         // [code][size][type][id]...
      () => (packet.readInteger(), packet.readString(), products()),   // [?][code][size][type][id]...
      () => [packet.read('Si') as [string, number]],                   // [type][id], older clients
    ];

    for (const readPrize of prizeShapes) {
      try {
        packet.resetReadIndex();
        const levels: { level: number; odds: number; prizes: [string, number][] }[] = [];
        const levelCount = packet.readInteger();
        if (levelCount < 1 || levelCount > 20) continue;

        for (let i = 0; i < levelCount; i++) {
          const [level, odds, count] = packet.read('iii');
          if (odds < 1 || count < 0 || count > 2000) throw new Error('unlikely level');
          const prizes: [string, number][] = [];
          for (let j = 0; j < count; j++) prizes.push(...readPrize());
          levels.push({ level, odds, prizes });
        }
        if (packet.readIndex === packet.getBytesLength()) return levels;
      } catch {
        // not this shape
      }
    }
    return null;
  }

  private prizeInfo(type: string, typeId: number) {
    const prize = this.prizeTable.get(`${type.toLowerCase()}${typeId}`);
    if (!prize) return { level: null, odds: null, tier: null };
    const tier = this.prizeLevels.find((entry) => entry.level === prize.level)?.tier ?? null;
    return { ...prize, tier };
  }

  private async onConnect(host: string) {
    const known = HOTELS[host];
    if (!known) console.warn(`Unknown hotel host: ${host}`);

    // Duckets aren't asked for: the balance comes with the hotel's own updates, and every extra
    // request is one more thing happening that the person didn't do
    this.hotel = known?.name ?? host;
    this.loadPrices();
    if (this.ui.win) {
      this.refreshInventory();
      this.requestPrizeTable();
    }
    this.pushState();

    await this.loadFurniData(known?.hotel);
  }

  private async loadFurniData(hotel?: Hotel) {
    if (this.furniData) return;
    if (!hotel) {
      this.furniDataStatus = 'failed';
      this.pushState();
      return;
    }

    this.furniDataStatus = 'loading';
    this.pushState();

    try {
      this.furniData = await FurniDataUtils.fetch(hotel);
      this.furniDataStatus = 'ready';
      this.resolveFurniDataReady();
    } catch (err) {
      console.error('Failed to load furnidata:', err);
      this.furniDataStatus = 'failed';
    }
    this.pushState();
  }

  // ---- Inventory ----

  private refreshInventory() {
    this.inventoryStatus = 'loading';
    this.inventoryProgress = null;
    this.requestInventory(true);
    this.pushState();
  }

  private requestInventory(canRetry: boolean) {
    clearTimeout(this.inventoryTimer);
    this.ext.sendToServer(new HPacket(this.inventoryRequest, HDirection.TOSERVER));

    // Outside a room the hotel ignores the in-room request (and the other way round), so try the other one
    this.inventoryTimer = setTimeout(() => {
      if (canRetry) {
        this.inventoryRequest =
          this.inventoryRequest === 'RequestFurniInventory'
            ? 'RequestFurniInventoryWhenNotInRoom'
            : 'RequestFurniInventory';
        this.requestInventory(false);
      } else {
        this.inventoryStatus = 'failed';
        this.pushState();
      }
    }, INVENTORY_TIMEOUT);
  }

  private async onFurniList(hMessage: HMessage) {
    clearTimeout(this.inventoryTimer);

    const packet = hMessage.getPacket();
    const fragments = packet.readInteger(6);
    const fragment = packet.readInteger(10);
    const items = HInventoryItem.parse(packet);

    await this.furniDataReady;
    if (!this.furniData) return;

    // The game asks for the inventory too: a new first fragment is a fresh copy, not more furni
    if (fragment === 0) {
      this.furniture.clear();
      this.boxes = new Map();
    }

    for (const item of items) {
      const furniData =
        item.furniType === HProductType.WallItem
          ? this.furniData.getWallItemByTypeId(item.typeId)
          : this.furniData.getFloorItemByTypeId(item.typeId);

      if (isPrizeBox(furniData)) {
        this.boxes.set(item.id, { placeId: item.itemId });
        continue;
      }
      if (!canRecycle(item)) continue;

      const existing = this.furniture.get(item.typeId);
      if (existing) existing.items.push(item);
      else this.furniture.set(item.typeId, { items: [item], data: furniData });
    }

    this.inventoryProgress = [fragment + 1, fragments];
    if (fragment + 1 >= fragments) {
      this.inventoryStatus = 'ready';
      const sample = [...this.furniture.values()].slice(0, 3).map((furni) => furni.items[0]);
      log('inventory ready,', this.furniture.size, 'kinds. Sample (inventory id / furni id / type / kind):',
        sample.map((i) => `${i.itemId} / ${i.id} / ${i.typeId} / ${i.furniType}`).join(', '));
      for (const typeId of this.queue.keys()) {
        if (this.recyclableCount(typeId) === 0) this.queue.delete(typeId);
      }
      this.checkInventoryPrices();
      if (this.openBoxesAfterRefresh) {
        this.openBoxesAfterRefresh = false;
        this.autoOpen([...this.boxes.keys()]);
      }
    }
    this.inventoryVersion++;
    this.pushState();
  }

  private removeFromInventory(batch: HInventoryItem[]) {
    const recycled = new Set(batch.map((item) => item.id));

    for (const typeId of new Set(batch.map((item) => item.typeId))) {
      const furni = this.furniture.get(typeId);
      if (!furni) continue;

      furni.items = furni.items.filter((item) => !recycled.has(item.id));
      if (furni.items.length === 0) this.furniture.delete(typeId);
      if (this.recyclableCount(typeId) === 0) this.queue.delete(typeId);
    }
    this.inventoryVersion++;
  }

  private isLocked(furni: RecycleFurni) {
    return !!furni.data && this.settings.locked.includes(furni.data.classname);
  }

  private toggleLock(typeId: number) {
    const classname = this.furniture.get(typeId)?.data?.classname;
    if (!classname) return;

    const locked = new Set(this.settings.locked);
    if (locked.has(classname)) {
      locked.delete(classname);
    } else {
      locked.add(classname);
      this.queue.delete(typeId);
    }

    this.inventoryVersion++;
    this.updateSettings({ locked: [...locked] });
  }

  // ---- Queue ----

  private toggleQueue(typeId: number) {
    if (this.queue.has(typeId)) this.removeFromQueue(typeId);
    else this.addToQueue(typeId);
  }

  private addToQueue(typeId: number) {
    const furni = this.furniture.get(typeId);
    if (!furni || this.isLocked(furni) || this.queue.has(typeId)) return;

    this.queue.set(typeId, Math.min(this.settings.defaultKeep, furni.items.length));
    this.requestPrice(typeId);
    this.pushState();
  }

  private addManyToQueue(typeIds: number[]) {
    for (const typeId of typeIds) this.addToQueue(typeId);
  }

  private setKeep(typeId: number, keep: number) {
    const furni = this.furniture.get(typeId);
    if (!furni || !this.queue.has(typeId)) return;

    this.queue.set(typeId, Math.max(0, Math.min(Math.floor(keep), furni.items.length)));
    this.pushState();
  }

  private toggleAllowed(typeId: number) {
    if (this.allowed.has(typeId)) this.allowed.delete(typeId);
    else this.allowed.add(typeId);
    this.pushState();
  }

  private removeFromQueue(typeId: number) {
    this.queue.delete(typeId);
    this.allowed.delete(typeId);
    this.pushState();
  }

  private clearQueue() {
    this.queue.clear();
    this.allowed.clear();
    this.pushState();
  }

  private recyclableCount(typeId: number) {
    const available = this.furniture.get(typeId)?.items.length ?? 0;
    return Math.max(0, available - (this.queue.get(typeId) ?? 0));
  }

  private isHeldBack(typeId: number) {
    if (this.settings.priceCap === 0 || this.allowed.has(typeId)) return false;

    const price = this.prices.get(typeId);
    if (!price || price.status === 'loading' || price.status === 'failed') return true;
    return price.status === 'known' && price.average > this.settings.priceCap;
  }

  private isPriceLoading(typeId: number) {
    return this.prices.get(typeId)?.status === 'loading';
  }

  private nextBatch() {
    const batch: HInventoryItem[] = [];

    for (const typeId of this.queue.keys()) {
      if (this.isHeldBack(typeId)) continue;

      const take = Math.min(this.recyclableCount(typeId), BATCH_SIZE - batch.length);
      batch.push(...(this.furniture.get(typeId)?.items.slice(0, take) ?? []));
      if (batch.length === BATCH_SIZE) break;
    }

    return batch;
  }

  private totals() {
    let recyclable = 0;
    let heldBack = 0;
    let checking = 0;

    for (const typeId of this.queue.keys()) {
      const count = this.recyclableCount(typeId);
      if (!this.isHeldBack(typeId)) recyclable += count;
      else if (this.isPriceLoading(typeId)) checking += count;
      else heldBack += count;
    }

    return {
      batchesLeft: Math.floor(recyclable / BATCH_SIZE),
      leftover: recyclable % BATCH_SIZE,
      heldBack,
      checking,
    };
  }

  // ---- Marketplace prices ----

  // Queued furni jump ahead; the rest of the inventory is checked in the background so furni over
  // the safe price can be kept out of the list
  private requestPrice(typeId: number, urgent = true) {
    const known = this.prices.get(typeId);
    if (known?.status === 'loading') {
      if (urgent && this.priceQueue.includes(typeId)) {
        this.priceQueue = [typeId, ...this.priceQueue.filter((id) => id !== typeId)];
      }
      return;
    }
    if (known && known.status !== 'failed' && Date.now() - (this.priceAt.get(typeId) ?? Date.now()) < PRICE_TTL) return;

    const furni = this.furniture.get(typeId);
    if (!furni) return;

    if (!furni.items[0].isSellable) {
      this.prices.set(typeId, { status: 'unsellable' });
      return;
    }

    this.prices.set(typeId, { status: 'loading' });
    if (urgent) this.priceQueue.unshift(typeId);
    else this.priceQueue.push(typeId);
    this.nextPriceRequest();
  }

  private checkInventoryPrices() {
    for (const typeId of this.furniture.keys()) this.requestPrice(typeId, false);
    this.pushState();
  }

  // One request at a time, so a long queue doesn't flood the hotel
  private nextPriceRequest() {
    if (this.pricePending) return;

    const typeId = this.priceQueue.shift();
    if (typeId === undefined) return;

    const furni = this.furniture.get(typeId);
    if (!furni) {
      this.prices.delete(typeId);
      this.nextPriceRequest();
      return;
    }

    const category = furni.items[0].furniType === HProductType.WallItem ? 2 : 1;
    this.ext.sendToServer(
      new HPacket('GetMarketplaceItemStats', HDirection.TOSERVER).appendInt(category).appendInt(typeId)
    );
    this.pricePending = {
      typeId,
      timer: setTimeout(() => this.settlePrice(typeId, { status: 'failed' }), PRICE_TIMEOUT),
    };
  }

  private settlePrice(typeId: number, price: PriceInfo) {
    if (this.pricePending?.typeId !== typeId) return;

    clearTimeout(this.pricePending.timer);
    this.pricePending = undefined;
    this.prices.set(typeId, price);
    this.priceAt.set(typeId, Date.now());
    this.savePrices();
    this.pushState();
    setTimeout(() => this.nextPriceRequest(), PRICE_GAP);
  }

  private onMarketplaceItemStats(hMessage: HMessage) {
    const packet = hMessage.getPacket();
    const [average, , , points] = packet.read('iiii');
    for (let i = 0; i < points * 3; i++) packet.readInteger();
    const [, typeId] = packet.read('ii');

    if (this.pricePending?.typeId !== typeId) return; // the game's own Marketplace window asked
    hMessage.blocked = true;
    this.settlePrice(typeId, average > 0 ? { status: 'known', average } : { status: 'none' });
  }

  // ---- Recycler ----

  // Keeps feeding batches until the queue can't fill another one, or just one batch when asked
  private start(once: boolean) {
    if (this.recycler.running) return;

    this.recycler.running = true;
    this.recycler.notice = null;
    this.runOnce = once;
    this.runBatches = 0;
    this.refusedRetries = 0;
    this.runStartedAt = Date.now();
    this.checkRecycler();
  }

  // Stopping by itself (with a notice) means the run is over: worth a blink if the window is behind the game
  private stop(notice: Notice | null = null) {
    clearTimeout(this.loopTimer);
    if (notice) log('recycling stopped:', notice.code, JSON.stringify(notice.values));
    this.statusUnanswered = false;
    this.recycler.running = false;
    this.recycler.notice = notice;
    // A batch already sent still gets its answer, so the inventory stays right
    if (!this.pendingBatch) this.setPhase('idle');
    if (notice) this.ui.flash();
    this.pushState();
  }

  private notice(tone: Notice['tone'], code: Notice['code'], values: Notice['values'] = {}): Notice {
    return { tone, code, values };
  }

  private setPhase(phase: RecyclerPhase, cooldown?: number) {
    this.recycler.phase = phase;
    this.recycler.cooldownTotal = cooldown ?? null;
    this.recycler.cooldownUntil = cooldown ? Date.now() + cooldown : null;
    this.pushState();
  }

  private checkRecycler() {
    this.setPhase('checking');
    this.awaitingStatus = true;
    this.statusUnanswered = true;
    this.statusAskedAt = Date.now();
    this.ext.sendToServer(new HPacket('GetRecyclerStatus', HDirection.TOSERVER));
    this.loopTimer = setTimeout(() => {
      this.awaitingStatus = false;
      // The hotel stops answering now and then: never send blind, wait out the pause it asked for last
      const left = this.lastBatchAt + this.hotelPause + PAUSE_MARGIN - Date.now();
      log('no RecyclerStatus answer, waiting', Math.max(0, left), 'ms before the next batch');
      if (left > 0) this.wait(left, () => this.feedBatch());
      else this.feedBatch();
    }, STATUS_TIMEOUT);
  }

  private learnPause(seconds: number) {
    // Remaining seconds plus what already passed since the batch: the whole pause
    const pause = Date.now() - this.lastBatchAt + seconds * 1000;
    if (this.lastBatchAt && pause > this.hotelPause && pause < 120000) this.hotelPause = pause;
  }

  private wait(ms: number, then: () => void) {
    this.setPhase('cooldown', ms);
    this.loopTimer = setTimeout(then, ms);
  }

  private onRecyclerStatus(hMessage: HMessage) {
    // A late answer to our still unanswered request is ours too; anything else is the game's own window
    const late = this.statusUnanswered && Date.now() - this.statusAskedAt < LATE_STATUS_WINDOW;
    if (!this.awaitingStatus && !late) return;
    this.statusUnanswered = false;
    hMessage.blocked = true;

    const [status, seconds] = hMessage.getPacket().read('ii');
    log('RecyclerStatus', status, 'seconds', seconds, this.awaitingStatus ? '' : '(late)');
    if (status === RECYCLER_COOLDOWN) this.learnPause(seconds);

    if (!this.awaitingStatus) return;
    this.awaitingStatus = false;
    if (!this.recycler.running || this.recycler.phase !== 'checking') return;
    clearTimeout(this.loopTimer);
    const gap = this.lastBatchAt + MIN_BATCH_GAP - Date.now();

    if (status === RECYCLER_OPEN) {
      if (gap > 0) this.wait(gap, () => this.feedBatch());
      else this.feedBatch();
    } else if (status === RECYCLER_COOLDOWN) {
      this.wait(Math.max(seconds * 1000, gap), () => this.checkRecycler());
    } else {
      this.stop(this.notice('error', 'closed'));
    }
  }

  private feedBatch() {
    if (!this.recycler.running) return;

    const batch = this.nextBatch();
    if (batch.length < BATCH_SIZE) {
      // A refresh or a price check in progress can still complete the batch
      if (this.inventoryStatus === 'loading' || this.totals().checking > 0) {
        this.setPhase('checking');
        this.loopTimer = setTimeout(() => this.feedBatch(), 1000);
      } else {
        this.stop(this.finishedNotice());
      }
      return;
    }

    if (this.batchCost !== null && this.duckets !== null && this.duckets < this.batchCost) {
      this.stop(this.notice('error', 'duckets', { cost: this.batchCost, have: this.duckets }));
      return;
    }

    // The count has to match the ids that follow it, or the hotel gets a broken packet. Each id is the
    // inventory's own one (the first number in FurniList), exactly what the game puts in the slots;
    // the furni id, negated or not, doesn't match it for every item and the hotel refuses the batch
    const packet = new HPacket('RecycleItems', HDirection.TOSERVER);
    packet.appendInt(batch.length);
    for (const item of batch) packet.appendInt(item.itemId);
    log('RecycleItems', batch.length, 'inventory ids', batch.map((i) => i.itemId).join(','),
      '| furni ids', batch.map((i) => i.id).join(','), '| kinds', batch.map((i) => i.furniType).join(''));
    this.ext.sendToServer(packet);

    this.pendingBatch = batch;
    this.statusUnanswered = false; // a status answer that shows up now is of no use to us
    this.lastSentAt = this.ownActionAt = Date.now();
    this.setPhase('recycling');

    this.hotelTimer = setTimeout(() => {
      this.pendingBatch = undefined;
      this.stop(this.notice('error', 'noAnswer'));
      this.refreshInventory();
    }, FINISH_TIMEOUT);
  }

  private onRecyclerFinished(hMessage: HMessage) {
    const batch = this.pendingBatch;
    if (!batch) return;

    hMessage.blocked = true;
    clearTimeout(this.hotelTimer);
    this.pendingBatch = undefined;
    this.ownActionAt = Date.now();

    const [status] = hMessage.getPacket().read('i');
    const finished = hMessage.getPacket();
    log('RecyclerFinished status', status, 'second int', finished.getBytesLength() >= 14 ? finished.readInteger(10) : 'none');
    if (status !== RECYCLE_OK) {
      // After good batches a refusal is the hotel's pause still running: nothing was recycled, so the
      // same batch goes again once the pause is surely over
      if (this.recycler.running && this.runBatches > 0 && this.refusedRetries < REFUSED_RETRIES) {
        this.refusedRetries++;
        const pause = this.hotelPause + PAUSE_MARGIN;
        log('batch refused, retrying in', pause, 'ms', `(${this.refusedRetries}/${REFUSED_RETRIES})`);
        this.lastBatchAt = Date.now();
        this.wait(pause, () => this.checkRecycler());
        return;
      }
      this.stop(this.notice('error', 'refused'));
      return;
    }

    this.refusedRetries = 0;
    this.removeFromInventory(batch);
    this.recycler.batchesSent++;
    this.runBatches++;
    this.lastBatchAt = Date.now();
    this.expectPrizeBox();

    if (!this.recycler.running) {
      this.setPhase('idle');
    } else if (this.runOnce) {
      this.stop(this.notice('done', 'done', { recycled: BATCH_SIZE }));
    } else if (this.nextBatch().length < BATCH_SIZE && this.totals().checking === 0) {
      this.stop(this.finishedNotice());
    } else {
      this.checkRecycler();
    }
  }

  private finishedNotice(): Notice {
    const { leftover, heldBack } = this.totals();
    const recycled = this.runBatches * BATCH_SIZE;

    if (heldBack > 0) return this.notice('info', 'heldBack', { recycled, heldBack });
    if (leftover > 0) return this.notice('info', 'leftover', { recycled, leftover, missing: BATCH_SIZE - leftover });
    if (recycled > 0) return this.notice('done', 'done', { recycled });
    return this.notice('info', 'needBatch', { size: BATCH_SIZE });
  }

  private cycleMs() {
    return this.runBatches > 0 ? (this.lastBatchAt - this.runStartedAt) / this.runBatches : null;
  }

  // ---- Prize boxes ----

  private newLoot(): LootEntry {
    const entry: LootEntry = {
      key: ++this.lootKey,
      at: Date.now(),
      status: 'boxed',
      name: null,
      imgUrl: null,
      level: null,
      odds: null,
      tier: null,
    };
    this.loot = [entry, ...this.loot].slice(0, LOOT_LIMIT);
    this.saveLoot();
    return entry;
  }

  // Every finished batch owes a box. It normally arrives with its real ids in FurniListAddOrUpdate;
  // if it doesn't, the inventory is read again instead of guessing the box from the prize id
  private expectPrizeBox() {
    this.boxesOwed++;
    clearTimeout(this.boxCheckTimer);
    this.boxCheckTimer = setTimeout(() => {
      if (this.boxesOwed <= 0) return;
      this.boxesOwed = 0;
      this.openBoxesAfterRefresh = this.settings.autoOpen;
      this.refreshInventory();
    }, PRIZE_BOX_WAIT);
  }

  private autoOpen(ids: number[]) {
    if (this.settings.autoOpen && this.canOpenBoxes()) setTimeout(() => this.openBoxes(ids), BOX_OPEN_DELAY);
  }

  // A list of furni (count first); a single furni as a fallback in case a hotel sends it bare
  private readAddedItems(hMessage: HMessage) {
    const packet = hMessage.getPacket();
    try {
      const count = packet.readInteger();
      if (count < 0 || count > 500) throw new Error(`unlikely count ${count}`);
      return Array.from({ length: count }, () => new HInventoryItem(packet));
    } catch {
      packet.resetReadIndex();
      return [new HInventoryItem(packet)];
    }
  }

  private onFurniListAddOrUpdate(hMessage: HMessage) {
    const furniData = this.furniData;
    if (!furniData) return;

    for (const item of this.readAddedItems(hMessage)) {
      const data =
        item.furniType === HProductType.WallItem
          ? furniData.getWallItemByTypeId(item.typeId)
          : furniData.getFloorItemByTypeId(item.typeId);
      if (!isPrizeBox(data) || this.boxes.has(item.id)) continue;

      this.boxes.set(item.id, { placeId: item.itemId });
      log('new prize box', item.id, 'inventory id', item.itemId);
      // Ours when a batch is in flight or owes its box; one from somewhere else just waits in the list
      if (this.pendingBatch || this.boxesOwed > 0) {
        this.boxesOwed--;
        this.autoOpen([item.id]);
      }
    }
    this.pushState();
  }

  // Furni that leave the inventory (placed, traded, sold) shouldn't end up in a batch
  private onFurniListRemove(hMessage: HMessage) {
    const removed = hMessage.getPacket().readInteger();
    const matches = (itemId: number, id: number) => itemId === removed || id === Math.abs(removed);
    let changed = false;

    for (const [id, box] of this.boxes) {
      if (id !== this.boxJob?.id && matches(box.placeId, id)) this.boxes.delete(id);
    }

    for (const [typeId, furni] of this.furniture) {
      const left = furni.items.filter((item) => !matches(item.itemId, item.id));
      if (left.length === furni.items.length) continue;

      changed = true;
      furni.items = left;
      if (left.length === 0) this.furniture.delete(typeId);
      if (this.recyclableCount(typeId) === 0) this.queue.delete(typeId);
    }

    if (changed) this.inventoryVersion++;
    this.pushState();
  }

  // ---- Rooms ----

  private onRoomEntryInfo(hMessage: HMessage) {
    const [id, owner] = hMessage.getPacket().read('iB');
    log('RoomEntryInfo room', id, owner ? '(yours)' : '(not yours)');
    this.room = { id, owner };
    this.roomUnknown = false;
    this.boxFailed = null;
    if (!owner) this.stopBoxes();
    this.pushState();
  }

  private leaveRoom() {
    this.roomUnknown = false;
    if (!this.room) {
      this.pushState();
      return;
    }
    this.room = null;
    this.pickingSpot = false;
    this.stopBoxes();
    this.pushState();
  }

  private spot() {
    const tile = this.room ? this.settings.spots[this.room.id] : undefined;
    return tile ? { x: tile[0], y: tile[1] } : null;
  }

  // Boxes only open placed in a room you own, so they need a free tile there
  private canOpenBoxes() {
    return !!this.room?.owner && !!this.spot();
  }

  private setPickingSpot(picking: boolean) {
    this.pickingSpot = picking && !!this.room?.owner;
    this.pushState();
  }

  // While choosing the tile, the click on the floor marks it instead of walking the avatar onto it
  private onMoveAvatar(hMessage: HMessage) {
    // Walking means being in a room: if its entry was missed, say so instead of staying quiet
    if (!this.room && !this.roomUnknown) {
      this.roomUnknown = true;
      this.pushState();
    }
    if (!this.pickingSpot || !this.room) return;

    hMessage.blocked = true;
    const [x, y] = hMessage.getPacket().read('ii');
    this.pickingSpot = false;
    this.boxFailed = null;
    this.updateSettings({ spots: { ...this.settings.spots, [this.room.id]: [x, y] } });
  }

  // ---- Prize boxes ----

  private openBoxes(ids: number[]) {
    if (!this.canOpenBoxes()) return;

    const queued = new Set([...this.boxQueue, this.boxJob?.id]);
    const fresh = ids.filter((id) => this.boxes.has(id) && !queued.has(id));
    if (fresh.length === 0) return;

    this.boxQueue.push(...fresh);
    this.boxRun = {
      done: this.boxRun?.done ?? 0,
      total: (this.boxRun?.total ?? 0) + fresh.length,
    };
    this.boxFailed = null;
    this.openNextBox();
  }

  // One box at a time, so every room and present answer belongs to the box being handled
  private openNextBox() {
    if (this.boxJob) return;

    const id = this.boxQueue.shift();
    const spot = this.spot();
    const box = id === undefined ? undefined : this.boxes.get(id);
    if (id === undefined || !box || !spot || !this.room?.owner) {
      this.boxQueue = [];
      this.boxRun = null;
      this.pushState();
      return;
    }

    const entry = this.newLoot();
    entry.status = 'opening';

    this.ext.sendToServer(
      new HPacket('PlaceObject', HDirection.TOSERVER).appendString(`${box.placeId} ${spot.x} ${spot.y} 0`)
    );
    log('PlaceObject box', id, `"${box.placeId} ${spot.x} ${spot.y} 0"`);
    this.ownActionAt = Date.now();
    this.boxJob = { id, entry, step: 'placing', timer: setTimeout(() => this.failBox('place'), BOX_STEP_TIMEOUT) };
    this.pushState();
  }

  private onObjectAdd(hMessage: HMessage) {
    const job = this.boxJob;
    if (job?.step !== 'placing' || hMessage.getPacket().readInteger() !== job.id) return;

    clearTimeout(job.timer);
    log('ObjectAdd box', job.id, 'placed, opening it');
    job.step = 'opening';
    job.timer = setTimeout(() => this.failBox('open'), BOX_STEP_TIMEOUT + BOX_STEP_GAP);
    setTimeout(() => {
      this.ext.sendToServer(new HPacket('PresentOpen', HDirection.TOSERVER).appendInt(job.id));
      this.ownActionAt = Date.now();
    }, BOX_STEP_GAP);
  }

  private onPresentOpened(hMessage: HMessage) {
    const job = this.boxJob;
    if (job?.step !== 'opening') return; // a gift the person opened in the game themselves

    // Otherwise the game pops up its "you got..." window with its sound
    hMessage.blocked = true;
    clearTimeout(job.timer);
    this.ownActionAt = Date.now();

    const [itemType, classId, , placedId, placedType, placedInRoom] = hMessage.getPacket().read('SiSiSB');
    log('PresentOpened', itemType, classId, 'placed', placedInRoom ? `in room as ${placedType} ${placedId}` : 'in inventory');
    const data =
      String(itemType).toLowerCase() === 'i'
        ? this.furniData?.getWallItemByTypeId(classId)
        : this.furniData?.getFloorItemByTypeId(classId);

    Object.assign(job.entry, {
      status: 'opened',
      at: Date.now(),
      name: data?.name || '',
      imgUrl: iconUrl(data),
      ...this.prizeInfo(String(itemType), classId),
    });
    this.saveLoot();
    this.boxes.delete(job.id);
    if (this.boxRun) this.boxRun.done++;
    this.pushState();

    if (!placedInRoom || placedId <= 0) {
      this.nextBox();
      return;
    }

    // The prize lands on the box's tile: back to the inventory, so the tile is free for the next box
    job.step = 'pickingUp';
    job.prizeId = placedId;
    job.timer = setTimeout(() => this.nextBox(), BOX_STEP_TIMEOUT + BOX_STEP_GAP);
    setTimeout(() => {
      const category = String(placedType).toLowerCase() === 'i' ? 1 : 2;
      this.ext.sendToServer(new HPacket('PickupObject', HDirection.TOSERVER).appendInt(category).appendInt(placedId));
      this.ownActionAt = Date.now();
    }, BOX_STEP_GAP);
  }

  private onObjectRemove(hMessage: HMessage) {
    const job = this.boxJob;
    if (job?.step !== 'pickingUp' || Number(hMessage.getPacket().readString()) !== job.prizeId) return;
    this.nextBox();
  }

  private nextBox() {
    if (this.boxJob) clearTimeout(this.boxJob.timer);
    this.boxJob = undefined;
    this.boxTimer = setTimeout(() => this.openNextBox(), BOX_GAP);
    this.pushState();
  }

  // If one box gets stuck the rest would too: stop instead of waiting on each of them
  private failBox(step: 'place' | 'open') {
    const job = this.boxJob;
    if (!job) return;
    log('box', job.id, step === 'place' ? 'was not placed (no ObjectAdd)' : 'did not open (no PresentOpened)', 'in time');

    // The box stays in the list of closed ones; it only gets a log line once it opens
    this.loot = this.loot.filter((entry) => entry !== job.entry);
    this.saveLoot();
    this.boxJob = undefined;
    this.boxFailed = step;
    this.boxQueue = [];
    this.boxRun = null;
    this.pushState();
  }

  private stopBoxes() {
    clearTimeout(this.boxTimer);
    this.boxQueue = [];
    this.boxRun = null;
    this.pushState();
  }

  // ---- Duckets ----

  private onActivityPoints(hMessage: HMessage) {
    const packet = hMessage.getPacket();
    const count = packet.readInteger();

    for (let i = 0; i < count; i++) {
      const [type, amount] = packet.read('ii');
      if (type === DUCKETS) this.duckets = amount;
    }
    this.pushState();
  }

  private onActivityPointNotification(hMessage: HMessage) {
    const [amount, change, type] = hMessage.getPacket().read('iii');
    if (type !== DUCKETS) return;

    this.duckets = amount;
    // Learn what a batch costs from the change that follows it, instead of assuming a price.
    // The game doesn't get that change: it would play the ducket sound for every batch
    if (change < 0 && Date.now() - this.lastSentAt < COST_WINDOW) {
      this.batchCost = -change;
      hMessage.blocked = true;
    }
    this.pushState();
  }

  // ---- Settings ----

  private loadSettings(): Settings {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(this.settingsFile, 'utf8')) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private updateSettings(patch: Partial<Settings>) {
    const next = { ...this.settings };
    if (Number.isFinite(patch.priceCap)) next.priceCap = Math.max(0, Math.floor(patch.priceCap!));
    if (Number.isFinite(patch.defaultKeep)) next.defaultKeep = Math.max(0, Math.floor(patch.defaultKeep!));
    if (typeof patch.autoOpen === 'boolean') next.autoOpen = patch.autoOpen;
    if (typeof patch.hideExpensive === 'boolean') next.hideExpensive = patch.hideExpensive;
    if (typeof patch.alwaysOnTop === 'boolean') next.alwaysOnTop = patch.alwaysOnTop;
    if (Array.isArray(patch.locked)) next.locked = patch.locked.filter((c) => typeof c === 'string');
    if (patch.language && LANGUAGES.includes(patch.language)) next.language = patch.language;
    if (patch.spots && typeof patch.spots === 'object') next.spots = patch.spots;

    this.settings = next;
    this.ui.setAlwaysOnTop(next.alwaysOnTop);

    try {
      mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      writeFileSync(this.settingsFile, JSON.stringify(next, null, 2));
    } catch (err) {
      console.error('Could not save settings:', err);
    }
    this.pushState();
  }

  // ---- State for the window ----

  // Many changes can land in one tick (a whole inventory fragment): send one snapshot for all of them
  private pushState() {
    if (this.statePending) return;
    this.statePending = true;
    setImmediate(() => {
      this.statePending = false;
      this.ui.sendState(this.snapshot());
    });
  }

  // Names stay empty when furnidata doesn't know the furni: the window words that in its language
  private snapshot(): AppState {
    const cards: FurniCard[] = Array.from(this.furniture.entries())
      .map(([typeId, furni]) => ({
        typeId,
        name: furni.data?.name || '',
        imgUrl: iconUrl(furni.data),
        quantity: furni.items.length,
        locked: this.isLocked(furni),
        price: this.prices.get(typeId) ?? null,
      }))
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));

    const queue: QueueEntry[] = Array.from(this.queue.entries()).map(([typeId, keep]) => {
      const furni = this.furniture.get(typeId);
      return {
        typeId,
        name: furni?.data?.name || '',
        imgUrl: iconUrl(furni?.data),
        available: furni?.items.length ?? 0,
        keep,
        price: this.prices.get(typeId) ?? { status: 'loading' },
        heldBack: this.isHeldBack(typeId),
        allowed: this.allowed.has(typeId),
      };
    });

    return {
      hotel: this.hotel,
      room: this.room ? (this.room.owner ? 'owner' : 'guest') : this.roomUnknown ? 'unknown' : 'none',
      boxes: {
        waiting: this.boxes.size,
        running: !!this.boxRun,
        done: this.boxRun?.done ?? 0,
        total: this.boxRun?.total ?? 0,
        failed: this.boxFailed,
        spot: this.spot(),
        picking: this.pickingSpot,
      },
      furniData: this.furniDataStatus,
      inventory: {
        status: this.inventoryStatus,
        progress: this.inventoryProgress,
        version: this.inventoryVersion,
        cards,
      },
      queue,
      recycler: {
        ...this.recycler,
        ...this.totals(),
        cycleMs: this.cycleMs(),
        nextBatch: this.nextBatch().map((item) => iconUrl(this.furniture.get(item.typeId)?.data)),
      },
      duckets: this.duckets,
      batchCost: this.batchCost,
      loot: this.loot,
      prizeLevels: this.prizeLevels,
      settings: this.settings,
    };
  }
}

new GFurniMatic();
