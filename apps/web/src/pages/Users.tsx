import { useState } from 'react';
import { del, get, post, put } from '../api.ts';
import { t } from '../i18n/index.ts';
import type { Role } from '../store.ts';
import { Alert, Field, fmtDate, useAction, useLoad } from '../ui.tsx';

interface UserRow {
  id: string;
  username: string;
  role: Role;
  mfa: boolean;
  oidc: boolean;
  disabled: boolean;
  createdAt: string;
  groups: string[];
}

const ROLES: Role[] = ['admin', 'editor', 'viewer'];
const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function UsersPage() {
  const users = useLoad(() => get<{ users: UserRow[] }>('/api/admin/users'), []);
  const groups = useLoad(() => get<{ groups: { name: string; members: number }[] }>('/api/admin/groups'), []);
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' as Role, groups: '' });
  const [groupName, setGroupName] = useState('');
  const [run, error, busy] = useAction();
  const act = (fn: () => Promise<unknown>) =>
    void run(async () => {
      await fn();
      users.reload();
      groups.reload();
    });

  return (
    <div style={{ maxWidth: 1100 }}>
      <h1>{t('users.titre')}</h1>
      {(error ?? users.error) && <Alert kind="error">{error ?? users.error}</Alert>}
      <div className="card">
        <table className="data">
          <thead>
            <tr>
              <th>{t('login.identifiant')}</th>
              <th>{t('users.role')}</th>
              <th>{t('users.groupes')}</th>
              <th>{t('users.mfa')}</th>
              <th>{t('cred.ajoute')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data?.users.map((u) => (
              <tr key={u.id} style={{ opacity: u.disabled ? 0.5 : 1 }}>
                <td>
                  {u.username} {u.oidc && <span className="badge">OIDC</span>}
                  {u.disabled && <span className="badge">{t('users.desactive')}</span>}
                </td>
                <td>
                  <select
                    value={u.role}
                    onChange={(e) => act(() => put(`/api/admin/users/${u.id}`, { role: e.target.value }))}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`role.${r}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    defaultValue={u.groups.join(', ')}
                    onBlur={(e) => {
                      if (e.target.value !== u.groups.join(', '))
                        act(() => put(`/api/admin/users/${u.id}`, { groups: list(e.target.value) }));
                    }}
                  />
                </td>
                <td>{u.mfa ? t('commun.oui') : t('commun.non')}</td>
                <td className="small">{fmtDate(u.createdAt)}</td>
                <td>
                  <div className="row">
                    {!u.oidc && (
                      <button onClick={() => act(() => put(`/api/admin/users/${u.id}`, { resetTotp: true }))}>
                        {t('users.reinitTotp')}
                      </button>
                    )}
                    <button
                      onClick={() => act(() => put(`/api/admin/users/${u.id}`, { disabled: !u.disabled }))}
                    >
                      {u.disabled ? t('users.activer') : t('users.desactiver')}
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (window.confirm(t('commun.confirmerSuppression')))
                          act(() => del(`/api/admin/users/${u.id}`));
                      }}
                    >
                      {t('commun.supprimer')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form
        className="card"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            await post('/api/admin/users', { ...form, groups: list(form.groups) });
            setForm({ username: '', password: '', role: 'viewer', groups: '' });
          });
        }}
      >
        <h2>{t('users.nouveau')}</h2>
        <div className="row">
          <Field label={t('login.identifiant')}>
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
            />
          </Field>
          <Field label={t('users.motDePasseInitial')}>
            <input
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
          </Field>
          <Field label={t('users.role')}>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('users.groupes')}>
            <input value={form.groups} onChange={(e) => setForm({ ...form, groups: e.target.value })} />
          </Field>
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {t('commun.creer')}
        </button>
      </form>

      <div className="card">
        <h2>{t('users.groupesTitre')}</h2>
        <table className="data">
          <tbody>
            {groups.data?.groups.map((g) => (
              <tr key={g.name}>
                <td>{g.name}</td>
                <td className="muted">
                  {t('users.membres')} : {g.members}
                </td>
                <td>
                  <button
                    className="danger"
                    onClick={() => act(() => del(`/api/admin/groups/${encodeURIComponent(g.name)}`))}
                  >
                    {t('commun.supprimer')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="row"
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await post('/api/admin/groups', { name: groupName });
              setGroupName('');
            });
          }}
        >
          <input
            placeholder={t('users.nouveauGroupe')}
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            required
          />
          <button type="submit">{t('commun.ajouter')}</button>
        </form>
      </div>
    </div>
  );
}
