export { getActiveTraceContext } from './context';
export {
	detectOtel,
	getOtelApi,
	hasOtel,
	isOtelDetectionComplete,
} from './detector';

// Tracing initialization
export {
	getTracer,
	initTracing,
	isTracingInitialized,
	shutdownTracing,
	type TracingConfig,
} from './init';
// Kafka tracing utilities
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
} from './kafka';
// Span facade (framework TracerPort adapter, ADR-0009)
export {
	createSpanTracer,
	type SpanHandle,
	type SpanTracer,
	type StartSpanOptions,
} from './span';
