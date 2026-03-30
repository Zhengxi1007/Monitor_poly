import "dotenv/config";
import crypto from "crypto";
import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import path from "path";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const db = new Database("monitor.db");
const DEFAULT_NOTIONAL = 1000;
const MARKET_MAP: Record<string, { instId: string; tdMode: "cross" | "isolated" }> = {
  "1345530": { instId: "BTC-USDT-SWAP", tdMode: "cross" },
};

db.exec(`
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  market_name TEXT,
  threshold REAL NOT NULL,
  condition TEXT NOT NULL,
  email TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_price REAL,
  last_checked_at DATETIME,
  last_error TEXT,
  last_notified_value REAL,
  order_placed INTEGER DEFAULT 0,
  order_placed_at DATETIME,
  okx_order_id TEXT,
  okx_side TEXT,
  okx_inst_id TEXT,
  okx_error TEXT,
  order_notional_usdt REAL DEFAULT 1000,
  last_triggered_at DATETIME,
  trade_enabled INTEGER DEFAULT 1,
  trade_direction TEXT
)
`);

type Monitor = {
  id: number;
  market_id: string;
  market_name: string | null;
  threshold: number;
  condition: "above" | "below";
  email: string;
  active: number;
  current_price: number | null;
  last_error: string | null;
  last_notified_value: number | null;
  order_placed: number;
  order_notional_usdt: number | null;
  trade_enabled: number;
  trade_direction: "long" | "short" | null;
};

async function j(url: string, init?: any) {
  const r = await fetch(url, init);
  const t = await r.text();
  const d = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return d;
}

function firstPrice(v: any) {
  if (!v) return null;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p[0] : v;
    } catch {
      return v;
    }
  }
  return Array.isArray(v) ? v[0] : null;
}

async function marketPrice(marketId: string) {
  const d = await j(`https://gamma-api.polymarket.com/markets/${marketId}`);
  const raw = firstPrice(d.outcomePrices) ?? d.lastTradePrice ?? d.price;
  const p = Number(raw);
  if (Number.isNaN(p)) throw new Error("Invalid market price");
  return { name: d.question || marketId, pricePct: p * 100 };
}

async function sendMail(to: string, subject: string, text: string) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.qq.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}

function sign(ts: string, method: string, pathName: string, body = "") {
  return crypto
    .createHmac("sha256", process.env.OKX_API_SECRET || "")
    .update(`${ts}${method}${pathName}${body}`)
    .digest("base64");
}

async function okxGet(pathName: string, query = "") {
  return j(`https://www.okx.com${pathName}${query}`, {
    headers: { Accept: "application/json", "x-simulated-trading": "1" },
  });
}

async function okxPost(pathName: string, bodyObj: any) {
  const body = JSON.stringify(bodyObj);
  const ts = new Date().toISOString();
  return j(`https://www.okx.com${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": process.env.OKX_API_KEY || "",
      "OK-ACCESS-SIGN": sign(ts, "POST", pathName, body),
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE || "",
      "x-simulated-trading": "1",
    },
    body,
  });
}

async function placeDemoOrder(m: Monitor) {
  if (!m.trade_enabled || !m.trade_direction) return null;
  const map = MARKET_MAP[m.market_id];
  if (!map) return null;
  const [tickerRes, instRes] = await Promise.all([
    okxGet("/api/v5/market/ticker", `?instId=${encodeURIComponent(map.instId)}`),
    okxGet("/api/v5/public/instruments", `?instType=SWAP&instId=${encodeURIComponent(map.instId)}`),
  ]);
  const ticker = tickerRes.data?.[0];
  const inst = instRes.data?.[0];
  const last = Number(ticker?.last);
  const ctVal = Number(inst?.ctVal);
  const lotSz = Number(inst?.lotSz || inst?.minSz || 1);
  const minSz = Number(inst?.minSz || lotSz);
  const notional = m.order_notional_usdt || DEFAULT_NOTIONAL;
  const raw = notional / (last * ctVal);
  const sz = Math.max(Math.floor(raw / lotSz) * lotSz, minSz).toFixed(2);
  const side = m.trade_direction === "short" ? "sell" : "buy";
  const posSide = m.trade_direction === "short" ? "short" : "long";
  const payload = await okxPost("/api/v5/trade/order", {
    instId: map.instId,
    tdMode: map.tdMode,
    side,
    posSide,
    ordType: "market",
    sz,
    clOrdId: `poly${Date.now()}`,
  });
  if (payload.code !== "0" || payload.data?.[0]?.sCode !== "0") {
    throw new Error(payload.msg || payload.data?.[0]?.sMsg || "OKX order failed");
  }
  return { ordId: payload.data[0].ordId, side, instId: map.instId, sz };
}

async function checkMonitors() {
  const monitors = db.prepare("SELECT * FROM monitors WHERE active = 1 ORDER BY created_at DESC").all() as Monitor[];
  for (const m of monitors) {
    try {
      const market = await marketPrice(m.market_id);
      db.prepare("UPDATE monitors SET current_price=?,last_checked_at=CURRENT_TIMESTAMP,market_name=?,last_error=NULL WHERE id=?")
        .run(market.pricePct, market.name, m.id);
      const hit = m.condition === "above" ? market.pricePct >= m.threshold : market.pricePct <= m.threshold;
      if (!hit) continue;
      db.prepare("UPDATE monitors SET last_triggered_at=CURRENT_TIMESTAMP WHERE id=?").run(m.id);
      let orderText = "未执行自动下单";
      if (!m.order_placed) {
        try {
          const order = await placeDemoOrder(m);
          if (order) {
            db.prepare("UPDATE monitors SET order_placed=1,order_placed_at=CURRENT_TIMESTAMP,okx_order_id=?,okx_side=?,okx_inst_id=?,okx_error=NULL WHERE id=?")
              .run(order.ordId, order.side, order.instId, m.id);
            orderText = `已下模拟盘单: ${order.instId} ${order.side} ${order.sz} 张, 订单号 ${order.ordId}`;
          }
        } catch (e: any) {
          orderText = `下单失败: ${e.message}`;
          db.prepare("UPDATE monitors SET okx_error=?,last_error=? WHERE id=?").run(e.message, e.message, m.id);
        }
      } else {
        orderText = "该监控已下过单，本次未重复下单";
      }
      const shouldMail = m.last_notified_value === null || Math.abs(market.pricePct - m.last_notified_value) > 0.5;
      if (shouldMail) {
        await sendMail(
          m.email,
          `Polymarket Alert: ${market.name}`,
          `市场: ${market.name}\nMarket ID: ${m.market_id}\n当前概率: ${market.pricePct.toFixed(2)}%\n触发条件: ${m.condition} ${m.threshold}%\n交易方向: ${m.trade_direction || "未设置"}\n下单金额: ${m.order_notional_usdt || DEFAULT_NOTIONAL} USDT\n${orderText}`
        );
        db.prepare("UPDATE monitors SET last_notified_value=? WHERE id=?").run(market.pricePct, m.id);
      }
    } catch (e: any) {
      db.prepare("UPDATE monitors SET last_error=?,last_checked_at=CURRENT_TIMESTAMP WHERE id=?").run(e.message, m.id);
    }
  }
}

app.get("/api/status", (_req, res) => {
  res.json({
    database: "Connected",
    smtpHost: process.env.SMTP_HOST || "smtp.qq.com",
    smtpUser: process.env.SMTP_USER || "",
    emailFrom: process.env.EMAIL_FROM || process.env.SMTP_USER || "",
    checkInterval: "Every 2m",
    okxDemoConfigured: Boolean(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE),
    okxMapping: MARKET_MAP,
  });
});

app.get("/api/monitors", (_req, res) => {
  res.json(db.prepare("SELECT * FROM monitors ORDER BY created_at DESC").all());
});

app.post("/api/monitors", async (req, res) => {
  const { market_id, threshold, condition, email, trade_direction, trade_enabled, order_notional_usdt } = req.body || {};
  if (!market_id || threshold === undefined || !condition || !email) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const market = await marketPrice(String(market_id));
  const r = db.prepare(`
    INSERT INTO monitors (market_id,market_name,threshold,condition,email,trade_direction,trade_enabled,order_notional_usdt)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    String(market_id),
    market.name,
    Number(threshold),
    condition,
    String(email),
    trade_direction === "short" ? "short" : "long",
    trade_enabled === false ? 0 : 1,
    Number(order_notional_usdt || DEFAULT_NOTIONAL)
  );
  res.json({ id: r.lastInsertRowid, market_name: market.name });
});

app.delete("/api/monitors/:id", (req, res) => {
  db.prepare("DELETE FROM monitors WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/monitors/:id/toggle", (req, res) => {
  db.prepare("UPDATE monitors SET active=1-active WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/check-now", async (_req, res) => {
  await checkMonitors();
  res.json({ success: true });
});

app.post("/api/test-order", async (req, res) => {
  const fake: Monitor = {
    id: 0,
    market_id: String(req.body?.market_id || "1345530"),
    market_name: null,
    threshold: 0,
    condition: "above",
    email: "",
    active: 1,
    current_price: null,
    last_error: null,
    last_notified_value: null,
    order_placed: 0,
    order_notional_usdt: Number(req.body?.notionalUsdt || DEFAULT_NOTIONAL),
    trade_enabled: 1,
    trade_direction: req.body?.tradeDirection === "short" ? "short" : "long",
  };
  const order = await placeDemoOrder(fake);
  res.json({ success: true, order });
});

async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    app.get("*", (req, res) => {
      if (!req.path.startsWith("/api/")) res.sendFile(path.resolve("dist/index.html"));
    });
  }
  app.listen(3000, "0.0.0.0");
  checkMonitors().catch(() => undefined);
  setInterval(() => checkMonitors().catch(() => undefined), 120000);
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
