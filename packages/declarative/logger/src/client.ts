/**
 * Client-only exports - NO Pino dependency
 * Import from '@declarativejs/logger/client' for browser bundles
 */
export {
	type ClientLogPayload,
	type ReportErrorOptions,
	reportError,
	reportWarning,
} from './client/report-error';
