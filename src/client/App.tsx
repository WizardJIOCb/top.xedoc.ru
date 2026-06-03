import {
  Activity,
  BarChart3,
  Clipboard,
  ClipboardPaste,
  Coins,
  Fingerprint,
  Gauge,
  GitBranch,
  Layers,
  LineChart,
  RefreshCw,
  Send,
  Trophy,
  WalletCards
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

import {
  defaultWindowHours,
  providerLabels,
  type Provider,
  type SortKey,
  type WindowKey,
  windowLabels
} from "../shared/schema.js";

type LeaderboardRow = {
  rank: number;
  fingerprint: string;
  fingerprintShort: string;
  displayName: string;
  team?: string;
  providers: Provider[];
  topModel?: string;
  tokens: number;
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

type LeaderboardResponse = {
  generatedAt: string;
  rows: LeaderboardRow[];
};

type Stats = {
  measurements: number;
  fingerprints: number;
  latestUpdate?: string;
  providers: Array<{ provider: Provider; count: number }>;
};

type FormState = {
  displayName: string;
  team: string;
  provider: Provider;
  period: WindowKey;
  topModel: string;
  tokens: string;
  requests: string;
  spendUsd: string;
  artifactMb: string;
  linesChanged: string;
  sessions: string;
  source: "manual" | "api" | "oauth" | "import" | "codexbar";
  proofUrl: string;
};

type RefreshOptions = {
  nextProvider?: Provider | "all";
  nextSort?: SortKey;
  nextWindow?: WindowKey;
  successStatus?: string;
};

const profileStorageKey = "top-xedoc-profile";
const providers: Provider[] = ["codex", "openai-api", "gemini", "grok", "claude", "cursor", "zed", "other"];
const windows: WindowKey[] = ["hour", "day", "week", "month", "all"];
const sorts: Array<{ key: SortKey; label: string }> = [
  { key: "tokensPerHour", label: "токены/час" },
  { key: "tokens", label: "токены" },
  { key: "spendUsd", label: "spend" },
  { key: "requests", label: "requests" },
  { key: "artifactBytes", label: "артефакты" },
  { key: "linesChanged", label: "строки" },
  { key: "sessions", label: "сессии" },
  { key: "avgTokensPerRequest", label: "токены/request" }
];

const defaultForm: FormState = {
  displayName: "",
  team: "",
  provider: "codex",
  period: "day",
  topModel: "",
  tokens: "",
  requests: "",
  spendUsd: "",
  artifactMb: "",
  linesChanged: "",
  sessions: "",
  source: "manual",
  proofUrl: ""
};

export function App() {
  const [fingerprint, setFingerprint] = useState("");
  const [windowKey, setWindowKey] = useState<WindowKey>("day");
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [sort, setSort] = useState<SortKey>("tokensPerHour");
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [quickText, setQuickText] = useState("");
  const [status, setStatus] = useState("Готово");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    createFingerprint().then(setFingerprint).catch(() => setFingerprint(""));
  }, []);

  useEffect(() => {
    const saved = loadProfile();
    if (saved) {
      setForm((current) => ({ ...current, ...saved }));
    }
  }, []);

  useEffect(() => {
    saveProfile(form);
  }, [form.displayName, form.team, form.provider, form.topModel, form.source]);

  useEffect(() => {
    void refresh();
  }, [windowKey, provider, sort]);

  const topRows = useMemo(() => leaderboard?.rows.slice(0, 12) ?? [], [leaderboard]);
  const maxTokens = Math.max(...topRows.map((row) => row.tokens), 1);
  const ownRank = leaderboard?.rows.find((row) => row.fingerprint === fingerprint);

  async function refresh(options: RefreshOptions = {}) {
    setIsLoading(true);
    try {
      const requestWindow = options.nextWindow ?? windowKey;
      const requestProvider = options.nextProvider ?? provider;
      const requestSort = options.nextSort ?? sort;
      const query = new URLSearchParams({
        window: requestWindow,
        provider: requestProvider,
        sort: requestSort,
        limit: "50"
      });
      const [leaderboardResponse, statsResponse] = await Promise.all([
        fetch(`/api/leaderboard?${query.toString()}`),
        fetch("/api/stats")
      ]);

      if (!leaderboardResponse.ok || !statsResponse.ok) {
        throw new Error("request_failed");
      }

      setLeaderboard(await leaderboardResponse.json());
      setStats(await statsResponse.json());
      setStatus(options.successStatus ?? "Обновлено");
    } catch {
      setStatus("API недоступен");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitMeasurement(form, "Снимок сохранён");
  }

  async function handleQuickMeasure() {
    if (!navigator.clipboard?.readText) {
      setStatus("Вставь снимок ниже");
      return;
    }

    setStatus("Читаю буфер");
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setStatus("Буфер пуст");
        return;
      }

      setQuickText(text);
      await saveParsedUsage(text);
    } catch {
      setStatus("Вставь снимок ниже");
    }
  }

  async function saveParsedUsage(text: string) {
    const parsed = parseUsageText(text);
    const nextForm = {
      ...form,
      ...parsed,
      displayName: form.displayName.trim() || fallbackDisplayName(fingerprint)
    };

    setForm(nextForm);

    if (!hasAnyMetric(nextForm)) {
      setStatus("Не вижу метрик");
      return;
    }

    await submitMeasurement(nextForm, "Замер сохранён");
  }

  async function submitMeasurement(nextForm: FormState, successStatus: string) {
    if (!fingerprint) {
      setStatus("Нет отпечатка");
      return;
    }

    setIsLoading(true);
    const observedTo = new Date();
    const observedFrom = new Date(
      observedTo.getTime() - defaultWindowHours[nextForm.period] * 3_600_000
    );

    const payload = {
      fingerprint,
      displayName: nextForm.displayName.trim() || fallbackDisplayName(fingerprint),
      team: nextForm.team,
      provider: nextForm.provider,
      period: nextForm.period,
      topModel: nextForm.topModel,
      observedFrom: observedFrom.toISOString(),
      observedTo: observedTo.toISOString(),
      tokens: toInteger(nextForm.tokens),
      requests: toInteger(nextForm.requests),
      spendUsd: toNumber(nextForm.spendUsd),
      artifactBytes: Math.round(toNumber(nextForm.artifactMb) * 1_048_576),
      linesChanged: toInteger(nextForm.linesChanged),
      sessions: toInteger(nextForm.sessions),
      source: nextForm.source,
      proofUrl: nextForm.proofUrl
    };

    try {
      const response = await fetch("/api/measurements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        setStatus(error?.issues?.[0]?.message ?? "Не сохранилось");
        return;
      }

      setWindowKey(nextForm.period);
      setProvider("all");
      await refresh({
        nextProvider: "all",
        nextWindow: nextForm.period,
        successStatus
      });
    } catch {
      setStatus("Сеть не ответила");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <Trophy size={24} aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow">top.xedoc.ru</p>
            <h1>AI usage rating</h1>
          </div>
        </div>
        <div className="top-actions">
          <button
            className="measure-button"
            type="button"
            onClick={handleQuickMeasure}
            disabled={isLoading}
          >
            <Gauge size={17} aria-hidden="true" />
            Замерить
          </button>
          <div className="fingerprint-pill" title="Публичный локальный отпечаток">
            <Fingerprint size={18} aria-hidden="true" />
            <span>{fingerprint ? short(fingerprint) : "создаётся"}</span>
            <button
              className="icon-button"
              type="button"
              title="Скопировать отпечаток"
              aria-label="Скопировать отпечаток"
              onClick={() => fingerprint && navigator.clipboard.writeText(fingerprint)}
            >
              <Clipboard size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <section className="metric-strip" aria-label="Сводка">
        <Metric icon={<Activity size={18} />} label="снимки" value={formatCompact(stats?.measurements ?? 0)} />
        <Metric icon={<Fingerprint size={18} />} label="отпечатки" value={formatCompact(stats?.fingerprints ?? 0)} />
        <Metric icon={<Coins size={18} />} label="твой ранг" value={ownRank ? `#${ownRank.rank}` : "-"} />
        <Metric icon={<LineChart size={18} />} label="последний апдейт" value={stats?.latestUpdate ? formatDate(stats.latestUpdate) : "-"} />
      </section>

      <section className="workbench">
        <div className="leaderboard-area">
          <div className="toolbar">
            <div className="segmented" aria-label="Период рейтинга">
              {windows.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={windowKey === item ? "active" : ""}
                  onClick={() => setWindowKey(item)}
                >
                  {windowLabels[item]}
                </button>
              ))}
            </div>
            <div className="select-row">
              <label>
                <span>провайдер</span>
                <select value={provider} onChange={(event) => setProvider(event.target.value as Provider | "all")}>
                  <option value="all">Все</option>
                  {providers.map((item) => (
                    <option key={item} value={item}>
                      {providerLabels[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>сортировка</span>
                <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                  {sorts.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="icon-text-button" type="button" onClick={() => refresh()} disabled={isLoading}>
                <RefreshCw size={16} aria-hidden="true" />
                Обновить
              </button>
            </div>
          </div>

          <div className="chart-panel" aria-label="Топ по токенам">
            {topRows.length > 0 ? (
              topRows.map((row) => (
                <div className="bar-item" key={`${row.fingerprint}-${row.rank}`}>
                  <span>{row.rank}</span>
                  <div className="bar-track">
                    <div style={{ height: `${Math.max(4, (row.tokens / maxTokens) * 100)}%` }} />
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-chart">
                <BarChart3 size={22} aria-hidden="true" />
                <span>Пока пусто</span>
              </div>
            )}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>участник</th>
                  <th>провайдеры</th>
                  <th>токены/час</th>
                  <th>токены</th>
                  <th>spend</th>
                  <th>requests</th>
                  <th>артефакты</th>
                  <th>строки</th>
                  <th>модель</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard?.rows.map((row) => (
                  <tr key={`${row.rank}-${row.fingerprint}`} className={row.fingerprint === fingerprint ? "own-row" : ""}>
                    <td>{row.rank}</td>
                    <td>
                      <strong>{row.displayName}</strong>
                      <small>{row.team || row.fingerprintShort}</small>
                    </td>
                    <td>{row.providers.map((item) => providerLabels[item]).join(", ")}</td>
                    <td>{formatCompact(row.tokensPerHour)}</td>
                    <td>{formatCompact(row.tokens)}</td>
                    <td>{formatUsd(row.spendUsd)}</td>
                    <td>{formatCompact(row.requests)}</td>
                    <td>{formatMb(row.artifactMb)}</td>
                    <td>{formatCompact(row.linesChanged)}</td>
                    <td>{row.topModel || "-"}</td>
                  </tr>
                ))}
                {leaderboard?.rows.length === 0 && (
                  <tr>
                    <td colSpan={10}>
                      <div className="empty-row">Нет снимков для выбранного периода</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="submit-panel">
          <div className="panel-heading">
            <Layers size={20} aria-hidden="true" />
            <h2>Снимок</h2>
            <span>{status}</span>
          </div>

          <div className="quick-import">
            <label>
              <span>быстрый импорт</span>
              <textarea
                value={quickText}
                onChange={(event) => setQuickText(event.target.value)}
                placeholder="30d spend $1,305,088.81 · 603B tokens · 7.6M requests · top model: gpt-5.5-2026-04-23"
              />
            </label>
            <button
              className="quick-button"
              type="button"
              onClick={() => saveParsedUsage(quickText)}
              disabled={isLoading}
            >
              <ClipboardPaste size={17} aria-hidden="true" />
              Распознать
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            <label>
              <span>имя</span>
              <input
                required
                minLength={2}
                maxLength={40}
                value={form.displayName}
                onChange={(event) => setFormValue("displayName", event.target.value)}
                placeholder="Wizard"
              />
            </label>
            <label>
              <span>команда</span>
              <input
                maxLength={40}
                value={form.team}
                onChange={(event) => setFormValue("team", event.target.value)}
                placeholder="xedoc"
              />
            </label>
            <div className="form-grid">
              <label>
                <span>провайдер</span>
                <select value={form.provider} onChange={(event) => setFormValue("provider", event.target.value as Provider)}>
                  {providers.map((item) => (
                    <option key={item} value={item}>
                      {providerLabels[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>период</span>
                <select value={form.period} onChange={(event) => setFormValue("period", event.target.value as WindowKey)}>
                  {windows.map((item) => (
                    <option key={item} value={item}>
                      {windowLabels[item]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              <span>top model</span>
              <input
                maxLength={80}
                value={form.topModel}
                onChange={(event) => setFormValue("topModel", event.target.value)}
                placeholder="gpt-5.5-2026-04-23"
              />
            </label>
            <div className="form-grid">
              <NumberField label="токены" value={form.tokens} onChange={(value) => setFormValue("tokens", value)} />
              <NumberField label="requests" value={form.requests} onChange={(value) => setFormValue("requests", value)} />
              <NumberField label="spend $" value={form.spendUsd} onChange={(value) => setFormValue("spendUsd", value)} />
              <NumberField label="artifact MB" value={form.artifactMb} onChange={(value) => setFormValue("artifactMb", value)} />
              <NumberField label="строки" value={form.linesChanged} onChange={(value) => setFormValue("linesChanged", value)} />
              <NumberField label="сессии" value={form.sessions} onChange={(value) => setFormValue("sessions", value)} />
            </div>
            <div className="form-grid">
              <label>
                <span>source</span>
                <select value={form.source} onChange={(event) => setFormValue("source", event.target.value as FormState["source"])}>
                  <option value="manual">manual</option>
                  <option value="codexbar">codexbar</option>
                  <option value="api">api</option>
                  <option value="oauth">oauth</option>
                  <option value="import">import</option>
                </select>
              </label>
              <label>
                <span>proof URL</span>
                <input
                  maxLength={500}
                  value={form.proofUrl}
                  onChange={(event) => setFormValue("proofUrl", event.target.value)}
                  placeholder="https://..."
                />
              </label>
            </div>
            <button className="submit-button" type="submit" disabled={isLoading}>
              <Send size={18} aria-hidden="true" />
              Сохранить
            </button>
          </form>
        </aside>
      </section>

      <section className="api-band" aria-label="API">
        <div>
          <GitBranch size={18} aria-hidden="true" />
          <code>POST /api/measurements</code>
        </div>
        <div>
          <WalletCards size={18} aria-hidden="true" />
          <code>tokens requests spendUsd artifactBytes linesChanged sessions topModel</code>
        </div>
      </section>
    </main>
  );

  function setFormValue<Key extends keyof FormState>(key: Key, value: FormState[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="0" />
    </label>
  );
}

async function createFingerprint() {
  const storageKey = "top-xedoc-public-fingerprint-seed";
  let seed = localStorage.getItem(storageKey);
  if (!seed) {
    seed = crypto.randomUUID();
    localStorage.setItem(storageKey, seed);
  }

  const source = `top.xedoc.ru:v1:${seed}`;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function loadProfile(): Partial<FormState> | null {
  try {
    const raw = localStorage.getItem(profileStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FormState>;
    return {
      displayName: parsed.displayName ?? "",
      team: parsed.team ?? "",
      provider: providers.includes(parsed.provider as Provider) ? parsed.provider : "codex",
      topModel: parsed.topModel ?? "",
      source: parsed.source ?? "manual"
    };
  } catch {
    return null;
  }
}

function saveProfile(form: FormState) {
  localStorage.setItem(
    profileStorageKey,
    JSON.stringify({
      displayName: form.displayName,
      team: form.team,
      provider: form.provider,
      topModel: form.topModel,
      source: form.source
    })
  );
}

function parseUsageText(text: string): Partial<FormState> {
  const normalized = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const parsed: Partial<FormState> = {
    source: lower.includes("codexbar") ? "codexbar" : "import"
  };

  const provider = detectProvider(lower);
  if (provider) parsed.provider = provider;

  const period = detectPeriod(lower);
  if (period) parsed.period = period;

  const model = findModel(normalized);
  if (model) parsed.topModel = model;

  const spend = findMoney(normalized);
  if (spend !== null) parsed.spendUsd = metricToInput(spend);

  const tokens = findMetric(normalized, ["tokens?", "токен(?:ы|ов|а)?"]);
  if (tokens !== null) parsed.tokens = metricToInput(tokens);

  const requests = findMetric(normalized, ["requests?", "req", "запрос(?:ы|ов|а)?"]);
  if (requests !== null) parsed.requests = metricToInput(requests);

  const artifacts = findMetric(normalized, ["artifact(?:s)?\\s*(?:mb|мб)?", "артефакт(?:ы|ов|а)?"]);
  if (artifacts !== null) parsed.artifactMb = metricToInput(artifacts);

  const lines = findMetric(normalized, ["lines?", "строк(?:и|а)?"]);
  if (lines !== null) parsed.linesChanged = metricToInput(lines);

  const sessions = findMetric(normalized, ["sessions?", "сесси(?:и|й|я)"]);
  if (sessions !== null) parsed.sessions = metricToInput(sessions);

  return parsed;
}

function detectProvider(value: string): Provider | null {
  if (value.includes("openai api") || value.includes("admin api")) return "openai-api";
  if (value.includes("gemini")) return "gemini";
  if (value.includes("grok") || value.includes("x.ai") || value.includes("xai")) return "grok";
  if (value.includes("claude") || value.includes("anthropic")) return "claude";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("zed") || value.includes("z.ai")) return "zed";
  if (value.includes("codex")) return "codex";
  return null;
}

function detectPeriod(value: string): WindowKey | null {
  if (/\b(?:1h|hour|час)\b/.test(value)) return "hour";
  if (/\b(?:today|24h|day|день|сутки)\b/.test(value)) return "day";
  if (/\b(?:7d|week|недел)/.test(value)) return "week";
  if (/\b(?:30d|month|месяц)\b/.test(value)) return "month";
  if (/\b(?:all|total|lifetime)\b/.test(value)) return "all";
  return null;
}

function findModel(value: string) {
  const match = value.match(/(?:top\s*model|model|модель)\s*[:=]?\s*([a-z0-9][a-z0-9._:-]{2,80})/i);
  return match?.[1];
}

function findMoney(value: string) {
  const dollar = value.match(/\$\s*([0-9][0-9\s,]*(?:\.[0-9]+)?)/i);
  if (dollar?.[1]) return parseDecimal(dollar[1]);

  const spend = value.match(/(?:spend|cost)\s*[:=]?\s*\$?\s*([0-9][0-9\s,]*(?:\.[0-9]+)?)/i);
  return spend?.[1] ? parseDecimal(spend[1]) : null;
}

function findMetric(value: string, labels: string[]) {
  const label = labels.join("|");
  const number = "([0-9][0-9\\s.,]*(?:k|m|b|t|bn|kb|mb|gb|tb|к|м|млн|млрд)?)";
  const after = new RegExp(`(?:${label})\\s*[:=]?\\s*${number}`, "i");
  const before = new RegExp(`${number}\\s*(?:${label})`, "i");
  const afterMatch = value.match(after);
  if (afterMatch?.[1]) return parseMagnitude(afterMatch[1]);

  const beforeMatch = value.match(before);
  return beforeMatch?.[1] ? parseMagnitude(beforeMatch[1]) : null;
}

function parseMagnitude(value: string) {
  const raw = value.trim().toLowerCase().replace(/\s+/g, "");
  const unitMatch = raw.match(/(млрд|млн|bn|tb|gb|mb|kb|[kmbtкм])$/i);
  const unit = unitMatch?.[1] ?? "";
  const number = parseDecimal(unit ? raw.slice(0, -unit.length) : raw);
  const multipliers: Record<string, number> = {
    k: 1_000,
    "к": 1_000,
    m: 1_000_000,
    "м": 1_000_000,
    млн: 1_000_000,
    b: 1_000_000_000,
    bn: 1_000_000_000,
    млрд: 1_000_000_000,
    t: 1_000_000_000_000,
    kb: 1 / 1024,
    mb: 1,
    gb: 1024,
    tb: 1024 * 1024
  };

  return number * (multipliers[unit] ?? 1);
}

function parseDecimal(value: string) {
  const clean = value.trim().replace(/\s+/g, "");
  if (clean.includes(".") && clean.includes(",")) {
    return Number(clean.replaceAll(",", ""));
  }

  const commaCount = (clean.match(/,/g) ?? []).length;
  if (commaCount > 1 || /\d+,\d{3}$/.test(clean)) {
    return Number(clean.replaceAll(",", ""));
  }

  if (clean.includes(",")) {
    return Number(clean.replace(",", "."));
  }

  return Number(clean.replaceAll(",", ""));
}

function hasAnyMetric(value: FormState) {
  return (
    toNumber(value.tokens) > 0 ||
    toNumber(value.requests) > 0 ||
    toNumber(value.spendUsd) > 0 ||
    toNumber(value.artifactMb) > 0 ||
    toNumber(value.linesChanged) > 0 ||
    toNumber(value.sessions) > 0
  );
}

function metricToInput(value: number) {
  return Number.isFinite(value) && value > 0 ? String(Math.round(value * 100) / 100) : "";
}

function fallbackDisplayName(fingerprint: string) {
  return fingerprint ? `anon-${fingerprint.slice(0, 6)}` : "anon";
}

function short(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function toNumber(value: string) {
  const normalized = value.replace(",", ".").trim();
  return normalized ? Number(normalized) : 0;
}

function toInteger(value: string) {
  return Math.round(toNumber(value));
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    notation: "compact",
    maximumFractionDigits: 2
  }).format(value);
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value > 1000 ? 0 : 2
  }).format(value);
}

function formatMb(value: number) {
  if (value >= 1024) {
    return `${formatCompact(value / 1024)} GB`;
  }
  return `${formatCompact(value)} MB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
