import { BrowserWindow, ipcMain } from 'electron';
import { readFileSync } from 'fs';
import {
  Extension,
  FurniData,
  FurniDataUtils,
  HDirection,
  HInventoryItem,
  HMessage,
  HPacket,
  Hotel
} from 'gnode-api';
import path from 'path';
import { fileURLToPath } from 'url';
import { FurniCard, RecycleFurni } from './recycle-furni';

class Ui {
  private readonly extension: Extension;
  public win?: BrowserWindow;

  constructor(extension: Extension) {
    this.extension = extension;

    ipcMain.on('minimize', () => this.win?.minimize());
    ipcMain.on('maximize', () =>
      this.win?.isMaximized() ? this.win.unmaximize() : this.win?.maximize()
    );
    ipcMain.on('close', () => this.win?.close());
    ipcMain.on('alwaysOnTop', (_event, state: boolean) => {
      this.win?.setAlwaysOnTop(state);
    });
  }

  public startUi() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    this.win = new BrowserWindow({
      width: 900,
      height: 600,
      frame: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, '../renderer/preload.js'),
      },
    });

    this.win.loadFile(path.join(__dirname, '../renderer/index.html'));
    this.win.once('ready-to-show', () => this.win?.show());
    this.win.setAlwaysOnTop(false);

    this.win.on('closed', () => {
      this.win = undefined;
    });
  }

  public sendCards(cards: FurniCard[]) {
    if (!this.win || this.win.isDestroyed()) return;

    const sorted = cards.sort((a, b) =>
      b.quantity - a.quantity || a.name.localeCompare(b.name)
    );

    this.win.webContents.send('load-cards', sorted);
  }

  public notifyFurniDataLoaded(loaded: boolean) {
    this.win?.webContents.send('furni-data-loaded', loaded);
  }

  public sendRecycleList(queue: FurniCard[]) {
    this.win?.webContents.send('recycle-list:update', queue);
  }
}

class GFurniMatic {
  private readonly ui: Ui;
  private readonly ext: Extension;
  private furniture: Map<number, RecycleFurni> = new Map();
  private furniData?: FurniData;
  private furniDataReady!: Promise<void>;
  private resolveFurniDataReady!: () => void;
  private recycleQueue: FurniCard[] = [];

  constructor() {
    const extensionInfo = JSON.parse(
      readFileSync(new URL('./extension.json', import.meta.url)).toString()
    );

    this.furniDataReady = new Promise((resolve) => {
      this.resolveFurniDataReady = resolve;
    });

    this.ext = new Extension(extensionInfo);
    this.ui = new Ui(this.ext);

    this.ext.on('click', () => this.initExtension());
    this.ext.on('connect', (host: string) => this.loadFurniData(host));
    this.ext.run();

    this.registerInterceptors();
    this.setupRecycleQueueHandlers();

    ipcMain.on('refresh', () => this.refreshInventory());
  }

  private async loadFurniData(host: string) {
    const hostToHotel: Record<string, Hotel> = {
      'game-nl.habbo.com': Hotel.NL,
      'game-br.habbo.com': Hotel.COMBR,
      'game-tr.habbo.com': Hotel.COMTR,
      'game-de.habbo.com': Hotel.DE,
      'game-fr.habbo.com': Hotel.FR,
      'game-fi.habbo.com': Hotel.FI,
      'game-es.habbo.com': Hotel.ES,
      'game-it.habbo.com': Hotel.IT,
      'game-us.habbo.com': Hotel.COM,
      'game-s2.habbo.com': Hotel.SANDBOX,
    };

    const hotel = hostToHotel[host];
    if (!hotel) {
      console.warn(`Unknown hotel host: ${host}`);
      this.ui.notifyFurniDataLoaded(false);
      return;
    }

    if (this.furniData) {
      this.ui.notifyFurniDataLoaded(true);
      return;
    }

    try {
      this.furniData = await FurniDataUtils.fetch(hotel);
      this.resolveFurniDataReady();
      this.ui.notifyFurniDataLoaded(true);
    } catch (err) {
      console.error('Failed to load furnidata:', err);
      this.ui.notifyFurniDataLoaded(false);
    }
  }

  private registerInterceptors() {
    this.ext.interceptByNameOrHash(
      HDirection.TOCLIENT,
      'FurniList',
      this.addFurnitureToInventory.bind(this)
    );
  }

  private async addFurnitureToInventory(hMessage: HMessage) {
    await this.furniDataReady;
    if (!this.furniData) return;

    const items = HInventoryItem.parse(hMessage.getPacket()).filter(
      (item) => item.isRecyclable
    );

    for (const item of items) {
      const existing = this.furniture.get(item.typeId);

      if (existing) {
        existing.items.push(item);
      } else {
        const furniData =
          this.furniData.getFloorItemByTypeId(item.typeId) ||
          this.furniData.getWallItemByTypeId(item.typeId);

        this.furniture.set(item.typeId, {
          items: [item],
          data: furniData,
        });
      }
    }

    const cards: FurniCard[] = Array.from(this.furniture.entries()).map(
      ([typeId, furni]) => ({
        imgUrl: `https://images.habbo.com/dcr/hof_furni/${furni.data?.revision}/${furni.data?.classname}_icon.png`,
        quantity: furni.items.length,
        name: furni.data?.name || `Unknown (${typeId})`,
        typeId,
      })
    );

    this.ui.sendCards(cards);
  }

  private initExtension() {
    this.refreshInventory();
    this.ui.startUi();
  }

  private refreshInventory() {
    this.furniture.clear();
    this.ext.sendToServer(
      new HPacket('RequestFurniInventory', HDirection.TOSERVER)
    );
  }

  private setupRecycleQueueHandlers() {
    ipcMain.handle('recycle:add', (_event, card: FurniCard) => {
      if (this.recycleQueue.find((q) => q.name === card.name)) return;
      this.recycleQueue.push(card);
      this.ui.sendRecycleList(this.recycleQueue);
    });

    ipcMain.handle('recycle:remove', (_event, cardName: string) => {
      this.recycleQueue = this.recycleQueue.filter((c) => c.name !== cardName);
      this.ui.sendRecycleList(this.recycleQueue);
    });

    ipcMain.handle('recycle:clear', () => {
      this.recycleQueue = [];
      this.ui.sendRecycleList(this.recycleQueue);
    });
  }
}

new GFurniMatic();
