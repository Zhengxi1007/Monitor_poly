import "dotenv/config";
import crypto from "crypto";
import express, { type Request, type Response } from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import path from "path";

const app = express();
app.use(express.json());

const PORT = 3000;
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_ORDER_NOTIONAL = 1000;

const OKX_MARKET_MAP: Record<string, { instId: string; tdMode: "cross" | "isolated" }> = {
  "1345530": { instId: "BTC-USDT-SWAP", tdMode: "cross" },
};

type Monitor = {
  id: number;
  market_id: string;
  market_name: string | null;
  threshold: number;
  condition: "above" | "below";
  email: string;
  last_notified_value: number | null;
  active: number;
  created_at?: string;
  current_price: number | null;
  last_checked_at?: string | null;
  last_error: string | null;
  order_placed: number;
  order_placed_at?: string | null;
  okx_order_id?: string | null;
  okx_side?: string | null;
  okx_inst_id?: string | null;
  okx_error?: string | null;
  order_notional_usdt: number | null;
  trade_enabled: number;
  trade_direction: "long" | "short" | null;
  last_triggered_at?: string | null;
};

type MarketOption = {
  id: string;
  question: string;
  groupItemTitle?: string;
  price?: number | null;
};

type MarketById = {
  id: string;
  question: string;
  pricePct: number;
};

const db = new Database("monitor.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  market_name TEXT,
  threshold REAL NOT NULL,
  condition TEXT CHECK(condition IN ('above','below')) NOT NULL,
  email TEXT NOT NULL,
  last_notified_value REAL,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

function ensureColumn(name: string, ddl: string) {
  const columns = db.prepare("PRAGMA table_info(monitors)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE monitors ADD COLUMN ${ddl}`);
  }
}

ensureColumn("current_price", "current_price REAL");
ensureColumn("last_checked_at", "last_checked_at DATETIME");
ensureColumn("last_error", "last_error TEXT");
ensureColumn("order_placed", "order_placed INTEGER DEFAULT 0");
ensureColumn("order_placed_at", "order_placed_at DATETIME");
ensureColumn("okx_order_id", "okx_order_id TEXT");
ensureColumn("okx_side", "okx_side TEXT");
ensureColumn("okx_inst_id", "okx_inst_id TEXT");
ensureColumn("okx_error", "okx_error TEXT");
ensureColumn("order_notional_usdt", `order_notional_usdt REAL DEFAULT ${DEFAULT_ORDER_NOTIONAL}`);
ensureColumn("trade_enabled", "trade_enabled INTEGER DEFAULT 1");
ensureColumn("trade_direction", "trade_direction TEXT");
ensureColumn("last_triggered_at", "last_triggered_at DATETIME");

function parseOutcomePrice(value: unknown): number | null {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 0) return Number(value[0]);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length > 0) return Number(parsed[0]);
      return Number(value);
    } catch {
      return Number(value);
    }
  }
  return null;
}

async function jsonFetch<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return data as T;
}

async function getMarketById(marketId: string): Promise<MarketById> {
  const data = await jsonFetch<any>(`https://gamma-api.polymarket.com/markets/${marketId}`);
  const rawPrice =
    parseOutcomePrice(data.outcomePrices) ?? Number(data.lastTradePrice ?? data.last_trade_price ?? data.price ?? 0);
  if (Number.isNaN(rawPrice)) {
    throw new Error("Invalid market price");
  }
  return {
    id: String(data.id ?? marketId),
    question: String(data.question ?? marketId),
    pricePct: rawPrice * 100,
  };
}

async function resolvePolymarketUrl(url: string): Promise<{ title: string; markets: MarketOption[] }> {
  const slugMatch = url.match(/\/event\/([^/?#]+)/) || url.match(/slug=([^&#]+)/);
  if (!slugMatch) {
    throw new Error("Invalid Polymarket URL");
  }

  const slug = slugMatch[1];
  let data = await jsonFetch<any[]>(
    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`
  );
  if (!Array.isArray(data) || data.length === 0) {
    data = await jsonFetch<any[]>(
      `https://gamma-api.polymarket.com/events?search=${encodeURIComponent(slug)}`
    );
  }

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Event not found");
  }

  const event = data.find((item) => item.slug === slug) ?? data[0];
  const markets = Array.isArray(event.markets) ? event.markets : [];

  return {
    title: String(event.title ?? slug),
    markets: markets.map((market: any) => ({
      id: String(market.id ?? market.conditionId ?? ""),
      question: String(market.question ?? market.title ?? ""),
      groupItemTitle: String(market.groupItemTitle ?? market.xAxisValue ?? ""),
      price: parseOutcomePrice(market.outcomePrices),
    })),
  };
}

async function searchMarkets(query: string): Promise<MarketOption[]> {
  const markets = await jsonFetch<any[]>(
    `https://gamma-api.polymarket.com/markets?search=${encodeURIComponent(query)}&active=true&limit=20`
  );

  if (!Array.isArray(markets)) return [];

  return markets.map((market) => ({
    id: String(market.id ?? market.conditionId ?? ""),
    question: String(market.question ?? ""),
    groupItemTitle: String(market.groupItemTitle ?? market.xAxisValue ?? ""),
    price: parseOutcomePrice(market.outcomePrices),
  }));
}

async function sendEmail(to: string, subject: string, text: string) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.qq.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}

function okxSign(timestamp: string, method: string, requestPath: string, body: string) {
  return crypto
    .createHmac("sha256", process.env.OKX_API_SECRET || "")
    .update(`${timestamp}${method}${requestPath}${body}`)
    .digest("base64");
}

async function okxPublicGet<T = any>(pathname: string, query = ""): Promise<T> {
  return jsonFetch<T>(`https://www.okx.com${pathname}${query}`, {
    headers: {
      Accept: "application/json",
      "x-simulated-trading": "1",
    },
  });
}

async function okxPrivatePost<T = any>(pathname: string, payload: Record<string, unknown>): Promise<T> {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  return jsonFetch<T>(`https://www.okx.com${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": process.env.OKX_API_KEY || "",
      "OK-ACCESS-SIGN": okxSign(timestamp, "POST", pathname, body),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE || "",
      "x-simulated-trading": "1",
    },
    body,
  });
}

function getTradePlan(monitor: Monitor) {
  if (!monitor.trade_enabled || !monitor.trade_direction) return null;
  const mapping = OKX_MARKET_MAP[monitor.market_id];
  if (!mapping) return null;

  return {
    instId: mapping.instId,
    tdMode: mapping.tdMode,
    side: monitor.trade_direction === "short" ? "sell" : "buy",
    posSide: monitor.trade_direction === "short" ? "short" : "long",
    notional: monitor.order_notional_usdt || DEFAULT_ORDER_NOTIONAL,
  };
}

async function placeDemoOrder(monitor: Monitor) {
  const plan = getTradePlan(monitor);
  if (!plan) return null;

  const [tickerRes, instRes] = await Promise.all([
    okxPublicGet<any>("/api/v5/market/ticker", `?instId=${encodeURIComponent(plan.instId)}`),
    okxPublicGet<any>(
      "/api/v5/public/instruments",
      `?instType=SWAP&instId=${encodeURIComponent(plan.instId)}`
    ),
  ]);

  const ticker = tickerRes?.data?.[0];
  const inst = instRes?.data?.[0];
  const last = Number(ticker?.last || 0);
  const ctVal = Number(inst?.ctVal || 0);
  const lotSz = Number(inst?.lotSz || inst?.minSz || 1);
  const minSz = Number(inst?.minSz || lotSz);

  if (!last || !ctVal) {
    throw new Error("Failed to get OKX contract metadata");
  }

  const rawSize = plan.notional / (last * ctVal);
  const steppedSize = Math.floor(rawSize / lotSz) * lotSz;
  const finalSize = Math.max(steppedSize, minSz);
  const decimals = Math.max(0, (String(lotSz).split(".")[1] || "").length);
  const sz = finalSize.toFixed(decimals);

  const result = await okxPrivatePost<any>("/api/v5/trade/order", {
    instId: plan.instId,
    tdMode: plan.tdMode,
    side: plan.side,
    posSide: plan.posSide,
    ordType: "market",
    sz,
    clOrdId: `poly${Date.now()}`,
  });

  if (result.code !== "0" || result.data?.[0]?.sCode !== "0") {
    throw new Error(result.msg || result.data?.[0]?.sMsg || "OKX order failed");
  }

  return {
    ordId: String(result.data[0].ordId),
    instId: plan.instId,
    side: plan.side,
    sz,
  };
}

async function checkMonitors() {
  const monitors = db
    .prepare("SELECT * FROM monitors WHERE active = 1 ORDER BY created_at DESC")
    .all() as Monitor[];

  for (const monitor of monitors) {
    try {
      const market = await getMarketById(monitor.market_id);

      db.prepare(
        "UPDATE monitors SET current_price=?, market_name=?, last_checked_at=CURRENT_TIMESTAMP, last_error=NULL WHERE id=?"
      ).run(market.pricePct, market.question, monitor.id);

      const triggered =
        (monitor.condition === "above" && market.pricePct >= monitor.threshold) ||
        (monitor.condition === "below" && market.pricePct <= monitor.threshold);

      if (!triggered) continue;

      db.prepare("UPDATE monitors SET last_triggered_at=CURRENT_TIMESTAMP WHERE id=?").run(monitor.id);

      let tradeSummary = "未执行自动下单";

      if (!monitor.order_placed) {
        try {
          const order = await placeDemoOrder(monitor);
          if (order) {
            db.prepare(
              "UPDATE monitors SET order_placed=1, order_placed_at=CURRENT_TIMESTAMP, okx_order_id=?, okx_side=?, okx_inst_id=?, okx_error=NULL WHERE id=?"
            ).run(order.ordId, order.side, order.instId, monitor.id);
            tradeSummary = `已在 OKX Demo 下单: ${order.instId} ${order.side} ${order.sz} 张, 订单号 ${order.ordId}`;
          } else {
            tradeSummary = "未开启自动交易，或该 market_id 暂未映射 OKX 合约";
          }
        } catch (error: any) {
          tradeSummary = `OKX 下单失败: ${error.message}`;
          db.prepare("UPDATE monitors SET okx_error=?, last_error=? WHERE id=?").run(
            error.message,
            error.message,
            monitor.id
          );
        }
      } else {
        tradeSummary = "该监控已下过单，本次未重复下单";
      }

      const shouldNotify =
        monitor.last_notified_value === null ||
        Math.abs(market.pricePct - monitor.last_notified_value) > 0.5;

      if (!shouldNotify) continue;

      await sendEmail(
        monitor.email,
        `Polymarket Alert: ${market.question}`,
        `市场: ${market.question}\nMarket ID: ${monitor.market_id}\n当前概率: ${market.pricePct.toFixed(
          2
        )}%\n触发条件: ${monitor.condition} ${monitor.threshold}%\n交易方向: ${
          monitor.trade_direction || "未设置"
        }\n下单金额: ${monitor.order_notional_usdt || DEFAULT_ORDER_NOTIONAL} USDT\n${tradeSummary}`
      );

      db.prepare("UPDATE monitors SET last_notified_value=? WHERE id=?").run(market.pricePct, monitor.id);
    } catch (error: any) {
      db.prepare("UPDATE monitors SET last_error=?, last_checked_at=CURRENT_TIMESTAMP WHERE id=?").run(
        error.message,
        monitor.id
      );
    }
  }
}

app.get("/api/status", (_req: Request, res: Response) => {
  res.json({
    database: "Connected",
    smtpHost: process.env.SMTP_HOST || "smtp.qq.com",
    smtpUser: process.env.SMTP_USER || "",
    emailFrom: process.env.EMAIL_FROM || process.env.SMTP_USER || "",
    checkInterval: "Every 2m",
    okxDemoConfigured: Boolean(
      process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE
    ),
    okxMapping: OKX_MARKET_MAP,
  });
});

app.get("/api/monitors", (_req: Request, res: Response) => {
  res.json(db.prepare("SELECT * FROM monitors ORDER BY created_at DESC").all());
});

app.get("/api/search", async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ error: "Query required" });
    }
    res.json({ markets: await searchMarkets(q) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/resolve", async (req: Request, res: Response) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) {
      return res.status(400).json({ error: "URL required" });
    }
    res.json(await resolvePolymarketUrl(url));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/market/:id", async (req: Request, res: Response) => {
  try {
    const market = await getMarketById(req.params.id);
    res.json({
      markets: [
        {
          id: req.params.id,
          question: market.question,
          groupItemTitle: "Direct ID Match",
        },
      ],
    });
  } catch {
    res.status(404).json({ error: "Market not found" });
  }
});

app.post("/api/monitors", async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const marketId = String(body.market_id || "").trim();
    const threshold = Number(body.threshold);
    const condition = String(body.condition || "").trim();
    const email = String(body.email || "").trim();

    if (!marketId || Number.isNaN(threshold) || !condition || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const market = await getMarketById(marketId);
    const result = db
      .prepare(
        `INSERT INTO monitors (
          market_id, market_name, threshold, condition, email,
          trade_direction, trade_enabled, order_notional_usdt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        marketId,
        market.question,
        threshold,
        condition,
        email,
        body.trade_direction === "short" ? "short" : "long",
        body.trade_enabled === false ? 0 : 1,
        Number(body.order_notional_usdt || DEFAULT_ORDER_NOTIONAL)
      );

    res.json({ id: result.lastInsertRowid, market_name: market.question });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/monitors/:id", (req: Request, res: Response) => {
  db.prepare("DELETE FROM monitors WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/monitors/:id/toggle", (req: Request, res: Response) => {
  db.prepare("UPDATE monitors SET active = 1 - active WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/check-now", async (_req: Request, res: Response) => {
  try {
    await checkMonitors();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/test-email", async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    if (!body.email) {
      return res.status(400).json({ error: "Email required" });
    }
    await sendEmail(
      String(body.email),
      String(body.subject || "Polymarket Monitor Test"),
      String(body.text || "Test email")
    );
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/test-order", async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const fakeMonitor: Monitor = {
      id: 0,
      market_id: String(body.market_id || "1345530"),
      market_name: null,
      threshold: 0,
      condition: "above",
      email: "",
      last_notified_value: null,
      active: 1,
      current_price: null,
      last_error: null,
      order_placed: 0,
      order_notional_usdt: Number(body.notionalUsdt || DEFAULT_ORDER_NOTIONAL),
      trade_enabled: 1,
      trade_direction: body.tradeDirection === "short" ? "short" : "long",
    };

    const order = await placeDemoOrder(fakeMonitor);
    res.json({ success: true, order });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req: Request, res: Response) => {
      if (!req.path.startsWith("/api/")) {
        res.sendFile(path.resolve("dist/index.html"));
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  checkMonitors().catch(() => undefined);
  setInterval(() => {
    checkMonitors().catch(() => undefined);
  }, CHECK_INTERVAL_MS);
}

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
