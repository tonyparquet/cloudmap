import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { COMMON_PASSWORDS, SEQUENCES } from './common-passwords.ts';

/** Argon2id, m = 64 Mio, t = 3, p = 1 (section 4.4). */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;
export const MIN_PASSWORD_LENGTH = 14;

export const hashPassword = (password: string) => argon2.hash(password, ARGON2_OPTIONS);

let dummyHash: Promise<string> | undefined;

/** Vérifie un mot de passe ; sans hash (utilisateur inconnu), calcule quand même un Argon2 (temps constant). */
export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Politique de mot de passe : longueur ≥ 14 et absence dans la liste locale de mots de passe courants. */
export function passwordProblem(password: string, username?: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères`;
  if (password.length > 256) return 'Le mot de passe est trop long (256 caractères au maximum)';
  const lower = password.toLowerCase();
  const base = lower.normalize('NFD').replace(/[^a-z]/g, '');
  if (
    COMMON_PASSWORDS.has(lower) ||
    (base.length > 0 && COMMON_PASSWORDS.has(base)) ||
    COMMON_PASSWORDS.has(lower.replace(/[^a-z0-9]/g, ''))
  ) {
    return 'Ce mot de passe est trop courant';
  }
  if (new Set(lower).size <= 3) return 'Ce mot de passe est trop répétitif';
  if (SEQUENCES.some((s) => s.includes(lower) || (base.length >= 6 && s.includes(base))))
    return 'Ce mot de passe est une suite triviale';
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) {
    return "Le mot de passe ne doit pas contenir l'identifiant";
  }
  return undefined;
}

// ------------------------------------------------------------------ codes de secours

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** 10 codes de secours de 50 bits (format « xxxxx-xxxxx »), stockés hachés. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5, 10)}`;
  });
}

export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecoveryCode = (code: string) =>
  createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
