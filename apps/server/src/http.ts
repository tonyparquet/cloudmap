import { randomBytes } from 'node:crypto';
import type { Profile } from '@cloudmap/core';
import type { FastifyRequest } from 'fastify';
import type { SessionRow } from './auth/sessions.ts';
import { forbidden, unauthorized } from './errors.ts';

export type Role = 'admin' | 'editor' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  groups: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    nonce: string;
    session?: SessionRow;
    user?: AuthUser;
  }
}

export const newNonce = () => randomBytes(16).toString('base64');

/** CSP stricte (section 4.2) : aucune ressource externe, scripts et styles limités à l'origine + nonce. */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'ambient-light-sensor=()',
  'autoplay=()',
  'battery=()',
  'bluetooth=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'idle-detection=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/** En-têtes appliqués à toutes les réponses (section 4.2). */
export function securityHeaders(nonce: string, url: string): Record<string, string> {
  return {
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'content-security-policy': contentSecurityPolicy(nonce),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    ...(url.startsWith('/api/') || url === '/api' ? { 'cache-control': 'no-store' } : {}),
  };
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user || req.session?.stage !== 'full') throw unauthorized();
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): AuthUser {
  const user = requireUser(req);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

/** Ré-authentification récente exigée (identifiants, suppression de profil, gestion des utilisateurs). */
export function requireElevated(req: FastifyRequest, reauthMinutes: number): AuthUser {
  const user = requireUser(req);
  const at = req.session?.elevated_at;
  if (!at || Date.now() - at > reauthMinutes * 60_000) {
    throw forbidden('Ré-authentification requise pour cette action', 'REAUTH_REQUISE');
  }
  return user;
}

/** Cloisonnement par groupes (section 4.4). Le profil Démo est visible de tous en mode démo. */
export function canView(user: AuthUser, profile: Profile, demoMode: boolean): boolean {
  if (user.role === 'admin') return true;
  if (demoMode && isDemoProfile(profile.id)) return true;
  return profile.allowedGroups.some((g) => user.groups.includes(g));
}

export function canEdit(user: AuthUser, profile: Profile): boolean {
  if (user.role === 'admin') return true;
  return user.role === 'editor' && profile.allowedGroups.some((g) => user.groups.includes(g));
}

export const clientIp = (req: FastifyRequest) => req.ip;

/** Profils de démonstration chargés depuis fixtures/ (identifiants `demo`, `demo-…`), en lecture seule. */
export const isDemoProfile = (id: string): boolean => /^demo(-|$)/.test(id);
