import initial from './001_initial.ts';
import dossiers from './002_dossiers.ts';

/** Migrations versionnées, appliquées dans l'ordre et une seule fois. Ne jamais modifier une migration publiée. */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: 'initial', sql: initial },
  { version: 2, name: 'dossiers', sql: dossiers },
];
