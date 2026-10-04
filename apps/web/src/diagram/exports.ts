import type { Graph } from '@cloudmap/core';
import type { Node, Rect } from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import { download, post } from '../api.ts';
import { containerToken, type Theme } from '../theme.ts';
import { NODE_W } from './layout.ts';
import { statusColor, type ContainerNodeData, type ResourceNodeData } from './nodes.tsx';
import { edgeStyle } from './edges.tsx';

const PAD = 40;

function viewport(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.react-flow__viewport');
  if (!el) throw new Error('Diagramme introuvable');
  return el;
}

/** Capture du diagramme complet (pas seulement la partie visible), à l'échelle 1. */
function captureOptions(bounds: Rect, bg: string) {
  const width = Math.ceil(bounds.width + PAD * 2);
  const height = Math.ceil(bounds.height + PAD * 2);
  return {
    backgroundColor: bg,
    width,
    height,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${PAD - bounds.x}px, ${PAD - bounds.y}px) scale(1)`,
    },
  };
}

let fontCss: Promise<string> | undefined;

/**
 * Police Inter (sous-ensemble latin) embarquée dans les exports. Fournie à html-to-image pour qu'il
 * n'essaie pas de résoudre lui-même les URL relatives via une balise <base> (interdite par la CSP).
 */
function fontEmbedCss(): Promise<string> {
  fontCss ??= (async () => {
    const out: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const m = /url\(["']?([^"')]*latin-wght-normal[^"')]*)["']?\)/.exec(
          rule.style.getPropertyValue('src'),
        );
        if (!m?.[1] || m[1].includes('latin-ext')) continue;
        const bytes = new Uint8Array(
          await (await fetch(new URL(m[1], sheet.href ?? window.location.href))).arrayBuffer(),
        );
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        out.push(
          `@font-face{font-family:${rule.style.getPropertyValue('font-family')};font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2');}`,
        );
      }
    }
    return out.join('\n');
  })();
  return fontCss;
}

export async function exportSvg(bounds: Rect, bg: string): Promise<string> {
  return toSvg(viewport(), { ...captureOptions(bounds, bg), fontEmbedCSS: await fontEmbedCss() });
}

export async function exportPng(bounds: Rect, bg: string): Promise<string> {
  return toPng(viewport(), {
    ...captureOptions(bounds, bg),
    pixelRatio: 2,
    fontEmbedCSS: await fontEmbedCss(),
  });
}

/** Conversion locale d'une URL data: en Blob (un fetch de data: serait bloqué par la CSP connect-src). */
function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(',');
  const head = url.slice(0, comma);
  const body = url.slice(comma + 1);
  const type = /^data:([^;,]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  if (head.endsWith(';base64'))
    return new Blob([Uint8Array.from(atob(body), (c) => c.charCodeAt(0))], { type });
  return new Blob([decodeURIComponent(body)], { type });
}

/** PDF minimal (une page, image JPEG) écrit sans dépendance. */
export function pdfFromJpeg(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const enc = new TextEncoder();
  const w = Math.round(width * 0.375);
  const h = Math.round(height * 0.375);
  const content = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (p: Uint8Array | string) => {
    const bytes = typeof p === 'string' ? enc.encode(p) : p;
    parts.push(bytes);
    size += bytes.length;
  };
  const obj = (n: number, body: (Uint8Array | string)[]) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    body.forEach(push);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  obj(3, [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  ]);
  obj(4, [
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    '\nendstream',
  ]);
  obj(5, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
  const xref = size;
  push(
    `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
      .join('')}`,
  );
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function exportPdf(bounds: Rect, bg: string): Promise<Blob> {
  const png = await exportPng(bounds, bg);
  const img = new Image();
  img.src = png;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas indisponible');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  const jpeg = new Uint8Array(await dataUrlToBlob(canvas.toDataURL('image/jpeg', 0.92)).arrayBuffer());
  const pdf = pdfFromJpeg(jpeg, canvas.width, canvas.height);
  return new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' });
}

const xml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');

/** draw.io : conteneurs imbriqués, tuiles et arêtes orthogonales avec les styles du thème. */
export function toDrawio(nodes: Node[], graph: Graph, theme: Theme): string {
  const ids = new Map<string, string>();
  const cid = (id: string) => {
    if (!ids.has(id)) ids.set(id, `c${ids.size + 2}`);
    return ids.get(id) as string;
  };
  const cells: string[] = [];
  for (const n of nodes) {
    if (n.hidden) continue;
    const parent = n.parentId ? cid(n.parentId) : '1';
    if (n.type === 'container') {
      const c = (n.data as ContainerNodeData).container;
      const tok = containerToken(theme, c.kind);
      const w = Number(n.style?.width ?? n.measured?.width ?? 200);
      const h = Number(n.style?.height ?? n.measured?.height ?? 110);
      const style = `rounded=1;arcSize=${Math.round((tok.radius / Math.min(w, h)) * 100)};fillColor=none;strokeColor=${tok.color};strokeWidth=${tok.width};${tok.dash ? `dashed=1;dashPattern=${tok.dash};` : ''}verticalAlign=${c.kind === 'subnet-public' ? 'bottom' : 'top'};align=left;spacingLeft=10;fontColor=${tok.color};fontStyle=1;container=1;collapsible=0;`;
      cells.push(
        `<mxCell id="${cid(n.id)}" value="${xml(`${c.label}${c.sublabel ? ` — ${c.sublabel}` : ''}`)}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${n.position.x}" y="${n.position.y}" width="${w}" height="${h}" as="geometry"/></mxCell>`,
      );
    } else {
      const g = (n.data as ResourceNodeData).node;
      const size = theme.node.tile.size;
      const fill = theme.category[g.category] ?? theme.category.generic ?? '#4b5563';
      const stroke = g.status === 'actif' ? statusColor(theme, g.status) : theme.node.tile.borderColor;
      const style = `rounded=1;arcSize=18;fillColor=${fill};strokeColor=${stroke};strokeWidth=${theme.node.tile.border};verticalLabelPosition=bottom;verticalAlign=top;fontColor=${theme.node.label.color};fontStyle=1;html=1;`;
      cells.push(
        `<mxCell id="${cid(n.id)}" value="${xml(`${g.label}${g.sublabel ? `\n${g.sublabel}` : ''}`)}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${n.position.x + (NODE_W - size) / 2}" y="${n.position.y}" width="${size}" height="${size}" as="geometry"/></mxCell>`,
      );
    }
  }
  const visible = new Set(nodes.filter((n) => !n.hidden).map((n) => n.id));
  for (const e of graph.edges) {
    if (!visible.has(e.source) || !visible.has(e.target)) continue;
    const { color, style } = edgeStyle(e, theme);
    const s = `edgeStyle=orthogonalEdgeStyle;rounded=1;strokeColor=${color};strokeWidth=${style.strokeWidth ?? 1.5};${style.strokeDasharray ? `dashed=1;dashPattern=${String(style.strokeDasharray)};` : ''}endArrow=block;endFill=1;fontColor=${theme.edge.label.color};labelBackgroundColor=${theme.edge.label.background};fontStyle=1;fontSize=${theme.edge.label.size};html=1;`;
    cells.push(
      `<mxCell id="${cid(e.id)}" value="${xml(e.label ?? '')}" style="${s}" edge="1" parent="1" source="${cid(e.source)}" target="${cid(e.target)}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="cloudmap"><diagram name="CloudMap" id="cloudmap"><mxGraphModel background="${theme.bg}" grid="0" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
}

export type ExportFormat = 'svg' | 'png' | 'pdf' | 'drawio' | 'json';

export async function runExport(
  format: ExportFormat,
  ctx: { bounds: Rect; nodes: Node[]; graph: Graph; theme: Theme; profileId: string; name: string },
) {
  const base = `${ctx.name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'svg') download(`${base}.svg`, dataUrlToBlob(await exportSvg(ctx.bounds, ctx.theme.bg)));
  if (format === 'png') download(`${base}.png`, dataUrlToBlob(await exportPng(ctx.bounds, ctx.theme.bg)));
  if (format === 'pdf') download(`${base}.pdf`, await exportPdf(ctx.bounds, ctx.theme.bg));
  if (format === 'drawio')
    download(`${base}.drawio`, toDrawio(ctx.nodes, ctx.graph, ctx.theme), 'application/xml');
  if (format === 'json') download(`${base}.json`, JSON.stringify(ctx.graph, null, 2), 'application/json');
  await post('/api/audit/export', { format, profileId: ctx.profileId }).catch(() => undefined);
}
