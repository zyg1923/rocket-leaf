import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, value, defaultValue, onChange, style, disabled, readOnly, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement)

    const isControlled = value !== undefined
    const [uncontrolled, setUncontrolled] = React.useState(
      defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : '',
    )
    const current = String(isControlled ? (value ?? '') : uncontrolled)
    const isDatetime = type === 'datetime-local'
    const showClear = !isDatetime && !disabled && !readOnly && current !== ''

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!isControlled) setUncontrolled(event.target.value)
      onChange?.(event)
    }

    const clear = (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const node = innerRef.current
      if (!node) return
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      proto?.set?.call(node, '')
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      if (!isControlled) setUncontrolled('')
      onChange?.({
        ...event,
        target: node,
        currentTarget: node,
      } as unknown as React.ChangeEvent<HTMLInputElement>)
      node.focus()
    }

    return (
      <div className="relative w-full" style={style}>
        <input
          ref={innerRef}
          type={type}
          value={isControlled ? value : undefined}
          defaultValue={isControlled ? undefined : defaultValue}
          disabled={disabled}
          readOnly={readOnly}
          {...props}
          onChange={handleChange}
          className={cn(
            'flex h-8 w-full rounded-lg border border-input bg-background px-3 py-1 text-fs-125 text-foreground shadow-sm transition-colors file:border-0 file:bg-transparent file:text-fs-125 file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:border-ring/40 disabled:cursor-not-allowed disabled:opacity-50',
            type === 'number' &&
              '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            showClear && 'pr-7',
            className,
          )}
          {...props}
        />
        {showClear && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear"
            className="text-muted-foreground hover:text-foreground absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
          >
            <X size={12} aria-hidden />
          </button>
        )}
      </div>
    )
  },
)
Input.displayName = 'Input'

export { Input }
