import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
}

export function ContextMenu({
  items,
  children,
}: {
  items: ContextMenuItem[]
  children: React.ReactElement
}) {
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null)

  React.useEffect(() => {
    if (!pos) return
    const close = () => setPos(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [pos])

  return (
    <>
      {React.cloneElement(children, {
        onContextMenu: (event: React.MouseEvent) => {
          event.preventDefault()
          children.props.onContextMenu?.(event)
          setPos({ x: event.clientX, y: event.clientY })
        },
      })}
      {pos &&
        createPortal(
          <div
            role="menu"
            className="z-50 min-w-36 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[0_12px_40px_hsl(0_0%_0%/0.12)]"
            style={{ position: 'fixed', left: pos.x, top: pos.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cn(
                  'flex w-full rounded-md px-2 py-1.5 text-left text-fs-125 outline-none hover:bg-accent disabled:opacity-50',
                )}
                onClick={() => {
                  setPos(null)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
