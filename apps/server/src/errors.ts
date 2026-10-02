import type { z } from 'zod';

/** Erreur renvoyée au client sous la forme `{ error: { code, message } }` (message en français, sans donnée sensible). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'REQUETE_INVALIDE') => new AppError(400, code, message);
export const unauthorized = (message = 'Authentification requise') =>
  new AppError(401, 'NON_AUTHENTIFIE', message);
export const forbidden = (message = 'Action non autorisée', code = 'INTERDIT') =>
  new AppError(403, code, message);
export const notFound = (message = 'Ressource introuvable') => new AppError(404, 'INTROUVABLE', message);
export const conflict = (message: string, code = 'CONFLIT') => new AppError(409, code, message);
export const tooMany = (message = 'Trop de tentatives, réessayez plus tard') =>
  new AppError(429, 'TROP_DE_REQUETES', message);

/** Valide une entrée ; le message ne cite que les champs en erreur, jamais leurs valeurs. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || 'corps'))].slice(0, 6);
  const first = r.error.issues[0]?.message ?? '';
  throw new AppError(
    400,
    'REQUETE_INVALIDE',
    `Requête invalide (${fields.join(', ')})${first ? ` : ${first}` : ''}`,
  );
}
