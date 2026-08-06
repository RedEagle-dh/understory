export type Result<T, E> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { ok: true; value: T } {
	return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
	return { ok: false, error };
}
