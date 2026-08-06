/**
 * Normalized error thrown by `unwrap()` around Eden treaty responses so
 * TanStack Query's error paths (and shared ErrorState components) can switch
 * on status without knowing treaty's response shape.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`API error ${status}`)
  }

  get detail(): string {
    if (
      typeof this.body === "object" &&
      this.body !== null &&
      "message" in this.body &&
      typeof this.body.message === "string"
    ) {
      return this.body.message
    }
    return `Request failed with status ${this.status}`
  }
}

interface TreatyResponseShape {
  data: unknown
  error: { status: unknown; value: unknown } | null
}

export function unwrap<R extends TreatyResponseShape>(
  res: R
): NonNullable<R["data"]> {
  if (res.error !== null) {
    throw new ApiError(Number(res.error.status), res.error.value)
  }
  return res.data as NonNullable<R["data"]>
}
