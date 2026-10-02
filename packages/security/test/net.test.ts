import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkProbeUrl, isBlockedAddress, probeUrl } from '../src/index.ts';

describe('isBlockedAddress', () => {
  it.each([
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00:ec2::254',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    'pas-une-ip',
  ])('bloque %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('autorise %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe('protection SSRF des sondes', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      } else res.writeHead(200);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('refuse HTTP en clair par défaut', () => {
    expect(checkProbeUrl('http://exemple.invalid/')).toMatch(/HTTPS/);
  });

  it('refuse les IP littérales privées et de métadonnées', async () => {
    expect((await probeUrl('https://169.254.169.254/latest/meta-data/')).error).toMatch(/bloquée/);
    expect((await probeUrl(`https://127.0.0.1:${port}/`)).error).toMatch(/bloquée/);
    expect((await probeUrl('https://[::1]/')).error).toMatch(/bloquée/);
  });

  it('refuse un nom qui résout vers une IP privée', async () => {
    const res = await probeUrl(`https://localhost:${port}/`);
    expect(res.status).toBeUndefined();
    expect(res.error).toMatch(/bloquée/);
  });

  it('autorise le privé seulement avec l’option explicite, sans jamais suivre vers les métadonnées', async () => {
    const ok = await probeUrl(`http://127.0.0.1:${port}/`, { allowHttp: true, allowPrivate: true });
    expect(ok.status).toBe(200);
    const meta = await probeUrl(`http://127.0.0.1:${port}/metadata`, { allowHttp: true, allowPrivate: true });
    expect(meta.status).toBeUndefined();
    expect(meta.error).toMatch(/bloquée/);
  });

  it('contrôle chaque cible de redirection avant connexion', () => {
    expect(checkProbeUrl(`http://10.0.0.1:${port}/`, { allowHttp: true })).toMatch(/bloquée/);
    expect(checkProbeUrl('https://user:pass@exemple.invalid/')).toMatch(/Identifiants/);
  });
});
