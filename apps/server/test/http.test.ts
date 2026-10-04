import type { AddressInfo } from 'node:net';
import { connect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TLS_CIPHERS } from '../src/tls.ts';
import { ADMIN, allowTotpReuse, Client, setupAdmin, startApp, totp } from './helpers.ts';

type App = Awaited<ReturnType<typeof startApp>>;

describe('transport TLS 1.3 uniquement (section 4.1)', () => {
  let s: App;
  let port = 0;
  beforeAll(async () => {
    s = await startApp();
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    port = (s.app.server.address() as AddressInfo).port;
  });
  afterAll(() => s.app.close());

  const handshake = (version: 'TLSv1.2' | 'TLSv1.3') =>
    new Promise<{ ok: boolean; protocol?: string | null; cipher?: string }>((resolve) => {
      const socket = connect({
        host: '127.0.0.1',
        port,
        minVersion: version,
        maxVersion: version,
        rejectUnauthorized: false,
        servername: 'localhost',
      });
      socket.once('secureConnect', () => {
        resolve({ ok: true, protocol: socket.getProtocol(), cipher: socket.getCipher().standardName });
        socket.end();
      });
      socket.once('error', () => resolve({ ok: false }));
    });

  it('refuse une connexion TLS 1.2', async () => {
    expect((await handshake('TLSv1.2')).ok).toBe(false);
  });

  it('accepte TLS 1.3 avec une suite autorisée', async () => {
    const r = await handshake('TLSv1.3');
    expect(r.ok).toBe(true);
    expect(r.protocol).toBe('TLSv1.3');
    expect(TLS_CIPHERS.split(':')).toContain(r.cipher);
  });
});

describe('en-têtes, sessions, CSRF, MFA, limitation (sections 4.2 et 4.4)', () => {
  let s: App;
  beforeAll(async () => {
    s = await startApp();
  });
  afterAll(() => s.app.close());

  it('pose tous les en-têtes de sécurité, sans Server ni X-Powered-By', async () => {
    const res = await s.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
    const h = res.headers;
    expect(h['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload');
    const csp = String(h['content-security-policy']);
    for (const d of [
      "default-src 'self'",
      "script-src 'self' 'nonce-",
      "style-src 'self' 'nonce-",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      'upgrade-insecure-requests',
    ]) {
      expect(csp).toContain(d);
    }
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-frame-options']).toBe('DENY');
    expect(String(h['permissions-policy'])).toMatch(
      /camera=\(\).*geolocation=\(\).*microphone=\(\).*payment=\(\).*usb=\(\)/,
    );
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(h['cross-origin-embedder-policy']).toBe('require-corp');
    expect(h.server).toBeUndefined();
    expect(h['x-powered-by']).toBeUndefined();
  });

  it('Cache-Control: no-store sur /api et réponses d’erreur au format { error: { code, message } }', async () => {
    const res = await s.app.inject({ method: 'GET', url: '/api/profiles' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ error: { code: 'NON_AUTHENTIFIE', message: 'Authentification requise' } });
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('pages : /login publique (nonce CSP), le reste redirige vers /login sans session', async () => {
    const login = await s.app.inject({ method: 'GET', url: '/login' });
    expect(login.statusCode).toBe(200);
    expect((await s.app.inject({ method: 'GET', url: '/' })).headers.location).toBe('/login');
    expect((await s.app.inject({ method: 'GET', url: '/profils/x' })).statusCode).toBe(302);
    expect((await s.app.inject({ method: 'GET', url: '/icons/ecs' })).statusCode).toBe(401);
  });

  let admin: Awaited<ReturnType<typeof setupAdmin>>;

  it('mot de passe faible refusé à la création de l’administrateur', async () => {
    const c = new Client(s.app);
    await c.req('GET', '/api/auth/state');
    const res = await c.req('POST', '/api/auth/register', {
      username: 'admin',
      password: 'motdepasse2024!!',
    });
    expect(res.status).toBe(400);
    expect(res.json().error.code).toBe('MOT_DE_PASSE_FAIBLE');
    expect((await c.req('POST', '/api/auth/register', { username: 'admin', password: 'court' })).status).toBe(
      400,
    );
  });

  it('cookie de session : __Host-, Secure, HttpOnly, SameSite=Strict, Path=/, régénéré à la connexion', async () => {
    const c = new Client(s.app);
    const state = await c.req('GET', '/api/auth/state');
    const cookie = String(state.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    expect(cookie).not.toMatch(/Domain=/i);
    const anon = c.cookie;
    admin = await setupAdmin(s.app);
    expect(admin.client.cookie).not.toBe(anon);
  });

  it('CSRF : requête sans jeton ou avec une autre Origin rejetée', async () => {
    const c = admin.client;
    const body = {
      name: 'x',
      accountId: '123456789012',
      regions: ['eu-west-3'],
      auth: { kind: 'import-only' },
      allowedGroups: [],
    };
    const noToken = await c.req('POST', '/api/profiles', body, { 'x-csrf-token': '' });
    expect(noToken.status).toBe(403);
    expect(noToken.json().error.code).toBe('CSRF');
    const badOrigin = await c.req('POST', '/api/profiles', body, { origin: 'https://attaquant.exemple' });
    expect(badOrigin.status).toBe(403);
    const noOrigin = await s.app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(noOrigin.statusCode).toBe(403);
    expect((await c.req('POST', '/api/profiles', body)).status).toBe(200);
  });

  it('MFA activé : mot de passe seul insuffisant, TOTP sans rejeu', async () => {
    const c = new Client(s.app);
    await c.req('GET', '/api/auth/state');
    const login = await c.req('POST', '/api/auth/login', ADMIN);
    expect(login.json().stage).toBe('mfa');
    expect((await c.req('GET', '/api/profiles')).status).toBe(401);
    allowTotpReuse(s.ctx, ADMIN.username);
    const code = await totp(admin.secret);
    expect((await c.req('POST', '/api/auth/totp', { code })).status).toBe(200);
    expect((await c.req('GET', '/api/profiles')).status).toBe(200);

    // Même code réutilisé sur une autre session : refusé (anti-rejeu).
    const d = new Client(s.app);
    await d.req('GET', '/api/auth/state');
    await d.req('POST', '/api/auth/login', ADMIN);
    expect((await d.req('POST', '/api/auth/totp', { code })).status).toBe(401);
    // Code de secours à usage unique.
    expect((await d.req('POST', '/api/auth/totp', { code: admin.recoveryCodes[0] })).status).toBe(200);
    const e = new Client(s.app);
    await e.req('GET', '/api/auth/state');
    await e.req('POST', '/api/auth/login', ADMIN);
    expect((await e.req('POST', '/api/auth/totp', { code: admin.recoveryCodes[0] })).status).toBe(401);
  });

  it('ré-authentification exigée avant la gestion des utilisateurs', async () => {
    const res = await admin.client.req('GET', '/api/admin/users');
    expect(res.status).toBe(403);
    expect(res.json().error.code).toBe('REAUTH_REQUISE');
  });

  it('limitation des tentatives de connexion : verrouillage après 5 échecs', async () => {
    s.ctx.db.prepare('DELETE FROM rate_limits').run(); // compteurs des tests précédents (même IP)
    const c = new Client(s.app);
    await c.req('GET', '/api/auth/state');
    for (let i = 0; i < 5; i++) {
      expect(
        (await c.req('POST', '/api/auth/login', { username: 'victime', password: 'mauvais-mot-de-passe' }))
          .status,
      ).toBe(401);
    }
    const locked = await c.req('POST', '/api/auth/login', {
      username: 'victime',
      password: 'mauvais-mot-de-passe',
    });
    expect(locked.status).toBe(429);
    // Le verrouillage par IP bloque aussi les autres comptes depuis cette adresse.
    expect((await c.req('POST', '/api/auth/login', ADMIN)).status).toBe(429);
    s.ctx.db.prepare('DELETE FROM rate_limits').run();
  });

  it('déconnexion : la session est détruite', async () => {
    const c = admin.client;
    expect((await c.req('POST', '/api/auth/logout')).status).toBe(200);
    expect(c.cookie).toBe('');
    const res = await s.app.inject({ method: 'GET', url: '/api/profiles', headers: { cookie: 'x=y' } });
    expect(res.statusCode).toBe(401);
  });

  it('journal d’audit en ajout seul', () => {
    expect(() => s.ctx.db.prepare("UPDATE audit SET action = 'x'").run()).toThrow(/ajout seul/);
    expect(() => s.ctx.db.prepare('DELETE FROM audit').run()).toThrow(/ajout seul/);
    const actions = (
      s.ctx.db.prepare('SELECT action, result FROM audit').all() as { action: string; result: string }[]
    ).map((r) => `${r.action}:${r.result}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        'connexion:succes',
        'connexion:echec',
        'connexion:refus',
        'profil.creation:succes',
      ]),
    );
  });
});
