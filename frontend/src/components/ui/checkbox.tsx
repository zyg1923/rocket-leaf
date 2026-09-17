import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Checkbox({
  checked,
  indeterminate,
  onCheckedChange,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  checked?: boolean
  indeterminate?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : !!checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onCheckedChange?.(!checked)
      }}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input bg-background shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50',
        (checked || indeterminate) && 'border-primary bg-primary text-primary-foreground',
        className,
      )}
    >
      {(checked || indeterminate) && <Check size={11} aria-hidden strokeWidth={3} />}
    </button>
  )
}
