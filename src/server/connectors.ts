import { z } from "zod";

import { type MeasurementInput, periodSchema } from "../shared/schema.js";
import { appendMeasurement } from "./store.js";

const fingerprintSchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().trim().max(max).optional()
  );

const baseConnectorSchema = z.object({
  fingerprint: fingerprintSchema,
  displayName: z.string().trim().min(2).max(40),
  team: optionalText(40),
  period: periodSchema.exclude(["custom"]).default("month"),
  proofUrl: optionalText(500).refine((value) => !value || URL.canParse(value), {
    message: "Invalid URL"
  })
});

const secretString = z.string().trim().min(16).max(8192);

export const connectorMeasureSchema = z.discriminatedUnion("connector", [
  baseConnectorSchema.extend({
    connector: z.literal("openai-admin"),
    adminApiKey: secretString.max(512),
    projectIds: z
      .array(z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9_.-]+$/))
      .max(20)
      .optional()
  }),
  baseConnectorSchema.extend({
    connector: z.literal("gemini-monitoring"),
    googleAccessToken: secretString,
    googleProjectId: z.string().trim().min(3).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
  }),
  baseConnectorSchema.extend({
    connector: z.literal("xai-response"),
    model: optionalText(80),
    usage: z.union([z.string().trim().min(2).max(8192), z.record(z.unknown())])
  })
]);

export type ConnectorMeasureInput = z.infer<typeof connectorMeasureSchema>;

type ConnectorResult = {
  measurement: Awaited<ReturnType<typeof appendMeasurement>>;
  warnings: string[];
};

type DateRange = {
  observedFrom: string;
  observedTo: string;
  startUnix: number;
  endUnix: number;
};

export class ConnectorPublicError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const openAiUsageResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          start_time: z.number().optional(),
          end_time: z.number().optional(),
          results: z.array(z.record(z.unknown())).default([])
        })
        .passthrough()
    ),
    has_more: z.boolean().optional(),
    next_page: z.string().nullable().optional()
  })
  .passthrough();

const openAiCostsResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          results: z.array(z.record(z.unknown())).default([])
        })
        .passthrough()
    ),
    has_more: z.boolean().optional(),
    next_page: z.string().nullable().optional()
  })
  .passthrough();

const googleTimeSeriesResponseSchema = z
  .object({
    timeSeries: z
      .array(
        z
          .object({
            metric: z
              .object({
                labels: z.record(z.string()).optional()
              })
              .passthrough()
              .optional(),
            points: z
              .array(
                z
                  .object({
                    value: z
                      .object({
                        int64Value: z.string().optional(),
                        doubleValue: z.number().optional()
                      })
                      .passthrough()
                      .optional()
                  })
                  .passthrough()
              )
              .default([])
          })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

const xaiUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative().optional()
      })
      .passthrough()
      .optional(),
    cost_in_usd_ticks: z.number().int().nonnegative().optional()
  })
  .passthrough();

const geminiTokenMetrics = [
  "generativelanguage.googleapis.com/quota/generate_content_free_tier_input_token_count/usage",
  "generativelanguage.googleapis.com/quota/generate_content_paid_tier_input_token_count/usage",
  "generativelanguage.googleapis.com/quota/generate_content_paid_tier_2_input_token_count/usage",
  "generativelanguage.googleapis.com/quota/generate_content_paid_tier_3_input_token_count/usage"
];

const geminiRequestMetrics = [
  "generativelanguage.googleapis.com/quota/generate_content_free_tier_requests/usage",
  "generativelanguage.googleapis.com/quota/generate_requests_per_model/usage",
  "generativelanguage.googleapis.com/quota/generate_content_paid_tier_2_requests/usage",
  "generativelanguage.googleapis.com/quota/generate_content_paid_tier_3_requests/usage"
];

export async function measureConnector(input: ConnectorMeasureInput): Promise<ConnectorResult> {
  switch (input.connector) {
    case "openai-admin":
      return measureOpenAi(input);
    case "gemini-monitoring":
      return measureGemini(input);
    case "xai-response":
      return measureXaiResponse(input);
  }
}

async function measureOpenAi(
  input: Extract<ConnectorMeasureInput, { connector: "openai-admin" }>
): Promise<ConnectorResult> {
  const range = getDateRange(input.period);
  const warnings: string[] = [];
  const usageParams = baseOpenAiParams(range);
  usageParams.append("group_by", "model");
  for (const projectId of input.projectIds ?? []) {
    usageParams.append("project_ids", projectId);
  }

  let usage = await openAiGet("/organization/usage/completions", usageParams, input.adminApiKey)
    .then((json) => openAiUsageResponseSchema.parse(json))
    .catch(async (error: unknown) => {
      if (input.projectIds?.length) {
        throw error;
      }

      warnings.push("model grouping unavailable; retried without top model");
      return openAiGet(
        "/organization/usage/completions",
        baseOpenAiParams(range),
        input.adminApiKey
      ).then((json) => openAiUsageResponseSchema.parse(json));
    });

  const costsParams = baseOpenAiParams(range);
  for (const projectId of input.projectIds ?? []) {
    costsParams.append("project_ids", projectId);
  }

  const costs = await openAiGet("/organization/costs", costsParams, input.adminApiKey)
    .then((json) => openAiCostsResponseSchema.parse(json))
    .catch(() => {
      warnings.push("costs endpoint unavailable for this key");
      return { data: [] };
    });

  const usageTotals = summarizeOpenAiUsage(usage);
  const spendUsd = summarizeOpenAiCosts(costs);

  if (!hasAnyMeasuredMetric({ ...usageTotals, spendUsd })) {
    throw new ConnectorPublicError(422, "no_usage", "No OpenAI usage was found for this period.");
  }

  const measurement = await appendMeasurement({
    fingerprint: input.fingerprint,
    displayName: input.displayName,
    team: input.team,
    provider: "openai-api",
    topModel: usageTotals.topModel,
    period: input.period,
    observedFrom: range.observedFrom,
    observedTo: range.observedTo,
    tokens: usageTotals.tokens,
    inputTokens: usageTotals.inputTokens,
    outputTokens: usageTotals.outputTokens,
    cachedTokens: usageTotals.cachedTokens,
    requests: usageTotals.requests,
    spendUsd,
    artifactBytes: 0,
    linesChanged: 0,
    sessions: 0,
    source: "api",
    proofUrl: input.proofUrl,
    notes: warnings.slice(0, 2).join("; ") || undefined
  });

  return { measurement, warnings };
}

async function measureGemini(
  input: Extract<ConnectorMeasureInput, { connector: "gemini-monitoring" }>
): Promise<ConnectorResult> {
  const range = getDateRange(input.period);
  const warnings: string[] = [];
  const tokenSeries = await Promise.all(
    geminiTokenMetrics.map((metric) =>
      googleMonitoringMetricOptional(input.googleProjectId, metric, range, input.googleAccessToken, warnings)
    )
  );
  const requestSeries = await Promise.all(
    geminiRequestMetrics.map((metric) =>
      googleMonitoringMetricOptional(input.googleProjectId, metric, range, input.googleAccessToken, warnings)
    )
  );

  const tokensByModel = new Map<string, number>();
  const tokens = tokenSeries.reduce((total, series) => total + summarizeGoogleSeries(series, tokensByModel), 0);
  const requests = requestSeries.reduce((total, series) => total + summarizeGoogleSeries(series), 0);
  const topModel = [...tokensByModel.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];

  if (tokens <= 0 && requests <= 0) {
    throw new ConnectorPublicError(422, "no_usage", "No Gemini Monitoring usage was found for this period.");
  }

  const measurement = await appendMeasurement({
    fingerprint: input.fingerprint,
    displayName: input.displayName,
    team: input.team,
    provider: "gemini",
    topModel,
    period: input.period,
    observedFrom: range.observedFrom,
    observedTo: range.observedTo,
    tokens: Math.round(tokens),
    inputTokens: Math.round(tokens),
    outputTokens: 0,
    cachedTokens: 0,
    requests: Math.round(requests),
    spendUsd: 0,
    artifactBytes: 0,
    linesChanged: 0,
    sessions: 0,
    source: "oauth",
    proofUrl: input.proofUrl,
    notes: "Gemini Monitoring connector returns quota token/request usage; spend is not exposed here."
  });

  return {
    measurement,
    warnings: ["Gemini spend is not returned by Cloud Monitoring quota metrics.", ...warnings]
  };
}

async function measureXaiResponse(
  input: Extract<ConnectorMeasureInput, { connector: "xai-response" }>
): Promise<ConnectorResult> {
  const range = getDateRange(input.period);
  let rawUsage: unknown;
  try {
    rawUsage = typeof input.usage === "string" ? JSON.parse(input.usage) : input.usage;
  } catch {
    throw new ConnectorPublicError(400, "invalid_usage_json", "xAI usage JSON is invalid.");
  }
  const usage = xaiUsageSchema.parse(rawUsage);
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const tokens = usage.total_tokens ?? inputTokens + outputTokens;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const spendUsd = (usage.cost_in_usd_ticks ?? 0) / 10_000_000_000;

  if (tokens <= 0 && spendUsd <= 0) {
    throw new ConnectorPublicError(422, "no_usage", "No xAI usage was found in this response.");
  }

  const measurement = await appendMeasurement({
    fingerprint: input.fingerprint,
    displayName: input.displayName,
    team: input.team,
    provider: "grok",
    topModel: input.model,
    period: input.period,
    observedFrom: range.observedFrom,
    observedTo: range.observedTo,
    tokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    requests: 1,
    spendUsd,
    artifactBytes: 0,
    linesChanged: 0,
    sessions: 0,
    source: "api",
    proofUrl: input.proofUrl,
    notes: "xAI connector stores per-response usage; aggregate API backfill is not public."
  });

  return {
    measurement,
    warnings: ["xAI/Grok aggregate backfill is not public; this stores one API response usage object."]
  };
}

function getDateRange(period: ConnectorMeasureInput["period"]): DateRange {
  const observedToDate = new Date();
  const hoursByPeriod = {
    hour: 1,
    day: 24,
    week: 24 * 7,
    month: 24 * 30,
    all: 24 * 180
  } satisfies Record<ConnectorMeasureInput["period"], number>;
  const observedFromDate = new Date(observedToDate.getTime() - hoursByPeriod[period] * 3_600_000);

  return {
    observedFrom: observedFromDate.toISOString(),
    observedTo: observedToDate.toISOString(),
    startUnix: Math.floor(observedFromDate.getTime() / 1000),
    endUnix: Math.floor(observedToDate.getTime() / 1000)
  };
}

function baseOpenAiParams(range: DateRange) {
  const params = new URLSearchParams({
    start_time: String(range.startUnix),
    end_time: String(range.endUnix),
    bucket_width: "1d",
    limit: "180"
  });
  return params;
}

async function openAiGet(path: string, params: URLSearchParams, apiKey: string) {
  const url = new URL(`https://api.openai.com/v1${path}`);
  url.search = params.toString();
  return fetchJson(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });
}

async function googleMonitoringMetric(
  projectId: string,
  metricType: string,
  range: DateRange,
  accessToken: string
) {
  const params = new URLSearchParams({
    filter: `metric.type = "${metricType}"`,
    "interval.startTime": range.observedFrom,
    "interval.endTime": range.observedTo,
    "aggregation.alignmentPeriod": "86400s",
    "aggregation.perSeriesAligner": "ALIGN_SUM",
    view: "FULL",
    pageSize: "100000"
  });
  const url = new URL(
    `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries`
  );
  url.search = params.toString();

  return fetchJson(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }).then((json) => googleTimeSeriesResponseSchema.parse(json));
}

async function googleMonitoringMetricOptional(
  projectId: string,
  metricType: string,
  range: DateRange,
  accessToken: string,
  warnings: string[]
) {
  try {
    return await googleMonitoringMetric(projectId, metricType, range, accessToken);
  } catch (error) {
    if (error instanceof ConnectorPublicError && error.status === 401) {
      throw error;
    }

    warnings.push(`metric unavailable: ${metricType.split("/").slice(-2).join("/")}`);
    return googleTimeSeriesResponseSchema.parse({});
  }
}

async function fetchJson(url: URL, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    throw new ConnectorPublicError(
      response.status === 401 || response.status === 403 ? 401 : 502,
      "connector_failed",
      "Provider rejected the connector request."
    );
  }

  return response.json() as Promise<unknown>;
}

function summarizeOpenAiUsage(usage: z.infer<typeof openAiUsageResponseSchema>) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let requests = 0;
  const tokensByModel = new Map<string, number>();

  for (const bucket of usage.data) {
    for (const result of bucket.results) {
      const textInput = numberField(result, "input_tokens");
      const textOutput = numberField(result, "output_tokens");
      const audioInput = numberField(result, "input_audio_tokens");
      const audioOutput = numberField(result, "output_audio_tokens");
      const resultTokens = textInput + textOutput + audioInput + audioOutput;

      inputTokens += textInput + audioInput;
      outputTokens += textOutput + audioOutput;
      cachedTokens += numberField(result, "input_cached_tokens");
      requests += numberField(result, "num_model_requests");

      if (typeof result.model === "string" && resultTokens > 0) {
        tokensByModel.set(result.model, (tokensByModel.get(result.model) ?? 0) + resultTokens);
      }
    }
  }

  return {
    tokens: Math.round(inputTokens + outputTokens),
    inputTokens: Math.round(inputTokens),
    outputTokens: Math.round(outputTokens),
    cachedTokens: Math.round(cachedTokens),
    requests: Math.round(requests),
    topModel: [...tokensByModel.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
  };
}

function summarizeOpenAiCosts(costs: z.infer<typeof openAiCostsResponseSchema>) {
  let spendUsd = 0;
  for (const bucket of costs.data) {
    for (const result of bucket.results) {
      if (isObject(result.amount) && result.amount.currency === "usd") {
        spendUsd += numberField(result.amount, "value");
      }
    }
  }

  return Math.round(spendUsd * 100) / 100;
}

function summarizeGoogleSeries(
  response: z.infer<typeof googleTimeSeriesResponseSchema>,
  byModel?: Map<string, number>
) {
  let total = 0;

  for (const series of response.timeSeries) {
    const seriesTotal = series.points.reduce((sum, point) => sum + pointValue(point.value), 0);
    total += seriesTotal;

    const model = series.metric?.labels?.model;
    if (byModel && model && seriesTotal > 0) {
      byModel.set(model, (byModel.get(model) ?? 0) + seriesTotal);
    }
  }

  return total;
}

function pointValue(value: { int64Value?: string; doubleValue?: number } | undefined) {
  if (!value) return 0;
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (value.int64Value) return Number(value.int64Value);
  return 0;
}

function hasAnyMeasuredMetric(value: {
  tokens: number;
  requests: number;
  spendUsd: number;
}) {
  return value.tokens > 0 || value.requests > 0 || value.spendUsd > 0;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
