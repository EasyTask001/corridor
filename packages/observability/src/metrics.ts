import { metrics, type Attributes, type Meter } from "@opentelemetry/api";

export const METRIC_NAMES = {
  customsOutboundLatency: "corridor.customs.outbound.duration",
  customsOutboundFailures: "corridor.customs.outbound.failures",
  inboxReceived: "corridor.customs.inbox.received",
  inboxStored: "corridor.customs.inbox.stored",
  inboxProcessed: "corridor.customs.inbox.processed",
  inboxDuplicates: "corridor.customs.inbox.duplicates",
  inboxUnroutable: "corridor.customs.inbox.unroutable",
  inboxFailures: "corridor.customs.inbox.failures",
  jobQueueDepth: "corridor.jobs.queue.depth",
  oldestJobAge: "corridor.jobs.oldest.age",
  submissionAckLatency: "corridor.customs.ack.duration",
  extractionDuration: "corridor.ai.extraction.duration",
  extractionFailures: "corridor.ai.extraction.failures",
  aiFailures: "corridor.ai.failures",
  watchdogIssues: "corridor.watchdog.issues",
} as const;

export interface CorridorMetrics {
  customsOutbound(input: {
    provider: string;
    operation: string;
    durationMs: number;
    ok: boolean;
  }): void;
  customsInbox(input: {
    received: number;
    stored: number;
    processed: number;
    duplicates: number;
    unroutable: number;
    failed: number;
  }): void;
  jobQueue(input: { depth: number; oldestAgeMs: number }): void;
  submissionAcknowledged(input: { provider: string; regime: string; latencyMs: number }): void;
  extraction(input: { documentType: string; durationMs: number; ok: boolean }): void;
  aiFailure(input: { operation: string; provider: string }): void;
  watchdogIssue(input: { condition: string; severity: string; count: number }): void;
}

export function createCorridorMetrics(meter: Meter): CorridorMetrics {
  const outboundDuration = meter.createHistogram(METRIC_NAMES.customsOutboundLatency, {
    unit: "ms",
    description: "Customs provider request latency",
  });
  const outboundFailures = meter.createCounter(METRIC_NAMES.customsOutboundFailures);
  const inboxReceived = meter.createCounter(METRIC_NAMES.inboxReceived);
  const inboxStored = meter.createCounter(METRIC_NAMES.inboxStored);
  const inboxProcessed = meter.createCounter(METRIC_NAMES.inboxProcessed);
  const inboxDuplicates = meter.createCounter(METRIC_NAMES.inboxDuplicates);
  const inboxUnroutable = meter.createCounter(METRIC_NAMES.inboxUnroutable);
  const inboxFailures = meter.createCounter(METRIC_NAMES.inboxFailures);
  const queueDepth = meter.createGauge(METRIC_NAMES.jobQueueDepth);
  const oldestJobAge = meter.createGauge(METRIC_NAMES.oldestJobAge, { unit: "ms" });
  const ackDuration = meter.createHistogram(METRIC_NAMES.submissionAckLatency, { unit: "ms" });
  const extractionDuration = meter.createHistogram(METRIC_NAMES.extractionDuration, { unit: "ms" });
  const extractionFailures = meter.createCounter(METRIC_NAMES.extractionFailures);
  const aiFailures = meter.createCounter(METRIC_NAMES.aiFailures);
  const watchdogIssues = meter.createCounter(METRIC_NAMES.watchdogIssues);

  const attrs = (values: Record<string, string>): Attributes => values;
  return {
    customsOutbound(input) {
      const attributes = attrs({ provider: input.provider, operation: input.operation });
      outboundDuration.record(input.durationMs, attributes);
      if (!input.ok) outboundFailures.add(1, attributes);
    },
    customsInbox(input) {
      inboxReceived.add(input.received);
      inboxStored.add(input.stored);
      inboxProcessed.add(input.processed);
      inboxDuplicates.add(input.duplicates);
      inboxUnroutable.add(input.unroutable);
      inboxFailures.add(input.failed);
    },
    jobQueue(input) {
      queueDepth.record(input.depth);
      oldestJobAge.record(input.oldestAgeMs);
    },
    submissionAcknowledged(input) {
      ackDuration.record(
        input.latencyMs,
        attrs({ provider: input.provider, regime: input.regime }),
      );
    },
    extraction(input) {
      const attributes = attrs({ document_type: input.documentType });
      extractionDuration.record(input.durationMs, attributes);
      if (!input.ok) extractionFailures.add(1, attributes);
    },
    aiFailure(input) {
      aiFailures.add(1, attrs({ operation: input.operation, provider: input.provider }));
    },
    watchdogIssue(input) {
      watchdogIssues.add(
        input.count,
        attrs({ condition: input.condition, severity: input.severity }),
      );
    },
  };
}

export const corridorMetrics = createCorridorMetrics(
  metrics.getMeter("@corridor/observability", "1.0.0"),
);
