import { FloorItemData, HInventoryItem, WallItemData } from "gnode-api";

export interface RecycleFurni {
    items: HInventoryItem[];
    data: WallItemData | FloorItemData | undefined;
}

export interface FurniCard {
    imgUrl: string;
    quantity: number;
    name: string;
    typeId: number;
    selectedQuantity?: number;
}