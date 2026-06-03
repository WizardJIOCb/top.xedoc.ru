import {
  Activity,
  BarChart3,
  Clipboard,
  Coins,
  Fingerprint,
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
  const [status, setStatus] = useState("Готово");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    createFingerprint().then(setFingerprint).catch(() => setFingerprint(""));
  }, []);

  useEffect(() => {
    void refresh();
  }, [windowKey, provider, sort]);

  const topRows = useMemo(() => leaderboard?.rows.slice(0, 12) ?? [], [leaderboard]);
  const maxTokens = Math.max(...topRows.map((row) => row.tokens), 1);
  const ownRank = leaderboard?.rows.find((row) => row.fingerprint === fingerprint);

  async function refresh() {
    setIsLoading(true);
    try {
      const query = new URLSearchParams({
        window: windowKey,
        provider,
        sort,
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
      setStatus("Обновлено");
    } catch {
      setStatus("API недоступен");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fingerprint) {
      setStatus("Нет отпечатка");
      return;
    }

    setIsLoading(true);
    const observedTo = new Date();
    const observedFrom = new Date(observedTo.getTime() - defaultWindowHours[form.period] * 3_600_000);

    const payload = {
      fingerprint,
      displayName: form.displayName,
      team: form.team,
      provider: form.provider,
      period: form.period,
      topModel: form.topModel,
      observedFrom: observedFrom.toISOString(),
      observedTo: observedTo.toISOString(),
      tokens: toInteger(form.tokens),
      requests: toInteger(form.requests),
      spendUsd: toNumber(form.spendUsd),
      artifactBytes: Math.round(toNumber(form.artifactMb) * 1_048_576),
      linesChanged: toInteger(form.linesChanged),
      sessions: toInteger(form.sessions),
      source: form.source,
      proofUrl: form.proofUrl
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

      setStatus("Снимок сохранён");
      setWindowKey(form.period);
      setProvider("all");
      await refresh();
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
              <button className="icon-text-button" type="button" onClick={refresh} disabled={isLoading}>
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
