export type AppAvailabilityStatus =
  | 'unknown'
  | 'availableRU'
  | 'deletedInRUAvailableUS'
  | 'deletedGlobally';

export type AccountOwnershipStatus = 'unknown' | 'owned' | 'notOwned' | 'error';

export type CuratedListSource = 'top25' | 'popular' | 'custom';

export interface CuratedAppEntry {
  id: string;
  name: string;
  iosVersionMap: Record<number, string>;
  purchaseKind?: string;
  purchaseDate?: string;
}

export interface CachedAppMetadata {
  appID: string;
  status: AppAvailabilityStatus;
  iconURL?: string;
  bundleID?: string;
  artistName?: string;
  storeVersion?: string;
  priceFormatted?: string;
  minOSVersion?: string;
  fileSizeBytes?: number;
  updatedAt: number;
}

export interface ITunesSearchItem {
  trackId: number;
  trackName: string;
  bundleId: string;
  artistName: string;
  version: string;
  formattedPrice?: string;
  price?: number;
  artworkUrl100?: string;
  artworkUrl512?: string;
  minimumOsVersion?: string;
  fileSizeBytes?: string;
  primaryGenreName?: string;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
  averageUserRating?: number;
}

export interface AppVersionEntry {
  externalVersionID: string;
  bundleVersion?: string;
  sizeBytes?: number;
  createdAt?: string;
  source?: 'apple' | 'public' | 'ios-map';
}

export interface AnisetteServer {
  name: string;
  address: string;
  kind?: number;
}

export interface AnisetteTestResult {
  ok: boolean;
  serverName?: string;
  serverAddress?: string;
  latencyMs?: number;
  machineIdPreview?: string;
  error?: string;
}

export interface BridgeStatusResponse {
  configured: boolean;
  source: 'env' | 'none';
  host?: string;
  envError?: string;
}

export interface BridgeTestResult {
  ok: boolean;
  engine?: string;
  latencyMs?: number;
  secretProtected?: boolean;
  error?: string;
}

export type SessionPersistMode = '24h' | 'keep' | 'memory';

export interface AppleSessionSummary {
  email: string;
  accountName: string;
  dsid: string;
  pod: string;
  storeFront: string;
  expiresAt: number;
  persistMode: SessionPersistMode;
}

export interface AuthLoginResponse {
  status: 'authenticated' | 'requires2fa' | 'error';
  token?: string;
  session?: AppleSessionSummary;
  anisetteUsed?: {
    serverName: string;
    latencyMs: number;
  };
  message?: string;
}

export interface GeneratedSessionResponse {
  ok: boolean;
  sessionString?: string;
  expiresAt?: number;
  pinProtected?: boolean;
  error?: string;
}

export interface DownloadDescriptorResult {
  appID: string;
  appName: string;
  bundleID: string;
  version: string;
  externalVersionID: string;
  availableVersionIDs: string[];
  directCdnUrl: string;
  manifestToken: string;
  manifestPath: string;
  md5?: string;
  fileSizeBytes?: number;
  iconURL?: string;
  minOSVersion?: string;
  sinfCount: number;
  metadataPlistXml: string;
  endpointUsed: string;
  isDeletedDirect: boolean;
}

export interface InspectAppResponse {
  appID: string;
  availability: AppAvailabilityStatus;
  storeItem?: ITunesSearchItem;
  versions: AppVersionEntry[];
  descriptor?: DownloadDescriptorResult;
  ownership: 'owned' | 'notOwned' | 'unauthenticated';
  licenseRequired?: boolean;
  sessionExpired?: boolean;
  warning?: string;
}

export interface SavedIpaRecord {
  id: string;
  appID: string;
  appName: string;
  bundleID: string;
  version: string;
  externalVersionID: string;
  directCdnUrl: string;
  manifestPath: string;
  iconURL?: string;
  minOSVersion?: string;
  fileSizeBytes?: number;
  md5?: string;
  sinfCount: number;
  metadataPlistXml?: string;
  isDeletedDirect: boolean;
  createdAt: number;
}

export interface CountryStorefront {
  code: string;
  label: string;
  storeFrontId: string;
}

export const COUNTRY_STOREFRONTS: CountryStorefront[] = [
  { code: 'ru', label: 'Россия (RU)', storeFrontId: '143469-16,32' },
  { code: 'us', label: 'США (US)', storeFrontId: '143441-1,32' },
  { code: 'kz', label: 'Казахстан (KZ)', storeFrontId: '143517-16,32' },
  { code: 'tr', label: 'Турция (TR)', storeFrontId: '143480-1,32' },
  { code: 'gb', label: 'Великобритания (GB)', storeFrontId: '143444-1,32' },
  { code: 'de', label: 'Германия (DE)', storeFrontId: '143443-1,32' },
  { code: 'jp', label: 'Япония (JP)', storeFrontId: '143462-1,32' },
];
