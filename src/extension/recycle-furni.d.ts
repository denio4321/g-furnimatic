import { FloorItemData, HInventoryItem, WallItemData } from "gnode-api";

export interface RecycleFurni {
    items: HInventoryItem[];
    data: WallItemData | FloorItemData | undefined;
}

export interface FurniCard {
    typeId: number;
    name: string;
    imgUrl: string;
    quantity: number;
    locked: boolean;
    price: PriceInfo | null;    // null until the Marketplace has been asked
}

export type PriceInfo =
    | { status: 'loading' }
    | { status: 'known'; average: number }
    | { status: 'none' }        // sellable, but nobody has sold one lately
    | { status: 'unsellable' }  // can't go on the Marketplace at all
    | { status: 'failed' };

export interface QueueEntry {
    typeId: number;
    name: string;
    imgUrl: string;
    available: number;
    keep: number;
    price: PriceInfo;
    heldBack: boolean;          // over the price limit (or unchecked) and not allowed by the user
    allowed: boolean;
}

export type RecyclerPhase = 'idle' | 'checking' | 'recycling' | 'cooldown';

// The window turns these into text in the person's language
export type NoticeCode =
    | 'closed'
    | 'duckets'
    | 'noAnswer'
    | 'refused'
    | 'heldBack'
    | 'leftover'
    | 'done'
    | 'needBatch';

export interface Notice {
    tone: 'info' | 'done' | 'error';
    code: NoticeCode;
    values: Record<string, number>;
}

export interface RecyclerState {
    running: boolean;
    phase: RecyclerPhase;
    cooldownUntil: number | null;
    cooldownTotal: number | null;
    nextBatch: string[];
    batchesLeft: number;
    leftover: number;
    heldBack: number;
    checking: number;           // queued furni waiting for their price check
    batchesSent: number;
    cycleMs: number | null;     // average time per batch in this run, for the time left
    notice: Notice | null;
}

export interface LootEntry {
    key: number;
    at: number;                 // when the box was opened (or came out of a batch)
    status: 'opening' | 'opened' | 'boxed';
    name: string | null;
    imgUrl: string | null;
    level: number | null;       // Furni-Matic prize level, from its prize table
    odds: number | null;        // 1 in this many
    tier: number | null;        // 0 common ... 4 rarest, for the colour
}

export interface PrizeLevel {
    level: number;
    odds: number;
    tier: number;
}

export interface Settings {
    priceCap: number;           // credits, 0 turns the limit off
    defaultKeep: number;
    hideExpensive: boolean;     // keep furni over the safe price out of the inventory list
    autoOpen: boolean;
    alwaysOnTop: boolean;
    language: 'auto' | 'en' | 'es' | 'pt';  // auto follows the hotel
    locked: string[];           // classnames, so they survive across hotels and sessions
    spots: Record<string, [number, number]>; // room id -> tile for opening boxes
}

export interface BoxState {
    waiting: number;            // Furni-Matic prize boxes in the inventory, still closed
    running: boolean;
    done: number;
    total: number;
    failed: 'place' | 'open' | null;  // the step a box got stuck on, so the rest weren't tried
    spot: { x: number; y: number } | null;  // the tile in this room where boxes get placed
    picking: boolean;           // waiting for the person to click that tile
}

export interface AppState {
    hotel: string | null;
    room: 'none' | 'unknown' | 'guest' | 'owner';  // unknown: in a room entered before the extension started
    boxes: BoxState;
    furniData: 'waiting' | 'loading' | 'ready' | 'failed';
    inventory: {
        status: 'idle' | 'loading' | 'ready' | 'failed';
        progress: [number, number] | null;
        version: number;
        cards: FurniCard[];
    };
    queue: QueueEntry[];
    recycler: RecyclerState;
    duckets: number | null;
    batchCost: number | null;
    loot: LootEntry[];
    prizeLevels: PrizeLevel[];
    settings: Settings;
}
