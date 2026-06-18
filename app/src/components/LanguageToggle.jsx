import { useTranslation } from 'react-i18next'

export default function LanguageToggle() {
  const { i18n } = useTranslation()
  const current = i18n.language?.startsWith('en') ? 'en' : 'pt'

  function setLang(lang) {
    i18n.changeLanguage(lang)
    localStorage.setItem('neroes-hrv-lang', lang)
  }

  return (
    <div className="lang-toggle" role="group" aria-label="Language / Idioma">
      {['pt', 'en'].map(lang => (
        <button
          key={lang}
          onClick={() => setLang(lang)}
          aria-pressed={current === lang}
          aria-label={lang === 'pt' ? 'Português' : 'English'}
          className={`lang-btn ${current === lang ? 'active' : 'inactive'}`}
        >
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
