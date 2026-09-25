import { useId, useRef } from 'react'
import { useLocale } from '../../context/LocaleContext.jsx'

const OPTIONS = [
  { value: 'de', short: 'DE', name: 'Deutsch' },
  { value: 'en', short: 'EN', name: 'English' },
]

export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useLocale()
  const id = useId()
  const buttons = useRef([])
  const activeIndex = Math.max(0, OPTIONS.findIndex(o => o.value === locale))

  // Radio-group keyboard pattern: arrows/Home/End move focus and selection.
  function onKeyDown(event) {
    const last = OPTIONS.length - 1
    const next = { ArrowRight: activeIndex + 1, ArrowDown: activeIndex + 1, ArrowLeft: activeIndex - 1, ArrowUp: activeIndex - 1, Home: 0, End: last }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const index = (next + OPTIONS.length) % OPTIONS.length
    setLocale(OPTIONS[index].value)
    buttons.current[index]?.focus()
  }

  return (
    <div className="language-switcher">
      <span id={id} className="language-switcher-label">{t('language.label')}</span>
      <div role="radiogroup" aria-labelledby={id} className="language-segment" data-active={activeIndex} onKeyDown={onKeyDown}>
        <span className="language-segment-indicator" aria-hidden="true" />
        {OPTIONS.map((option, index) => {
          const active = index === activeIndex
          return (
            <button
              key={option.value}
              ref={el => { buttons.current[index] = el }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.name}
              lang={option.value}
              title={option.name}
              tabIndex={active ? 0 : -1}
              className="language-segment-option"
              onClick={() => { if (!active) setLocale(option.value) }}
            >
              {option.short}
            </button>
          )
        })}
      </div>
    </div>
  )
}
