import { z } from "zod";

export const providerSchema = z.enum([
  "codex",
  "openai-api",
  "gemini",
  "grok",
  "claude",
  "cursor",
  "zed",
  "other"
]);

export const periodSchema = z.enum(["hour", "day", "week", "month", "all", "custom"]);
export const windowSchema = z.enum(["hour", "day", "week", "month", "all"]);
export const sourceSchema = z.enum(["manual", "api", "oauth", "import", "codexbar"]);

export const sortSchema = z.enum([
  "tokens",
  "tokensPerHour",
  "spendUsd",
  "requests",
  "artifactBytes",
  "linesChanged",
  "sessions",
  "avgTokensPerRequest"
]);

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().trim().max(max).optional()
  );

const metricNumber = z.coerce.number().finite().nonnegative();
const metricInteger = z.coerce.number().int().nonnegative();

const measurementBaseSchema = z.object({
  fingerprint: z
    .string()
    .trim()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  displayName: z.string().trim().min(2).max(40),
  team: optionalText(40),
  provider: providerSchema.default("codex"),
  model: optionalText(80),
  topModel: optionalText(80),
  period: periodSchema.default("day"),
  observedFrom: z.string().datetime({ offset: true }),
  observedTo: z.string().datetime({ offset: true }),
  tokens: metricInteger.max(1_000_000_000_000_000).default(0),
  inputTokens: metricInteger.max(1_000_000_000_000_000).default(0),
  outputTokens: metricInteger.max(1_000_000_000_000_000).default(0),
  cachedTokens: metricInteger.max(1_000_000_000_000_000).default(0),
  requests: metricInteger.max(10_000_000_000).default(0),
  spendUsd: metricNumber.max(1_000_000_000).default(0),
  artifactBytes: metricInteger.max(1_000_000_000_000_000).default(0),
  linesChanged: metricInteger.max(1_000_000_000).default(0),
  sessions: metricInteger.max(10_000_000).default(0),
  source: sourceSchema.default("manual"),
  proofUrl: optionalText(500).refine((value) => !value || URL.canParse(value), {
    message: "Invalid URL"
  }),
  notes: optionalText(280)
});

const validateMeasurement = (
  value: z.infer<typeof measurementBaseSchema>,
  ctx: z.RefinementCtx
) => {
    const from = Date.parse(value.observedFrom);
    const to = Date.parse(value.observedTo);

    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedTo"],
        message: "observedTo must be later than observedFrom"
      });
    }

    const hasMetric =
      value.tokens > 0 ||
      value.inputTokens > 0 ||
      value.outputTokens > 0 ||
      value.cachedTokens > 0 ||
      value.requests > 0 ||
      value.spendUsd > 0 ||
      value.artifactBytes > 0 ||
      value.linesChanged > 0 ||
      value.sessions > 0;

    if (!hasMetric) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokens"],
        message: "At least one metric must be greater than zero"
      });
    }
  };

export const measurementInputSchema = measurementBaseSchema.superRefine(validateMeasurement);

export const storedMeasurementSchema = measurementBaseSchema
  .extend({
    id: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true })
  })
  .superRefine(validateMeasurement);

export const leaderboardQuerySchema = z.object({
  window: windowSchema.default("day"),
  sort: sortSchema.default("tokensPerHour"),
  provider: z.union([providerSchema, z.literal("all")]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const fingerprintParamSchema = z.object({
  fingerprint: z
    .string()
    .trim()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
});

export type Provider = z.infer<typeof providerSchema>;
export type Period = z.infer<typeof periodSchema>;
export type WindowKey = z.infer<typeof windowSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type SortKey = z.infer<typeof sortSchema>;
export type MeasurementInput = z.infer<typeof measurementInputSchema>;
export type StoredMeasurement = z.infer<typeof storedMeasurementSchema>;
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

export const defaultWindowHours: Record<WindowKey, number> = {
  hour: 1,
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
  all: 24 * 30
};

export const providerLabels: Record<Provider, string> = {
  codex: "Codex",
  "openai-api": "OpenAI API",
  gemini: "Gemini",
  grok: "Grok",
  claude: "Claude",
  cursor: "Cursor",
  zed: "Zed",
  other: "Other"
};

export const windowLabels: Record<WindowKey, string> = {
  hour: "час",
  day: "день",
  week: "неделя",
  month: "месяц",
  all: "all-time"
};
