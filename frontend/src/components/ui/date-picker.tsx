import * as React from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * Accepts ISO-8601 datetimes with an optional fractional second and timezone
 * suffix so values like `2026-08-17T08:00:00.000Z` still round-trip.
 */
const PARSE_RE =
  /^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(?:Z|[+-]\d{2}:?\d{2})?$/

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function parseValue(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  const match = s.match(PARSE_RE)
  if (match?.[1] && match[2]) {
    const time = match[2].length === 5 ? `${match[2]}:00` : match[2].slice(0, 8)
    return `${match[1]}T${time}`
  }
  const asDate = new Date(s)
  if (!Number.isNaN(asDate.getTime())) return toLocalInput(asDate)
  return ''
}

export function formatValue(raw: string): string {
  if (!raw) return ''
  const parsed = parseValue(raw)
  const display = parsed || raw
  return display.replace(/T/g, ' ')
}

function partsFromValue(raw: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} | null {
  const parsed = parseValue(raw)
  if (!parsed) return null
  const [datePart, timePart] = parsed.split('T')
  if (!datePart) return null
  const [ys, ms, ds] = datePart.split('-')
  const [hs, mins, ss] = (timePart || '00:00:00').split(':')
  const year = Number(ys)
  const month = Number(ms)
  const day = Number(ds)
  const hour = Number(hs || 0)
  const minute = Number(mins || 0)
  const second = Number(ss || 0)
  if ([year, month, day, hour, minute, second].some((n) => Number.isNaN(n))) return null
  return { year, month, day, hour, minute, second }
}

function weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2021, 7, 1 + i))))
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

function TimeSelect({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: number
  options: number[]
  onChange: (value: number) => void
  ariaLabel: string
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-7 rounded-md border border-input bg-background px-1 font-mono-design text-fs-12 outline-none"
    >
      {options.map((n) => (
        <option key={n} value={n}>
          {pad(n)}
        </option>
      ))}
    </select>
  )
}

export function DatePicker({
  value,
  onChange,
  placeholder,
  title,
  className,
  style,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  title?: string
  className?: string
  style?: React.CSSProperties
  disabled?: boolean
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const selected = partsFromValue(value)
  const now = new Date()
  const [view, setView] = React.useState(() =>
    selected ? new Date(selected.year, selected.month - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1),
  )

  React.useEffect(() => {
    if (!open) return
    const next = partsFromValue(value)
    if (next) setView(new Date(next.year, next.month - 1, 1))
  }, [open, value])

  const commit = (next: {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
  }) => {
    onChange(
      `${next.year}-${pad(next.month)}-${pad(next.day)}T${pad(next.hour)}:${pad(next.minute)}:${pad(next.second)}`,
    )
  }

  const current = selected ?? {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds(),
  }

  const year = view.getFullYear()
  const monthIndex = view.getMonth()
  const firstWeekday = new Date(year, monthIndex, 1).getDay()
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
  const cells = [
    ...Array.from({ length: firstWeekday }, () => null as number | null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  const monthTitle = new Intl.DateTimeFormat(i18n.language || 'zh', {
    month: 'long',
    year: 'numeric',
  }).format(view)
  const weeks = weekdayLabels(i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US')

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          type="button"
          title={title}
          style={style}
          className={cn(
            'group flex h-8 w-full items-center gap-2 rounded-lg border border-input bg-background px-2.5 py-1 text-left text-fs-125 text-foreground shadow-sm outline-none transition-colors focus-visible:border-ring/40 focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-ring/40 data-[state=open]:ring-2 data-[state=open]:ring-ring/20',
            className,
          )}
        >
          <Calendar size={13} aria-hidden className="shrink-0 opacity-50" />
          <span className={cn('min-w-0 flex-1 truncate font-mono-design', !value && 'text-muted-foreground')}>
            {value ? formatValue(value) : placeholder}
          </span>
          {value && (
            <span
              role="button"
              tabIndex={-1}
              aria-label={t('datePicker.clear')}
              className="inline-flex shrink-0 items-center justify-center rounded-sm opacity-50 hover:opacity-100"
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onChange('')
              }}
            >
              <X size={12} aria-hidden />
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[18.5rem] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-[0_12px_40px_hsl(0_0%_0%/0.12),0_2px_8px_hsl(0_0%_0%/0.04)] outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="mb-2 flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setView(new Date(year, monthIndex - 1, 1))}
            >
              <ChevronLeft size={14} />
            </Button>
            <div className="text-fs-12 font-medium">{monthTitle}</div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setView(new Date(year, monthIndex + 1, 1))}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
          <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-fs-105 text-muted-foreground">
            {weeks.map((label, i) => (
              <div key={i} className="py-1">
                {label}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, i) => {
              if (day == null) return <div key={`e-${i}`} />
              const isSelected =
                selected != null &&
                selected.year === year &&
                selected.month === monthIndex + 1 &&
                selected.day === day
              const isToday =
                now.getFullYear() === year && now.getMonth() === monthIndex && now.getDate() === day
              return (
                <button
                  key={day}
                  type="button"
                  className={cn(
                    'h-7 rounded-md text-fs-12 hover:bg-accent',
                    isSelected && 'bg-primary text-primary-foreground hover:bg-primary',
                    !isSelected && isToday && 'ring-1 ring-ring/40',
                  )}
                  onClick={() =>
                    commit({
                      ...current,
                      year,
                      month: monthIndex + 1,
                      day,
                    })
                  }
                >
                  {day}
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex items-center gap-1">
            <span className="text-muted-foreground text-fs-105">{t('datePicker.time')}</span>
            <TimeSelect
              ariaLabel="hour"
              value={current.hour}
              options={HOURS}
              onChange={(hour) => commit({ ...current, hour })}
            />
            <span className="text-muted-foreground">:</span>
            <TimeSelect
              ariaLabel="minute"
              value={current.minute}
              options={MINUTES}
              onChange={(minute) => commit({ ...current, minute })}
            />
            <span className="text-muted-foreground">:</span>
            <TimeSelect
              ariaLabel="second"
              value={current.second}
              options={MINUTES}
              onChange={(second) => commit({ ...current, second })}
            />
          </div>
          <div className="mt-2 flex justify-between gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const n = new Date()
                commit({
                  year: n.getFullYear(),
                  month: n.getMonth() + 1,
                  day: n.getDate(),
                  hour: n.getHours(),
                  minute: n.getMinutes(),
                  second: n.getSeconds(),
                })
                setView(new Date(n.getFullYear(), n.getMonth(), 1))
              }}
            >
              {t('datePicker.now')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              {t('common.confirm')}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
