import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";

type MetricsEnv = Record<string, string | undefined>;

function parseHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const headers: Record<string, string> = {};
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      headers[decodeURIComponent(key)] = decodeURIComponent(rawValue);
    } catch {
      headers[key] = rawValue;
    }
  }
  return headers;
}

function metricsEndpoint(env: MetricsEnv): string | null {
  if (env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) return env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  return `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "")}/v1/metrics`;
}

export function createOtlpMetricsProvider(
  serviceName: string,
  env: MetricsEnv = process.env,
): MeterProvider | null {
  const endpoint = metricsEndpoint(env);
  if (!endpoint) return null;
  const configuredInterval = Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? "60000");
  const exportIntervalMillis =
    Number.isFinite(configuredInterval) && configuredInterval >= 1_000
      ? configuredInterval
      : 60_000;
  const exporter = new OTLPMetricExporter({
    url: endpoint,
    headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
  });
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis });
  return new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
        env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV ?? env.NODE_ENV ?? "development",
    }),
    readers: [reader],
  });
}

const runtimeState = globalThis as typeof globalThis & {
  __corridorOtlpMeterProvider?: MeterProvider | null;
};

/** Install one process-wide OTLP metric exporter when an endpoint is configured. */
export function startOtlpMetrics(
  serviceName: string,
  env: MetricsEnv = process.env,
): MeterProvider | null {
  if (runtimeState.__corridorOtlpMeterProvider !== undefined)
    return runtimeState.__corridorOtlpMeterProvider;
  const provider = createOtlpMetricsProvider(serviceName, env);
  runtimeState.__corridorOtlpMeterProvider = provider;
  if (provider) metrics.setGlobalMeterProvider(provider);
  return provider;
}
