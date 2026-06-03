import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  defaultWindowHours,
  leaderboardQuerySchema,
  type LeaderboardQuery,
  type MeasurementInput,
  type Provider,
  type SortKey,
  type StoredMeasurement,
  type WindowKey,
  storedMeasurementSchema
} from "../shared/schema.js";

export type LeaderboardRow = {
  rank: number;
  fingerprint: string;
  fingerprintShort: string;
  displayName: string;
  team?: string;
  providers: Provider[];
  topModel?: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
  spendUsd: number;
  artifactBytes: number;
  linesChanged: number;
  sessions: number;
  durationHours: number;
  tokensPerHour: number;
  requestsPerHour: number;
  avgTokensPerRequest: number;
  artifactMb: number;
  lastSeen: string;
  sources: string[];
};

export type LeaderboardResponse = {
  query: LeaderboardQuery;
  generatedAt: string;
  rows: LeaderboardRow[];
};

export type PublicStats = {
  measurements: number;
  fingerprints: number;
  latestUpdate?: string;
  providers: Array<{ provider: Provider; count: number }>;
};

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), "data");
const dataFile = path.join(dataDir, "measurements.jsonl");

let writeQueue = Promise.resolve();

export const getDataFilePath = () => dataFile;

export async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, "", { encoding: "utf8", mode: 0o600 });
  }
}

export async function readMeasurements(): Promise<StoredMeasurement[]> {
  await ensureStore();
  const raw = await fs.readFile(dataFile, "utf8");
  const records: StoredMeasurement[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = storedMeasurementSchema.parse(JSON.parse(trimmed));
      records.push(parsed);
    } catch {
      // Corrupt lines are ignored so one bad append cannot break public reads.
    }
  }

  return records;
}

export async function appendMeasurement(input: MeasurementInput): Promise<StoredMeasurement> {
  await ensureStore();
  const record: StoredMeasurement = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString()
  };
  const line = `${JSON.stringify(record)}\n`;

  writeQueue = writeQueue.then(() => fs.appendFile(dataFile, line, { encoding: "utf8" }));
  await writeQueue;

  return record;
}

export async function getStats(): Promise<PublicStats> {
  const records = await readMeasurements();
  const fingerprints = new Set(records.map((record) => record.fingerprint));
  const providerCounts = new Map<Provider, number>();

  for (const record of records) {
    providerCounts.set(record.provider, (providerCounts.get(record.provider) ?? 0) + 1);
  }

  return {
    measurements: records.length,
    fingerprints: fingerprints.size,
    latestUpdate: records
      .map((record) => record.createdAt)
      .sort((left, right) => right.localeCompare(left))[0],
    providers: [...providerCounts.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((left, right) => right.count - left.count)
  };
}

export async function getProfile(fingerprint: string) {
  const records = (await readMeasurements())
    .filter((record) => record.fingerprint === fingerprint)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return {
    fingerprint,
    fingerprintShort: shortFingerprint(fingerprint),
    measurements: records,
    leaderboard: {
      hour: await buildLeaderboard({ window: "hour", sort: "tokensPerHour", provider: "all", limit: 100 }),
      day: await buildLeaderboard({ window: "day", sort: "tokensPerHour", provider: "all", limit: 100 }),
      week: await buildLeaderboard({ window: "week", sort: "tokensPerHour", provider: "all", limit: 100 }),
      month: await buildLeaderboard({ window: "month", sort: "tokensPerHour", provider: "all", limit: 100 }),
      all: await buildLeaderboard({ window: "all", sort: "tokensPerHour", provider: "all", limit: 100 })
    }
  };
}

export async function buildLeaderboard(query: LeaderboardQuery): Promise<LeaderboardResponse> {
  const normalizedQuery = leaderboardQuerySchema.parse(query);
  const records = await readMeasurements();
  const latestByFingerprintProvider = new Map<string, StoredMeasurement>();
  const sdkByFingerprintProvider = new Map<string, StoredMeasurement[]>();

  for (const record of records) {
    if (normalizedQuery.provider !== "all" && record.provider !== normalizedQuery.provider) continue;

    const key = `${record.fingerprint}:${record.provider}`;

    if (record.source === "sdk") {
      if (!sdkEventMatchesWindow(record, normalizedQuery.window)) continue;
      const bucket = sdkByFingerprintProvider.get(key) ?? [];
      bucket.push(record);
      sdkByFingerprintProvider.set(key, bucket);
      continue;
    }

    if (!snapshotMatchesWindow(record, normalizedQuery.window)) continue;

    const current = latestByFingerprintProvider.get(key);
    if (!current || record.createdAt > current.createdAt) {
      latestByFingerprintProvider.set(key, record);
    }
  }

  const grouped = new Map<string, StoredMeasurement[]>();
  for (const record of latestByFingerprintProvider.values()) {
    const bucket = grouped.get(record.fingerprint) ?? [];
    bucket.push(record);
    grouped.set(record.fingerprint, bucket);
  }
  for (const [key, records] of sdkByFingerprintProvider.entries()) {
    if (latestByFingerprintProvider.has(key)) continue;
    const fingerprint = records[0]?.fingerprint;
    if (!fingerprint) continue;
    const bucket = grouped.get(fingerprint) ?? [];
    bucket.push(...records);
    grouped.set(fingerprint, bucket);
  }

  const rows = [...grouped.entries()].map(([fingerprint, snapshots]) =>
    summarizeSnapshots(fingerprint, snapshots, normalizedQuery.window)
  );

  rows.sort((left, right) => compareRows(left, right, normalizedQuery.sort));

  return {
    query: normalizedQuery,
    generatedAt: new Date().toISOString(),
    rows: rows.slice(0, normalizedQuery.limit).map((row, index) => ({
      ...row,
      rank: index + 1
    }))
  };
}

function snapshotMatchesWindow(record: StoredMeasurement, window: WindowKey) {
  if (window === "all") {
    return record.period === "all";
  }
  return record.period === window;
}

function sdkEventMatchesWindow(record: StoredMeasurement, window: WindowKey) {
  if (window === "all") return true;

  const observedTo = Date.parse(record.observedTo);
  if (!Number.isFinite(observedTo)) return false;

  const windowMs = defaultWindowHours[window] * 3_600_000;
  return observedTo >= Date.now() - windowMs;
}

function summarizeSnapshots(
  fingerprint: string,
  snapshots: StoredMeasurement[],
  window: WindowKey
): Omit<LeaderboardRow, "rank"> & { rank: number } {
  const newest = [...snapshots].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const topModelRecord = [...snapshots].sort((left, right) => right.tokens - left.tokens)[0];
  const durationHours =
    window === "all"
      ? Math.max(...snapshots.map(measurementDurationHours), defaultWindowHours.all)
      : defaultWindowHours[window];

  const totals = snapshots.reduce(
    (acc, snapshot) => {
      acc.tokens += snapshot.tokens;
      acc.inputTokens += snapshot.inputTokens;
      acc.outputTokens += snapshot.outputTokens;
      acc.cachedTokens += snapshot.cachedTokens;
      acc.requests += snapshot.requests;
      acc.spendUsd += snapshot.spendUsd;
      acc.artifactBytes += snapshot.artifactBytes;
      acc.linesChanged += snapshot.linesChanged;
      acc.sessions += snapshot.sessions;
      return acc;
    },
    {
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      requests: 0,
      spendUsd: 0,
      artifactBytes: 0,
      linesChanged: 0,
      sessions: 0
    }
  );

  const tokensPerHour = safeDivide(totals.tokens, durationHours);
  const requestsPerHour = safeDivide(totals.requests, durationHours);
  const avgTokensPerRequest = safeDivide(totals.tokens, totals.requests);

  return {
    rank: 0,
    fingerprint,
    fingerprintShort: shortFingerprint(fingerprint),
    displayName: newest.displayName,
    team: newest.team,
    providers: [...new Set(snapshots.map((snapshot) => snapshot.provider))].sort(),
    topModel: topModelRecord.topModel ?? topModelRecord.model,
    ...totals,
    durationHours,
    tokensPerHour,
    requestsPerHour,
    avgTokensPerRequest,
    artifactMb: totals.artifactBytes / 1_048_576,
    lastSeen: newest.createdAt,
    sources: [...new Set(snapshots.map((snapshot) => snapshot.source))].sort()
  };
}

function compareRows(left: LeaderboardRow, right: LeaderboardRow, sort: SortKey) {
  const byMetric = right[sort] - left[sort];
  if (byMetric !== 0) return byMetric;

  const byTokens = right.tokens - left.tokens;
  if (byTokens !== 0) return byTokens;

  return left.displayName.localeCompare(right.displayName);
}

function measurementDurationHours(record: StoredMeasurement) {
  const hours = (Date.parse(record.observedTo) - Date.parse(record.observedFrom)) / 3_600_000;
  return Number.isFinite(hours) && hours > 0 ? hours : defaultWindowHours.all;
}

function safeDivide(value: number, divider: number) {
  return divider > 0 ? value / divider : 0;
}

function shortFingerprint(fingerprint: string) {
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
}
