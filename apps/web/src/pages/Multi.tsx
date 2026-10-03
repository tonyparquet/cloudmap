import { useState } from 'react';
import { get } from '../api.ts';
import { t } from '../i18n/index.ts';
import { navigate } from '../router.tsx';
import { Alert, fmtDate, useLoad } from '../ui.tsx';
import type { ProfileView } from './Profiles.tsx';

/** Choix des profils (comptes) à réunir dans un même diagramme ; la sélection est portée par l'URL. */
export function MultiPage() {
  const profiles = useLoad(() => get<{ profiles: ProfileView[] }>('/api/profiles'), []);
  const [chosen, setChosen] = useState<string[]>(
    () => new URLSearchParams(window.location.search).get('profils')?.split(',').filter(Boolean) ?? [],
  );
  const list = profiles.data?.profiles ?? [];
  const toggle = (id: string, on: boolean) =>
    setChosen(on ? [...chosen, id] : chosen.filter((x) => x !== id));

  return (
    <div style={{ maxWidth: 820 }}>
      <h1>{t('multi.titre')}</h1>
      <p className="muted">{t('multi.intro')}</p>
      {profiles.error && <Alert kind="error">{profiles.error}</Alert>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(`/multi-comptes/${chosen.join(',')}`);
        }}
      >
        <fieldset className="choices" data-testid="choix-comptes">
          <legend>{t('multi.choisir')}</legend>
          {list.map((p) => {
            const scanned = !!p.lastSnapshot;
            return (
              <label
                key={p.id}
                className={`choice${chosen.includes(p.id) ? ' selected' : ''}${scanned ? '' : ' disabled'}`}
              >
                <input
                  type="checkbox"
                  checked={chosen.includes(p.id)}
                  disabled={!scanned}
                  onChange={(e) => toggle(p.id, e.target.checked)}
                />
                <span>
                  <strong>
                    {p.name} · <span className="mono">{p.accountId}</span>
                  </strong>
                  <span className="muted small">
                    {p.lastSnapshot
                      ? t('profils.dernierScan', {
                          date: fmtDate(p.lastSnapshot.createdAt),
                          n: p.lastSnapshot.resourceCount,
                        })
                      : t('profils.jamaisScanne')}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className="muted small">{t('multi.liens')}</p>
        <button className="primary" type="submit" disabled={chosen.length === 0}>
          {t('multi.afficher', { n: chosen.length })}
        </button>
      </form>
    </div>
  );
}
