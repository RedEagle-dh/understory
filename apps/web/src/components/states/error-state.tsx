import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import type { LucideIcon } from "lucide-react"
import { AlertTriangle, Lock, ShieldAlert, WifiOff } from "lucide-react"
import { ApiError } from "@/lib/api-error"

interface ErrorStateProps {
  error?: unknown
  onRetry?: () => void
}

interface ErrorDescriptor {
  icon: LucideIcon
  title: string
  description?: string
}

function describeError(error: unknown): ErrorDescriptor {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return {
        icon: Lock,
        title: "Not permitted",
        description: "You don't have access to this.",
      }
    }
    if (error.status === 401) {
      return {
        icon: ShieldAlert,
        title: "Session expired",
        description: "Sign in again to continue.",
      }
    }
    if (error.status === 0) {
      return {
        icon: WifiOff,
        title: "API unreachable",
        description:
          "Could not reach the server. Check your connection and try again.",
      }
    }
    return {
      icon: AlertTriangle,
      title: "Something went wrong",
      description: error.detail,
    }
  }

  return {
    icon: AlertTriangle,
    title: "Something went wrong",
    description: error instanceof Error ? error.message : undefined,
  }
}

/** Recognizes ApiError status codes to give a specific message; falls back generically. */
export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const { icon: Icon, title, description } = describeError(error)

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined && (
          <EmptyDescription>{description}</EmptyDescription>
        )}
      </EmptyHeader>
      {onRetry !== undefined && (
        <EmptyContent>
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}
