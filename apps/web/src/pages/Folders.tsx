import { useState, type DragEvent, type ReactNode } from 'react';
import { api, del, post } from '../api.ts';
import { t } from '../i18n/index.ts';
import { Icon } from '../icons.tsx';

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
}

export interface FolderData {
  folders: Folder[];
  /** Dossier de chaque profil rangé (identifiant du profil → dossier). */
  entries: Record<string, string>;
}

/** Élément glissé : un profil ou un dossier (type MIME propre à l'application). */
const MIME = 'application/x-cloudmap';
type Dragged = { kind: 'profile' | 'folder'; id: string };

export function dragProps(item: Dragged) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(MIME, JSON.stringify(item));
      e.dataTransfer.effectAllowed = 'move';
      (e.currentTarget as HTMLElement).classList.add('dragging');
    },
    onDragEnd: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('dragging'),
  };
}

const readDragged = (e: DragEvent): Dragged | undefined => {
  try {
    const v = JSON.parse(e.dataTransfer.getData(MIME)) as Dragged;
    return v.kind === 'profile' || v.kind === 'folder' ? v : undefined;
  } catch {
    return undefined;
  }
};

export const childrenOf = (folders: Folder[], parentId: string | null) =>
  folders.filter((f) => f.parentId === parentId);

/** Chemin racine → dossier (fil d'Ariane). */
export function pathTo(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  for (
    let f = id ? byId.get(id) : undefined;
    f && out.length < 100;
    f = f.parentId ? byId.get(f.parentId) : undefined
  )
    out.unshift(f);
  return out;
}

/** `id` est-il `ancestor` ou l'un de ses descendants ? (un dossier ne va pas dans sa propre branche) */
const within = (folders: Folder[], id: string | null, ancestor: string) =>
  pathTo(folders, id).some((f) => f.id === ancestor);

/** Actions de rangement partagées par l'arbre, les tuiles de dossier et les menus « Déplacer vers… ». */
export function useFolderActions(
  data: FolderData | undefined,
  reload: () => void,
  onError: (m: string) => void,
) {
  const folders = data?.folders ?? [];
  const guard = (p: Promise<unknown>) =>
    p.then(reload).catch((err: Error) => {
      onError(err.message);
    });
  return {
    moveProfile: (profileId: string, folderId: string | null) =>
      guard(api('PUT', `/api/profiles/${profileId}/folder`, { folderId })),
    moveFolder: (id: string, parentId: string | null) => {
      if (parentId && within(folders, parentId, id)) return onError(t('dossiers.cycle'));
      return guard(api('PATCH', `/api/folders/${id}`, { parentId }));
    },
    create: (name: string, parentId: string | null) => guard(post('/api/folders', { name, parentId })),
    rename: (id: string, name: string) => guard(api('PATCH', `/api/folders/${id}`, { name })),
    remove: (id: string) => guard(del(`/api/folders/${id}`)),
    /** Dépôt d'un profil ou d'un dossier sur `target` (null : racine). */
    drop: (e: DragEvent, target: string | null) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).classList.remove('drop-ok');
      const item = readDragged(e);
      if (!item) return;
      if (item.kind === 'profile')
        void guard(api('PUT', `/api/profiles/${item.id}/folder`, { folderId: target }));
      else if (item.id !== target) {
        if (target && within(folders, target, item.id)) return onError(t('dossiers.cycle'));
        void guard(api('PATCH', `/api/folders/${item.id}`, { parentId: target }));
      }
    },
  };
}

/** Zone de dépôt : surbrillance pendant le survol d'un élément glissé. */
export function dropProps(onDrop: (e: DragEvent) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      (e.currentTarget as HTMLElement).classList.add('drop-ok');
    },
    onDragLeave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove('drop-ok'),
    onDrop,
  };
}

/** Menu « Déplacer vers… » : alternative clavier et pointeur simple au glisser-déposer. */
export function MoveSelect({
  folders,
  value,
  exclude,
  label,
  onMove,
}: {
  folders: Folder[];
  value: string | null;
  /** Dossier déplacé : ni lui ni ses descendants ne sont proposés. */
  exclude?: string;
  label: string;
  onMove: (folderId: string | null) => void;
}) {
  const options: ReactNode[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of childrenOf(folders, parentId)) {
      if (f.id === exclude) continue;
      options.push(
        <option key={f.id} value={f.id}>
          {`${'  '.repeat(depth)}${f.name}`}
        </option>,
      );
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return (
    <select
      className="move-select"
      aria-label={label}
      title={label}
      value={value ?? ''}
      onChange={(e) => onMove(e.target.value || null)}
    >
      <option value="">{t('dossiers.racine')}</option>
      {options}
    </select>
  );
}

/** Arborescence : sélection, dépliage, création et renommage sur place, glisser-déposer. */
export function FolderTree({
  data,
  counts,
  total,
  current,
  onSelect,
  actions,
}: {
  data: FolderData;
  counts: Map<string, number>;
  total: number;
  current: string | null;
  onSelect: (id: string | null) => void;
  actions: ReturnType<typeof useFolderActions>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creatingIn, setCreatingIn] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const createForm = (parentId: string | null) =>
    creatingIn === parentId && (
      <form
        className="tree-new reveal"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) void actions.create(draft.trim(), parentId);
          setDraft('');
          setCreatingIn(undefined);
          if (parentId) setCollapsed((s) => new Set([...s].filter((x) => x !== parentId)));
        }}
      >
        <input
          autoFocus
          aria-label={t('dossiers.nom')}
          placeholder={t('dossiers.nom')}
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setCreatingIn(undefined)}
          onBlur={() => !draft.trim() && setCreatingIn(undefined)}
        />
      </form>
    );
  const node = (f: Folder, depth: number): ReactNode => {
    const kids = childrenOf(data.folders, f.id);
    const open = !collapsed.has(f.id);
    return (
      <li
        key={f.id}
        role="treeitem"
        aria-expanded={kids.length ? open : undefined}
        aria-selected={current === f.id}
      >
        <div
          className={`tree-row${current === f.id ? ' active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          {...dragProps({ kind: 'folder', id: f.id })}
          {...dropProps((e) => actions.drop(e, f.id))}
        >
          <button
            type="button"
            className={`tree-toggle${open ? ' open' : ''}`}
            aria-label={open ? t('dossiers.replier') : t('dossiers.deplier')}
            style={{ visibility: kids.length ? 'visible' : 'hidden' }}
            onClick={() => toggle(f.id)}
          >
            <Icon name="chevron" size={12} />
          </button>
          <button type="button" className="tree-label" onClick={() => onSelect(f.id)}>
            <Icon name={current === f.id ? 'folderOpen' : 'folder'} size={15} />
            <span>{f.name}</span>
            {(counts.get(f.id) ?? 0) > 0 && <span className="tree-count">{counts.get(f.id)}</span>}
          </button>
        </div>
        {open && (kids.length > 0 || creatingIn === f.id) && (
          <ul role="group">
            {kids.map((k) => node(k, depth + 1))}
            {createForm(f.id) && <li>{createForm(f.id)}</li>}
          </ul>
        )}
      </li>
    );
  };
  return (
    <nav className="folder-tree" aria-label={t('dossiers.titre')}>
      <div className="tree-head">
        <span>{t('dossiers.titre')}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('dossiers.nouveau')}
          title={t('dossiers.nouveau')}
          onClick={() => setCreatingIn(current)}
        >
          <Icon name="folderPlus" />
        </button>
      </div>
      <ul role="tree" aria-label={t('dossiers.titre')}>
        <li role="treeitem" aria-selected={current === null}>
          <div
            className={`tree-row${current === null ? ' active' : ''}`}
            {...dropProps((e) => actions.drop(e, null))}
          >
            <span className="tree-toggle" />
            <button type="button" className="tree-label" onClick={() => onSelect(null)}>
              <Icon name="grid" size={15} />
              <span>{t('dossiers.tous')}</span>
              <span className="tree-count">{total}</span>
            </button>
          </div>
        </li>
        {childrenOf(data.folders, null).map((f) => node(f, 0))}
        {createForm(null) && <li>{createForm(null)}</li>}
      </ul>
      {data.folders.length === 0 && creatingIn === undefined && (
        <p className="muted small">{t('dossiers.aide')}</p>
      )}
    </nav>
  );
}
