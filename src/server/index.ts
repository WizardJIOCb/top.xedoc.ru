import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";

import {
  fingerprintParamSchema,
  leaderboardQuerySchema,
  measurementInputSchema
} from "../shared/schema.js";
import {
  ConnectorPublicError,
  connectorMeasureSchema,
  measureConnector
} from "./connectors.js";
import {
  appendMeasurement,
  buildLeaderboard,
  ensureStore,
  getDataFilePath,
  getProfile,
  getStats
} from "./store.js";

const app = express();
const port = Number(process.env.PORT ?? 4177);
const host = process.env.HOST ?? "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = process.env.CLIENT_DIST
  ? path.resolve(process.env.CLIENT_DIST)
  : path.resolve(__dirname, "../client");

const postRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20
});
const connectorRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 8
});

app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "32kb" }));
app.use(securityHeaders);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, dataFile: getDataFilePath() });
});

app.get("/api/stats", asyncHandler(async (_req, res) => {
  res.json(await getStats());
}));

app.get("/api/leaderboard", asyncHandler(async (req, res) => {
  const query = parseWithSchema(leaderboardQuerySchema, req.query);
  res.json(await buildLeaderboard(query));
}));

app.get("/api/profile/:fingerprint", asyncHandler(async (req, res) => {
  const params = parseWithSchema(fingerprintParamSchema, req.params);
  res.json(await getProfile(params.fingerprint));
}));

app.post("/api/measurements", postRateLimit, asyncHandler(async (req, res) => {
  const input = parseWithSchema(measurementInputSchema, req.body);
  const record = await appendMeasurement(input);
  res.status(201).json({ ok: true, measurement: record });
}));

app.post("/api/connectors/measure", connectorRateLimit, asyncHandler(async (req, res) => {
  const input = parseWithSchema(connectorMeasureSchema, req.body);
  const result = await measureConnector(input);
  res.status(201).json({ ok: true, ...result });
}));

app.use(express.static(clientDist, {
  extensions: ["html"],
  maxAge: "1h"
}));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    next();
    return;
  }
  res.sendFile(path.join(clientDist, "index.html"));
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "validation_failed",
      issues: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
    return;
  }

  if (err instanceof ConnectorPublicError) {
    res.status(err.status).json({
      error: err.code,
      message: err.message
    });
    return;
  }

  res.status(500).json({ error: "internal_error" });
});

await ensureStore();

app.listen(port, host, () => {
  console.info(`top.xedoc.ru listening on http://${host}:${port}`);
});

function parseWithSchema<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  return schema.parse(value);
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
}

function createRateLimiter({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const current = hits.get(key);

    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (current.count >= max) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    current.count += 1;
    next();
  };
}
