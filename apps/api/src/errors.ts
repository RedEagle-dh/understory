import { TypedError } from '@declarativejs/core';

/**
 * All product-level typed errors. Only errors listed in a route's `errors`
 * array are mapped to their status/code; anything else is treated as a bug
 * (500 + error sink).
 */

export class NotFoundError extends TypedError {
	readonly code = 'NOT_FOUND';
	readonly status = 404;
	constructor(kind: string, id: string) {
		super(`${kind} ${id} not found`);
	}
}

export class ConflictError extends TypedError {
	// Explicitly widened so subclasses can narrow the wire code without
	// narrowing the class (a `readonly code = 'CONFLICT'` literal would make
	// every subclass' own code un-assignable).
	readonly code: string = 'CONFLICT';
	readonly status = 409;
}

/**
 * The PR dedupe answer: an in-flight pull request already carries every
 * requested bump. Not an error in the "something broke" sense — the caller
 * wants the existing PR, so it travels with the request.
 */
export class PrAlreadyOpenError extends ConflictError {
	readonly code = 'PR_ALREADY_OPEN';
	constructor(
		readonly pullRequest: {
			id: string;
			number: number | null;
			url: string | null;
			branch: string;
		}
	) {
		super(
			pullRequest.url === null
				? `A pull request for these bumps is already being created on branch ${pullRequest.branch}`
				: `Pull request #${pullRequest.number} already covers these bumps: ${pullRequest.url}`
		);
	}
}

export class ScanInProgressError extends TypedError {
	readonly code = 'SCAN_IN_PROGRESS';
	readonly status = 409;
	constructor(projectId: string) {
		super(`A scan is already running for project ${projectId}`);
	}
}

export class RegistrationClosedError extends TypedError {
	readonly code = 'REGISTRATION_CLOSED';
	readonly status = 403;
	constructor() {
		super(
			'Registration is closed. Ask an administrator to create your account.'
		);
	}
}

export class GithubError extends TypedError {
	readonly code = 'GITHUB_ERROR';
	readonly status = 502;
	constructor(message: string) {
		super(`GitHub API error: ${message}`);
	}
}

export class InvalidInputError extends TypedError {
	readonly code = 'INVALID_INPUT';
	readonly status = 422;
}
