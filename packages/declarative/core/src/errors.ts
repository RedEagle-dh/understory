/**
 * Errors that are part of an endpoint's contract. A route maps a thrown TypedError
 * to its HTTP status/code ONLY if the error class is listed in the route's `errors`
 * declaration — everything else is treated as a bug (500 + ErrorSink). See ADR-0009.
 */
export abstract class TypedError extends Error {
	abstract readonly code: string;
	abstract readonly status: number;
	/** When false, the message is not sent to clients (code only). */
	readonly expose: boolean = true;
}

export type TypedErrorClass = abstract new (...args: never[]) => TypedError;

export class ValidationFailedError extends TypedError {
	readonly code = 'VALIDATION_FAILED';
	readonly status = 422;

	constructor(readonly details: readonly string[]) {
		super(`Validation failed: ${details.join('; ')}`);
	}
}

export class RequestTimeoutError extends TypedError {
	readonly code = 'TIMEOUT';
	readonly status = 504;

	constructor(routeId: string, timeoutMs: number) {
		super(`Route ${routeId} exceeded ${timeoutMs}ms`);
	}
}

export function matchesDeclaredError(
	error: unknown,
	declared: readonly TypedErrorClass[] | undefined
): error is TypedError {
	if (!(error instanceof TypedError)) return false;
	return (declared ?? []).some((errorClass) => error instanceof errorClass);
}
