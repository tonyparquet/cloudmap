import { describe, expect, it } from 'vitest';
import { whiteGlyph } from '../src/storage.ts';

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
