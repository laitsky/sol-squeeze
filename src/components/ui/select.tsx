import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'

interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  className?: string
}

export function Select({ value, onChange, options, disabled, className }: SelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  const selected = options.find(o => o.value === value)

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(prev => !prev)}
        className="flex items-center gap-1 bg-transparent text-xs font-mono text-foreground focus:outline-none disabled:opacity-40 cursor-pointer disabled:cursor-default"
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 min-w-[120px] border border-border bg-card py-1 shadow-lg">
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={cn(
                'w-full px-3 py-1.5 text-left text-xs font-mono transition-colors',
                option.value === value
                  ? 'text-primary bg-accent'
                  : 'text-foreground hover:bg-accent'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
