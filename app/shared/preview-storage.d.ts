
export type StorageIdentity={environment:string;ref:string;userId:string;projectId:string};
export function appStorageKey(identity:StorageIdentity):string;
export function attachPreviewStorage(options:{frame:HTMLIFrameElement;origin:string;identity:StorageIdentity;storage?:Storage;host?:Window;locks?:LockManager;onStatus?:(status:string)=>void}):()=>void;
export function previewBootstrap(options:{hostOrigin:string;projectId:string;allowLocalValidation?:boolean},modules:{src?:string;code?:string}[]):Promise<void>;
export const STORAGE_PROTOCOL:string;

export function resetPreviewStorage(identity:StorageIdentity,options?:{storage?:Storage;locks?:LockManager}):Promise<void>;
