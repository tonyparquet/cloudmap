import type { RawSnapshot } from '@cloudmap/core';
import type { ScanEvent } from '../scan.ts';
import type { AzureToken } from './azure/auth.ts';
import type { GcpToken } from './gcp/auth.ts';

/** Options d'un scan Azure ou Google Cloud (mêmes événements de progression que le scan AWS). */
export interface TokenScanOptions<T extends AzureToken | GcpToken> {
  profileId: string;
  /** Abonnement Azure ou projet Google Cloud : le scan est refusé si le jeton n'y a pas accès. */
  accountId: string;
  regions: string[];
  services?: string[];
  credentials: T;
  concurrency?: number;
  onProgress?: (event: ScanEvent) => void;
  /** Tests : HTTP simulé (aucun appel réel). */
  fetchImpl?: typeof fetch;
}

export type TokenScanner<T extends AzureToken | GcpToken> = (
  opts: TokenScanOptions<T>,
) => Promise<RawSnapshot>;
