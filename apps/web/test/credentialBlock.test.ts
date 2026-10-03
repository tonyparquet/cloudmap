import { describe, expect, it } from 'vitest';
import { parseCredentialBlock } from '../src/credentialBlock.ts';

// Valeurs d'exemple de la documentation AWS (non valides).
const ID = 'ASIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const TOKEN = 'IQoJb3JpZ2luX2VjEXAMPLE+TOKEN/abc==';
const expected = { accessKeyId: ID, secretAccessKey: SECRET, sessionToken: TOKEN };

describe('bloc d’identifiants collé', () => {
  it('variables bash du portail IAM Identity Center', () => {
    const text = `export AWS_ACCESS_KEY_ID="${ID}"\nexport AWS_SECRET_ACCESS_KEY="${SECRET}"\nexport AWS_SESSION_TOKEN="${TOKEN}"`;
    expect(parseCredentialBlock(text)).toEqual(expected);
  });

  it('PowerShell, cmd et fichier credentials', () => {
    expect(
      parseCredentialBlock(
        `$Env:AWS_ACCESS_KEY_ID="${ID}"\n$Env:AWS_SECRET_ACCESS_KEY="${SECRET}"\n$Env:AWS_SESSION_TOKEN="${TOKEN}"`,
      ),
    ).toEqual(expected);
    expect(
      parseCredentialBlock(
        `SET AWS_ACCESS_KEY_ID=${ID}\nSET AWS_SECRET_ACCESS_KEY=${SECRET}\nSET AWS_SESSION_TOKEN=${TOKEN}`,
      ),
    ).toEqual(expected);
    expect(
      parseCredentialBlock(
        `[profil]\naws_access_key_id = ${ID}\naws_secret_access_key = ${SECRET}\naws_session_token = ${TOKEN}`,
      ),
    ).toEqual(expected);
  });

  it('JSON de sts get-session-token et de configure export-credentials', () => {
    const creds = {
      AccessKeyId: ID,
      SecretAccessKey: SECRET,
      SessionToken: TOKEN,
      Expiration: '2026-10-03T12:00:00Z',
    };
    expect(parseCredentialBlock(JSON.stringify({ Credentials: creds }))).toEqual(expected);
    expect(parseCredentialBlock(JSON.stringify({ Version: 1, ...creds }))).toEqual(expected);
  });

  it('texte sans identifiants : rien', () => {
    expect(parseCredentialBlock('bonjour')).toEqual({});
  });
});
