import { randomUUID } from 'node:crypto';
import type { Profile } from '@carto/core';
import { scanAccount, scanAzure, scanGcp, type ScanEvent } from '@carto/scanner';
import { redactString } from '@carto/security';
import type { Audit } from './audit.ts';
import type { AppSettings } from './config.ts';
import type { Storage } from './storage.ts';
import { isTokenCredentials, type CloudCredentials } from './vault.ts';

export type ServerScanEvent =
  | ScanEvent
  | { type: 'snapshot'; snapshotId: string }
  | { type: 'failed'; message: string }
  | { type: 'end' };

export interface ScanState {
  id: string;
  profileId: string;
  startedAt: string;
  events: ServerScanEvent[];
  listeners: Set<(e: ServerScanEvent) => void>;
  finished: boolean;
}

/** Scans exécutés côté serveur uniquement ; un seul scan simultané par profil ; progression diffusée en SSE. */
export class ScanManager {
  private readonly scans = new Map<string, ScanState>();
  private readonly running = new Map<string, string>();

  constructor(
    private readonly storage: Storage,
    private readonly audit: Audit,
    private readonly settings: AppSettings,
  ) {}

  isRunning(profileId: string): boolean {
    return this.running.has(profileId);
  }

  get(id: string): ScanState | undefined {
    return this.scans.get(id);
  }

  subscribe(id: string, fn: (e: ServerScanEvent) => void): () => void {
    const state = this.scans.get(id);
    state?.listeners.add(fn);
    return () => state?.listeners.delete(fn);
  }

  start(
    profile: Profile,
    credentials: CloudCredentials,
    opts: { regions: string[]; services?: string[] | undefined },
    who: { user: string; ip: string },
  ): string {
    const id = randomUUID();
    const state: ScanState = {
      id,
      profileId: profile.id,
      startedAt: new Date().toISOString(),
      events: [],
      listeners: new Set(),
      finished: false,
    };
    const push = (e: ServerScanEvent) => {
      if (state.events.length < 5000) state.events.push(e);
      for (const l of state.listeners) l(e);
    };
    this.scans.set(id, state);
    this.running.set(profile.id, id);
    this.audit.log({
      ...who,
      action: 'scan.lance',
      profileId: profile.id,
      result: 'succes',
      details: { scanId: id, regions: opts.regions },
    });

    // Azure / Google Cloud : scan par jeton (services du fournisseur, tous par défaut) ; AWS : SDK.
    const common = {
      profileId: profile.id,
      accountId: profile.accountId,
      regions: opts.regions,
      concurrency: this.settings.scanner.concurrency,
      onProgress: push,
    };
    const run = !isTokenCredentials(credentials)
      ? scanAccount({
          ...common,
          services: opts.services ?? this.settings.scanner.defaultServices,
          credentials,
          probes: profile.probes,
          flowLogs: profile.flowLogs,
          probeTimeoutMs: this.settings.scanner.probeTimeoutMs,
        })
      : credentials.provider === 'azure'
        ? scanAzure({ ...common, ...(opts.services ? { services: opts.services } : {}), credentials })
        : scanGcp({ ...common, ...(opts.services ? { services: opts.services } : {}), credentials });
    run
      .then((snapshot) => {
        const row = this.storage.saveSnapshot(profile.id, snapshot, 'scan');
        push({ type: 'snapshot', snapshotId: row.id });
        this.audit.log({
          ...who,
          action: 'scan.termine',
          profileId: profile.id,
          result: 'succes',
          details: { scanId: id, ressources: row.resource_count, erreurs: row.error_count },
        });
      })
      .catch((err: unknown) => {
        const message = redactString((err as Error)?.message ?? 'Erreur inconnue').slice(0, 300);
        push({ type: 'failed', message });
        this.audit.log({
          ...who,
          action: 'scan.termine',
          profileId: profile.id,
          result: 'echec',
          details: { scanId: id, message },
        });
      })
      .finally(() => {
        state.finished = true;
        this.running.delete(profile.id);
        push({ type: 'end' });
        state.listeners.clear();
        setTimeout(() => this.scans.delete(id), 3_600_000).unref();
      });
    return id;
  }
}
