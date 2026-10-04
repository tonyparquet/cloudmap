import type { RawSnapshot } from '@carto/core';
import { SCANNER_VERSION } from '../../context.ts';
import type { TokenScanner } from '../types.ts';
import { azureSubscription, type AzureToken } from './auth.ts';

export * from './auth.ts';

/** Services Azure proposés dans l'interface de scan. */
export const AZURE_SERVICES: { key: string; label: string }[] = [];

/** Scan Azure en lecture seule (Resource Graph + ARM). */
export const scanAzure: TokenScanner<AzureToken> = async (opts): Promise<RawSnapshot> => {
  const startedAt = new Date().toISOString();
  const sub = await azureSubscription(opts.credentials, opts.accountId, opts.fetchImpl);
  return {
    schemaVersion: 1,
    meta: {
      profileId: opts.profileId,
      provider: 'azure',
      accountId: sub.subscriptionId,
      regions: opts.regions,
      startedAt,
      finishedAt: new Date().toISOString(),
      scannerVersion: SCANNER_VERSION,
    },
    resources: [],
    errors: [],
  };
};
