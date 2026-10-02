import * as client from 'openid-client';
import { z } from 'zod';
import type { OidcSettings } from '../config.ts';

export const oidcPendingSchema = z.object({
  verifier: z.string(),
  state: z.string(),
  nonce: z.string(),
  reauth: z.boolean(),
  createdAt: z.number(),
});
export type OidcPending = z.infer<typeof oidcPendingSchema>;

export interface OidcIdentity {
  subject: string;
  username: string;
  groups: string[];
}

/** OpenID Connect : Authorization Code + PKCE (S256), vérification de `state` et `nonce` (section 4.4). */
export class Oidc {
  private config?: Promise<client.Configuration>;

  constructor(
    private readonly settings: OidcSettings,
    private readonly publicOrigin: string,
  ) {}

  get redirectUri(): string {
    return `${this.publicOrigin}/api/auth/oidc/callback`;
  }

  private conf(): Promise<client.Configuration> {
    this.config ??= client.discovery(
      new URL(this.settings.issuer),
      this.settings.clientId,
      this.settings.clientSecret,
    );
    return this.config;
  }

  async start(reauth: boolean): Promise<{ url: string; pending: OidcPending }> {
    const verifier = client.randomPKCECodeVerifier();
    const pending: OidcPending = {
      verifier,
      state: client.randomState(),
      nonce: client.randomNonce(),
      reauth,
      createdAt: Date.now(),
    };
    const url = client.buildAuthorizationUrl(await this.conf(), {
      redirect_uri: this.redirectUri,
      scope: 'openid profile email',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: pending.state,
      nonce: pending.nonce,
      ...(reauth ? { prompt: 'login', max_age: '0' } : {}),
    });
    return { url: url.href, pending };
  }

  async callback(currentUrl: URL, pending: OidcPending): Promise<OidcIdentity> {
    if (Date.now() - pending.createdAt > 10 * 60_000) throw new Error('Tentative OIDC expirée');
    const tokens = await client.authorizationCodeGrant(await this.conf(), currentUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
      ...(pending.reauth ? { maxAge: 300 } : {}),
    });
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error('Jeton d’identité absent');
    const raw = claims[this.settings.groupsClaim];
    const groups = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter(
      (g): g is string => typeof g === 'string' && /^[\w.-]{1,64}$/.test(g),
    );
    const name = [claims.preferred_username, claims.email, claims.sub].find(
      (v) => typeof v === 'string' && v,
    );
    return { subject: claims.sub, username: String(name), groups };
  }

  roleFor(groups: string[]): 'admin' | 'editor' | 'viewer' {
    if (this.settings.adminGroup && groups.includes(this.settings.adminGroup)) return 'admin';
    if (this.settings.editorGroup && groups.includes(this.settings.editorGroup)) return 'editor';
    return 'viewer';
  }
}
