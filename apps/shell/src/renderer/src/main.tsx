import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlLang } from '@genoffice/i18n'
import { AppFrame } from './AppFrame'
import { LocaleProvider } from './locale'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/dropdown.css'
import './home.css'
import './tabbar.css'
import { installScreenTips } from '@genoffice/ui'

installScreenTips()

// macOS shell window is created with vibrancy; a transparent body lets the
// editor views' translucent regions (e.g. slides thumbnail pane) show it
if (navigator.platform.toLowerCase().includes('mac')) document.body.classList.add('vib')

// resolve the persisted language, first-run flag, theme preference and the
// shell-resolved effective theme before first paint so the UI never flashes
// (home showing briefly before the onboarding overlay)
void Promise.all([
  window.aiOffice.getLanguage(),
  // if the flag is unreadable, skip onboarding rather than block the home screen
  window.aiOffice.onboardingSeen().catch(() => true),
  window.aiOffice.getTheme().catch(() => 'system' as const),
  window.aiOffice.getEffectiveTheme?.().catch(() => undefined),
]).then(([lang, onboardingSeen, theme, effective]) => {
  document.documentElement.lang = htmlLang(lang)
  // Apply the shell-resolved theme before first paint. Electron 43 does not
  // flip prefers-color-scheme, so 'system' must never be written to the element;
  // fall back to the OS media query only if an older preload lacks the getter.
  const initial =
    effective ??
    (theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme)
  document.documentElement.setAttribute('data-theme', initial)
  window.aiOffice.onThemeChanged((next) => {
    // resolved light|dark published by the main process
    document.documentElement.setAttribute('data-theme', next)
  })
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        <AppFrame initialOnboardingSeen={onboardingSeen} />
      </LocaleProvider>
    </React.StrictMode>,
  )
})
