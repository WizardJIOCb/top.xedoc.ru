import {
  Activity,
  BarChart3,
  Clipboard,
  Coins,
  Fingerprint,
  Gauge,
  GitBranch,
  Layers,
  LineChart,
  RefreshCw,
  Trophy,
  WalletCards
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
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
  tokensPerHour: number;
  requestsPerHour: number;
  avgTokensPerRequest: number;
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
};

type ProfileState = {
  displayName: string;
  team: string;
  period: WindowKey;
  proofUrl: string;
};

type ConnectorKind = "openai-admin" | "gemini-monitoring";

type ConnectorFormState = {
  connector: ConnectorKind;
  adminApiKey: string;
  googleProjectId: string;
  googleAccessToken: string;
};

type SnippetProvider = "openai" | "xai" | "gemini";

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
  { key: "requests", label: "requests" }
];

const defaultProfile: ProfileState = {
  displayName: "",
  team: "",
  period: "day",
  proofUrl: ""
};

const defaultConnectorForm: ConnectorFormState = {
  connector: "openai-admin",
  adminApiKey: "",
  googleProjectId: "",
  googleAccessToken: ""
};

export function App() {
  const [fingerprint, setFingerprint] = useState("");
  const [windowKey, setWindowKey] = useState<WindowKey>("day");
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [sort, setSort] = useState<SortKey>("tokensPerHour");
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [profile, setProfile] = useState<ProfileState>(defaultProfile);
  const [connectorForm, setConnectorForm] = useState<ConnectorFormState>(defaultConnectorForm);
  const [snippetProvider, setSnippetProvider] = useState<SnippetProvider>("openai");
  const [status, setStatus] = useState("Готово");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    createFingerprint().then(setFingerprint).catch(() => setFingerprint(""));
  }, []);

  useEffect(() => {
    const saved = loadProfile();
    if (saved) setProfile((current) => ({ ...current, ...saved }));
  }, []);

  useEffect(() => {
    saveProfile(profile);
  }, [profile.displayName, profile.team, profile.period]);

  useEffect(() => {
    void refresh();
  }, [windowKey, provider, sort]);

  const topRows = useMemo(() => leaderboard?.rows.slice(0, 12) ?? [], [leaderboard]);
  const maxTokens = Math.max(...topRows.map((row) => row.tokens), 1);
  const ownRank = leaderboard?.rows.find((row) => row.fingerprint === fingerprint);
  const displayName = profile.displayName.trim() || fallbackDisplayName(fingerprint);
  const snippets = useMemo(
    () => buildSnippets({ fingerprint, displayName, team: profile.team }),
    [displayName, fingerprint, profile.team]
  );

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

      if (!leaderboardResponse.ok || !statsResponse.ok) throw new Error("request_failed");

      setLeaderboard(await leaderboardResponse.json());
      setStats(await statsResponse.json());
      setStatus(options.successStatus ?? "Обновлено");
    } catch {
      setStatus("API недоступен");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConnectorMeasure() {
    if (!fingerprint) {
      setStatus("Нет отпечатка");
      return;
    }

    const basePayload = {
      fingerprint,
      displayName,
      team: profile.team,
      period: profile.period,
      proofUrl: profile.proofUrl
    };
    const payload =
      connectorForm.connector === "openai-admin"
        ? {
            ...basePayload,
            connector: "openai-admin",
            adminApiKey: connectorForm.adminApiKey
          }
        : {
            ...basePayload,
            connector: "gemini-monitoring",
            googleProjectId: connectorForm.googleProjectId,
            googleAccessToken: connectorForm.googleAccessToken
          };

    setIsLoading(true);
    setStatus("Меряю");
    try {
      const response = await fetch("/api/connectors/measure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        setStatus(error?.message ?? "Коннектор не ответил");
        return;
      }

      const result = await response.json();
      const measurement = result.measurement as { period: WindowKey };
      setWindowKey(measurement.period);
      setProvider("all");
      await refresh({
        nextProvider: "all",
        nextWindow: measurement.period,
        successStatus: result.warnings?.[0] ? "Замер сохранён с пометкой" : "Замер сохранён"
      });
    } catch {
      setStatus("Сеть не ответила");
    } finally {
      setIsLoading(false);
    }
  }

  async function copySnippet() {
    await navigator.clipboard.writeText(snippets[snippetProvider]);
    setStatus("Snippet скопирован");
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
                  <th>токены/request</th>
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
                    <td>{formatCompact(row.avgTokensPerRequest)}</td>
                    <td>{row.topModel || "-"}</td>
                  </tr>
                ))}
                {leaderboard?.rows.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <div className="empty-row">Нет достоверных замеров для выбранного периода</div>
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
            <h2>Замер</h2>
            <span>{status}</span>
          </div>

          <div className="profile-panel">
            <label>
              <span>имя</span>
              <input
                required
                minLength={2}
                maxLength={40}
                value={profile.displayName}
                onChange={(event) => setProfileValue("displayName", event.target.value)}
                placeholder="Wizard"
              />
            </label>
            <label>
              <span>команда</span>
              <input
                maxLength={40}
                value={profile.team}
                onChange={(event) => setProfileValue("team", event.target.value)}
                placeholder="xedoc"
              />
            </label>
            <div className="form-grid">
              <label>
                <span>период</span>
                <select value={profile.period} onChange={(event) => setProfileValue("period", event.target.value as WindowKey)}>
                  {windows.map((item) => (
                    <option key={item} value={item}>
                      {windowLabels[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>proof URL</span>
                <input
                  maxLength={500}
                  value={profile.proofUrl}
                  onChange={(event) => setProfileValue("proofUrl", event.target.value)}
                  placeholder="https://..."
                />
              </label>
            </div>
          </div>

          <div className="connector-panel">
            <div className="connector-heading">
              <Gauge size={18} aria-hidden="true" />
              <h3>Агрегатный замер</h3>
            </div>
            <div className="connector-tabs" aria-label="Коннектор">
              <button
                type="button"
                className={connectorForm.connector === "openai-admin" ? "active" : ""}
                onClick={() => setConnectorValue("connector", "openai-admin")}
              >
                OpenAI
              </button>
              <button
                type="button"
                className={connectorForm.connector === "gemini-monitoring" ? "active" : ""}
                onClick={() => setConnectorValue("connector", "gemini-monitoring")}
              >
                Gemini
              </button>
            </div>

            {connectorForm.connector === "openai-admin" && (
              <label>
                <span>OpenAI Admin API key</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={connectorForm.adminApiKey}
                  onChange={(event) => setConnectorValue("adminApiKey", event.target.value)}
                  placeholder="sk-admin-..."
                />
              </label>
            )}

            {connectorForm.connector === "gemini-monitoring" && (
              <>
                <label>
                  <span>Google project id</span>
                  <input
                    autoComplete="off"
                    value={connectorForm.googleProjectId}
                    onChange={(event) => setConnectorValue("googleProjectId", event.target.value)}
                    placeholder="my-gemini-project"
                  />
                </label>
                <label>
                  <span>OAuth access token</span>
                  <textarea
                    className="secret-textarea"
                    autoComplete="off"
                    value={connectorForm.googleAccessToken}
                    onChange={(event) => setConnectorValue("googleAccessToken", event.target.value)}
                    placeholder="ya29..."
                  />
                </label>
              </>
            )}

            <button
              className="measure-submit-button"
              type="button"
              onClick={handleConnectorMeasure}
              disabled={isLoading}
            >
              <Gauge size={17} aria-hidden="true" />
              Запросить usage
            </button>
          </div>
        </aside>
      </section>

      <section className="snippets-section" aria-label="SDK snippets">
        <div className="snippet-toolbar">
          <div>
            <p className="eyebrow">SDK snippets</p>
            <h2>Автозамер после API-вызова</h2>
          </div>
          <div className="snippet-tabs" aria-label="SDK provider">
            <button
              type="button"
              className={snippetProvider === "openai" ? "active" : ""}
              onClick={() => setSnippetProvider("openai")}
            >
              OpenAI
            </button>
            <button
              type="button"
              className={snippetProvider === "xai" ? "active" : ""}
              onClick={() => setSnippetProvider("xai")}
            >
              xAI
            </button>
            <button
              type="button"
              className={snippetProvider === "gemini" ? "active" : ""}
              onClick={() => setSnippetProvider("gemini")}
            >
              Gemini
            </button>
          </div>
          <button className="icon-text-button" type="button" onClick={copySnippet}>
            <Clipboard size={16} aria-hidden="true" />
            Copy
          </button>
        </div>
        <pre className="snippet-code">
          <code>{snippets[snippetProvider]}</code>
        </pre>
      </section>

      <section className="api-band" aria-label="API">
        <div>
          <GitBranch size={18} aria-hidden="true" />
          <code>POST /api/sdk/usage</code>
        </div>
        <div>
          <WalletCards size={18} aria-hidden="true" />
          <code>provider model usage fingerprint displayName</code>
        </div>
      </section>
    </main>
  );

  function setProfileValue<Key extends keyof ProfileState>(key: Key, value: ProfileState[Key]) {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  function setConnectorValue<Key extends keyof ConnectorFormState>(
    key: Key,
    value: ConnectorFormState[Key]
  ) {
    setConnectorForm((current) => ({ ...current, [key]: value }));
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

function loadProfile(): Partial<ProfileState> | null {
  try {
    const raw = localStorage.getItem(profileStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProfileState>;
    return {
      displayName: parsed.displayName ?? "",
      team: parsed.team ?? "",
      period: windows.includes(parsed.period as WindowKey) ? parsed.period : "day"
    };
  } catch {
    return null;
  }
}

function saveProfile(profile: ProfileState) {
  localStorage.setItem(
    profileStorageKey,
    JSON.stringify({
      displayName: profile.displayName,
      team: profile.team,
      period: profile.period
    })
  );
}

function buildSnippets({
  fingerprint,
  displayName,
  team
}: {
  fingerprint: string;
  displayName: string;
  team: string;
}): Record<SnippetProvider, string> {
  const endpoint = "https://top.xedoc.ru/api/sdk/usage";
  const identity = `fingerprint: ${JSON.stringify(fingerprint || "PASTE_FINGERPRINT")},\n    displayName: ${JSON.stringify(displayName)},\n    team: ${JSON.stringify(team)}`;

  return {
    openai: `import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function reportTopXedoc(response) {
  if (!response.usage) return;
  await fetch(${JSON.stringify(endpoint)}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ${identity},
      provider: "openai",
      model: response.model,
      usage: response.usage
    })
  });
}

const response = await openai.chat.completions.create({
  model: "gpt-4.1-mini",
  messages: [{ role: "user", content: "Hello" }]
});
await reportTopXedoc(response);`,
    xai: `import OpenAI from "openai";

const xai = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1"
});

async function reportTopXedoc(response) {
  if (!response.usage) return;
  await fetch(${JSON.stringify(endpoint)}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ${identity},
      provider: "xai",
      model: response.model,
      usage: response.usage
    })
  });
}

const response = await xai.chat.completions.create({
  model: "grok-4.3",
  messages: [{ role: "user", content: "Hello" }]
});
await reportTopXedoc(response);`,
    gemini: `import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function reportTopXedoc(response) {
  if (!response.usageMetadata) return;
  await fetch(${JSON.stringify(endpoint)}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ${identity},
      provider: "gemini",
      model: response.modelVersion,
      usage: response.usageMetadata
    })
  });
}

const response = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: "Hello"
});
await reportTopXedoc(response);`
  };
}

function fallbackDisplayName(fingerprint: string) {
  return fingerprint ? `anon-${fingerprint.slice(0, 6)}` : "anon";
}

function short(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
