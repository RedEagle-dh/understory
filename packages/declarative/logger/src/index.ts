/**
 * Server-only exports (includes Pino)
 * For client-side logging, use '@declarativejs/logger/client'
 */

// Core Logger
export {
	createLogger,
	type LogContext,
	Logger,
	type LoggerOptions,
} from './logger';
export { getActiveTraceContext } from './otel/context';
// OTEL Integration
export {
	detectOtel,
	getOtelApi,
	hasOtel,
	isOtelDetectionComplete,
} from './otel/detector';

// Tracing Initialization
export {
	getTracer,
	initTracing,
	isTracingInitialized,
	shutdownTracing,
	type TracingConfig,
} from './otel/init';
// Kafka Tracing
export {
	addCommandAttributes,
	addEventAttributes,
	endSpanSuccess,
	extractTraceContextFromKafka,
	getCurrentTraceparent,
	injectTraceContextToKafka,
	type KafkaHeaders,
	parseTraceContext,
	recordSpanError,
	startConsumerSpan,
	startProducerSpan,
	withKafkaSpan,
} from './otel/kafka';
// Span facade (framework TracerPort adapter, ADR-0009)
export {
	createSpanTracer,
	type SpanHandle,
	type SpanTracer,
	type StartSpanOptions,
} from './otel/span';

// Trace types
export type {
	PropagationHeaders,
	TraceContext,
	TraceContextResult,
} from './propagation/types';
// W3C Trace Context Propagation
export {
	createTraceContext,
	extractFromHeaders,
	formatTraceparent,
	generateSpanId,
	generateTraceId,
	injectToHeaders,
	parseTraceparent,
} from './propagation/w3c-trace-context';
