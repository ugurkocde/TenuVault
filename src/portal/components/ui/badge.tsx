import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "~/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
        purple: "bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-200",
        blue: "bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-200",
        green: "bg-green-100 text-green-700 border-green-200 hover:bg-green-200",
        yellow: "bg-yellow-100 text-yellow-700 border-yellow-200 hover:bg-yellow-200",
        orange: "bg-orange-100 text-orange-700 border-orange-200 hover:bg-orange-200",
        pink: "bg-pink-100 text-pink-700 border-pink-200 hover:bg-pink-200",
        gray: "bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-200",
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