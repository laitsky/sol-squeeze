import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center border px-1.5 py-0 text-[10px] font-mono uppercase tracking-wider leading-relaxed",
  {
    variants: {
      variant: {
        default:
          "border-border text-muted-foreground",
        secondary:
          "border-transparent bg-muted text-muted-foreground",
        destructive:
          "border-transparent bg-[hsl(var(--status-error))] text-white",
        outline:
          "border-border/50 text-muted-foreground/60",
        success:
          "border-transparent bg-[hsl(var(--status-success))] text-white",
        warning:
          "border-transparent bg-[hsl(var(--status-warning))] text-black",
        info:
          "border-border text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
