import { describe, expect, it } from 'vitest';
import { MASK, maskAccessKeyId, redact, redactString } from '../src/index.ts';

// Valeurs d'exemple de la documentation AWS (non valides).
const AKID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const TOKEN = 'IQoJb3JpZ2luX2VjEJr'.repeat(12);

describe('redact()', () => {
  it('masque les identifiants de clé d’accès', () => {
    expect(maskAccessKeyId(AKID)).toBe('AKIA…MPLE');
    expect(redactString(`clé ${AKID} refusée`)).toBe('clé AKIA…MPLE refusée');
  });

  it('masque les clés secrètes et les jetons de session dans le texte', () => {
    const out = redactString(`secret=${SECRET} token ${TOKEN}`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(TOKEN.slice(0, 40));
    expect(out).toContain(MASK);
  });

  it('masque les en-têtes Authorization et les cookies', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(redactString('AWS4-HMAC-SHA256 Credential=AKIA/xx')).not.toContain('Credential=AKIA/xx');
    expect(redactString('cookie: __Host-session=s3cr3tvalue; other=1')).not.toContain('s3cr3tvalue');
  });

  it('masque récursivement les champs sensibles', () => {
    const input = {
      accessKeyId: AKID,
      secretAccessKey: SECRET,
      sessionToken: TOKEN,
      nested: { password: 'hunter2hunter2', headers: { authorization: 'Basic Zm9vOmJhcg==', cookie: 'a=b' } },
      list: [`texte ${SECRET}`],
      safe: 'eu-west-3',
    };
    const out = redact(input);
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('Zm9vOmJhcg==');
    expect(out.accessKeyId).toBe('AKIA…MPLE');
    expect(out.safe).toBe('eu-west-3');
    expect(input.secretAccessKey).toBe(SECRET); // l'entrée n'est pas modifiée
  });

  it('gère les erreurs et les références circulaires', () => {
    const err = new Error(`échec avec ${SECRET}`);
    const obj: Record<string, unknown> = { err };
    obj.self = obj;
    const out = redact(obj) as { err: { message: string }; self: unknown };
    expect(out.err.message).not.toContain(SECRET);
    expect(out.self).toBe('[circulaire]');
  });

  it('masque les secrets Azure et Google Cloud (jetons, secrets clients, clés de comptes de service)', () => {
    // Valeurs fictives au format réel.
    const jwt =
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL21hbmFnZW1lbnQifQ.c2lnbmF0dXJlLWZpY3RpdmU';
    const google = 'ya29.a0AfB_fictif-jeton-oauth-google-0123456789';
    const entra = 'abc8Q~0123456789abcdefghijABCDEFGHIJ-_.~';
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const text = `jeton ${jwt} google ${google} secret ${entra} clé ${key} access_token=abc123 "private_key": "x"`;
    const out = redactString(text);
    for (const secret of [jwt, google, entra, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'abc123'])
      expect(out).not.toContain(secret);
    expect(redact({ clientSecret: entra, serviceAccountJson: key, accessToken: google })).toEqual({
      clientSecret: MASK,
      serviceAccountJson: MASK,
      accessToken: MASK,
    });
  });
});
