import type { RawSnapshot } from '@carto/core';
import { SCANNER_VERSION } from '../../context.ts';
import type { TokenScanner } from '../types.ts';
import { gcpProject, type GcpToken } from './auth.ts';

export * from './auth.ts';

/** Services Google Cloud proposés dans l'interface de scan. */
export const GCP_SERVICES: { key: string; label: string }[] = [];

/** Scan Google Cloud en lecture seule (Cloud Asset Inventory + API de chaque service). */
export const scanGcp: TokenScanner<GcpToken> = async (opts): Promise<RawSnapshot> => {
  const startedAt = new Date().toISOString();
  const project = await gcpProject(opts.credentials, opts.accountId, opts.fetchImpl);
  return {
    schemaVersion: 1,
    meta: {
      profileId: opts.profileId,
      provider: 'gcp',
      accountId: project.projectId,
      regions: opts.regions,
      startedAt,
      finishedAt: new Date().toISOString(),
      scannerVersion: SCANNER_VERSION,
    },
    resources: [],
    errors: [],
  };
};
