import { afterAll, describe, expect, it } from 'vitest';
import { whiteGlyph } from '../src/storage.ts';
import { setupAdmin, startApp } from './helpers.ts';

describe('icônes : jamais servies périmées après une mise à jour', () => {
  let close: (() => Promise<void>) | undefined;
  afterAll(() => close?.());

  it('revalidation à chaque affichage (ETag), 304 si inchangée', async () => {
    const { app } = await startApp();
    close = () => app.close();
    const { client } = await setupAdmin(app);
    const first = await client.req('GET', '/icons/network?category=network');
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-cache');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^"[\w-]+"$/);
    const again = await client.req('GET', '/icons/network?category=network', undefined, {
      'if-none-match': etag,
    });
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
  });
});

describe('icônes : pictogramme lisible sur la tuile colorée', () => {
  it('pictogramme monochrome sans fond (icône « ressource ») : passé en blanc', () => {
    const svg =
      '<svg><g fill="none"><path fill="#8C4FFF" d="M0"/><path style="fill:#8c4fff" d="M1"/></g></svg>';
    expect(whiteGlyph(svg)).toBe(
      '<svg><g fill="none"><path fill="#FFFFFF" d="M0"/><path style="fill:#FFFFFF" d="M1"/></g></svg>',
    );
  });

  it('icône avec son propre fond ou multicolore : inchangée', () => {
    const arch = '<svg><rect fill="#8C4FFF"/><path fill="white"/></svg>';
    const multi = '<svg><stop stop-color="#0078D4"/><path fill="#50E6FF"/></svg>';
    const plain = '<svg><path d="M0"/></svg>';
    for (const svg of [arch, multi, plain]) expect(whiteGlyph(svg)).toBe(svg);
  });
});
