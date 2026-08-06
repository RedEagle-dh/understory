interface PageHeaderProps {
  title: string
  description?: string
  actions?: React.ReactNode
}

/** Consistent title + description + right-aligned actions slot for every route. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">
          {title}
        </h1>
        {description !== undefined && (
          <p className="text-muted-foreground text-sm">{description}</p>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  )
}
