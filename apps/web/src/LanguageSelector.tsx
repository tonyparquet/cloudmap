import { useState } from 'react';
import deFlag from './flags/de.svg';
import esFlag from './flags/es.svg';
import gbFlag from './flags/gb.svg';
import frFlag from './flags/fr.svg';
import usFlag from './flags/us.svg';
import { t, type MessageKey } from './i18n/index.ts';
import { LOCALES, useApp, type LocaleKey } from './store.ts';

const FLAG: Record<LocaleKey, string> = {
  fr: frFlag,
  'en-GB': gbFlag,
  'en-US': usFlag,
  es: esFlag,
  de: deFlag,
};
const NAME: Record<LocaleKey, MessageKey> = {
  fr: 'langue.fr',
  'en-GB': 'langue.en-GB',
  'en-US': 'langue.en-US',
  es: 'langue.es',
  de: 'langue.de',
};

/** Sélecteur de langue à drapeau (SVG embarqués : Windows n'affiche pas les emojis-drapeaux). */
export function LanguageSelector() {
  const locale = useApp((s) => s.locale);
  const setLocale = useApp((s) => s.setLocale);
  const [open, setOpen] = useState(false);
  return (
    <div
      className="lang"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="lang-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t('langue.titre')} : ${t(NAME[locale])}`}
        onClick={() => setOpen((o) => !o)}
      >
        <img className="flag" src={FLAG[locale]} alt="" width={22} height={16} />
      </button>
      {open && (
        <ul className="lang-menu" role="listbox" aria-label={t('langue.titre')}>
          {LOCALES.map((l) => (
            <li key={l}>
              <button
                type="button"
                role="option"
                aria-selected={l === locale}
                className={l === locale ? 'active' : ''}
                onClick={() => {
                  setLocale(l);
                  setOpen(false);
                }}
              >
                <img className="flag" src={FLAG[l]} alt="" width={22} height={16} />
                <span>{t(NAME[l])}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
