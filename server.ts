import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";
import path from "path";

// Initialize database with more robust error handling
let db: any;
try {
  db = new Database("monitor.db");
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  console.log("Database connected successfully.");
} catch (err) {
  console.error("Failed to connect to database:", err);
  process.exit(1);
}

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    market_name TEXT,
    threshold REAL NOT NULL,
    condition TEXT CHECK(condition IN ('above', 'below')) NOT NULL,
    email TEXT NOT NULL,
    last_notified_value REAL,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migration: Add new columns if they don't exist
const columns = db.prepare("PRAGMA table_info(monitors)").all() as any[];
const columnNames = columns.map(c => c.name);

if (!columnNames.includes('current_price')) {
  db.exec("ALTER TABLE monitors ADD COLUMN current_price REAL");
}
if (!columnNames.includes('last_checked_at')) {
  db.exec("ALTER TABLE monitors ADD COLUMN last_checked_at DATETIME");
}
if (!columnNames.includes('last_error')) {
  db.exec("ALTER TABLE monitors ADD COLUMN last_error TEXT");
}

const app = express();
app.use(express.json());

// Polymarket API helpers
function getFirstPrice(outcomePrices: any): string | null {
  if (!outcomePrices) return null;
  let prices = outcomePrices;
  if (typeof prices === 'string') {
    try {
      prices = JSON.parse(prices);
    } catch (e) {
      // ignore
    }
  }
  if (Array.isArray(prices) && prices.length > 0) {
    return prices[0];
  }
  return typeof prices === 'string' ? prices : null;
}

import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';

async function fetchWithTimeout(url: string, options: any = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Origin': 'https://polymarket.com',
    'Referer': 'https://polymarket.com/'
  };

  const proxyUrl = process.env.HTTP_PROXY;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...defaultHeaders, ...options.headers },
      signal: controller.signal,
      agent
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

async function resolveSlug(slug: string) {
  try {
    console.log(`Resolving slug: ${slug}`);
    // 1. Try exact slug match
    let response = await fetchWithTimeout(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    let data = await response.json();
    if (data && data.length > 0) {
      return data[0];
    }

    // 2. Try search if slug fails
    console.log(`Exact slug failed, trying search for: ${slug}`);
    response = await fetchWithTimeout(`https://gamma-api.polymarket.com/events?search=${slug}`);
    data = await response.json();
    if (data && data.length > 0) {
      return data.find((e: any) => e.slug === slug) || data[0];
    }

    return null;
  } catch (error) {
    console.error("Error resolving slug:", error);
    return null;
  }
}

async function getMarketPrice(marketId: string) {
  console.log(`Fetching price for market ID: ${marketId}`);
  const isHex = marketId.startsWith('0x');

  const tryFetch = async (url: string) => {
    try {
      console.log(`Trying to fetch: ${url}`);
      const res = await fetchWithTimeout(url);
      if (res.ok) {
        const json = await res.json();
        console.log(`Successfully fetched from ${url}`);
        return json;
      }
      // Only log if it's NOT a 404, as 404 is expected during probing
      if (res.status !== 404) {
        console.log(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
      }
      return null;
    } catch (e: any) {
      console.log(`Fetch error for ${url}: ${e.message}`);
      return null;
    }
  };

  try {
    // 1. If it's a hex ID, prioritize CLOB API and specialized price endpoints
    if (isHex) {
      // Try CLOB Market endpoint
      const data = await tryFetch(`https://clob.polymarket.com/markets/${marketId}`);
      if (data) {
        console.log(`CLOB API success for hex ID ${marketId}`);
        const price = parseFloat(data.last_trade_price || data.price || data.best_bid || data.best_ask || "0");
        if (!isNaN(price) && price > 0) {
          return { 
            price, 
            name: data.question || data.description || marketId 
          };
        }
      }

      // Try Gamma API with conditionId filter
      const searchData = await tryFetch(`https://gamma-api.polymarket.com/markets?conditionId=${marketId}`);
      if (Array.isArray(searchData) && searchData.length > 0) {
        const m = searchData[0];
        console.log(`Gamma ConditionID search success for ${marketId}`);
        const priceStr = getFirstPrice(m.outcomePrices) || m.lastTradePrice || m.bestBid || "0";
        return {
          price: parseFloat(String(priceStr)),
          name: m.question || marketId,
          conditionId: m.conditionId
        };
      }
    }

    // 2. Standard Gamma Market endpoint
    const data = await tryFetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
    if (data) {
      console.log(`Gamma Market API success for ${marketId}`);
      let priceStr = getFirstPrice(data.outcomePrices);
      
      if (priceStr === null) {
        priceStr = data.last_trade_price || data.lastTradePrice || data.price || data.best_bid || data.bestBid || null;
      }

      if (priceStr !== null) {
        const price = parseFloat(String(priceStr));
        if (!isNaN(price)) {
          return { 
            price, 
            name: data.question || data.description || marketId,
            conditionId: data.conditionId 
          };
        }
      }
    }

    // 3. Gamma Event endpoint
    const eventData = await tryFetch(`https://gamma-api.polymarket.com/events/${marketId}`);
    if (eventData && eventData.markets && eventData.markets.length > 0) {
      console.log(`Gamma Event API success for ${marketId}`);
      const m = eventData.markets[0];
      const priceStr = getFirstPrice(m.outcomePrices) || m.lastTradePrice || m.bestBid || "0";
      return {
        price: parseFloat(String(priceStr)),
        name: m.question || eventData.title || marketId,
        conditionId: m.conditionId
      };
    }

    // 4. Fallback search by ID
    const searchData = await tryFetch(`https://gamma-api.polymarket.com/markets?id=${marketId}`);
    if (Array.isArray(searchData) && searchData.length > 0) {
      const m = searchData[0];
      console.log(`Gamma Search by ID success for ${marketId}`);
      const priceStr = getFirstPrice(m.outcomePrices) || m.lastTradePrice || m.bestBid || "0";
      return {
        price: parseFloat(String(priceStr)),
        name: m.question || marketId,
        conditionId: m.conditionId
      };
    }

    console.warn(`All API attempts failed for market ${marketId}`);
    return null;
  } catch (error: any) {
    console.error(`Exception fetching market ${marketId}:`, error.message);
    return null;
  }
}

// Email helper
async function sendEmail(to: string, subject: string, text: string) {
  let smtpHost = process.env.SMTP_HOST || "smtp.qq.com";
  const smtpPort = parseInt(process.env.SMTP_PORT || "465");
  const smtpUser = process.env.SMTP_USER || "1848368393@qq.com";
  const smtpPass = process.env.SMTP_PASS || "gdgntzjqjmavbccb";
  let emailFrom = process.env.EMAIL_FROM || smtpUser;
  if (!emailFrom.includes('@')) {
    console.warn(`EMAIL_FROM looks invalid (${emailFrom}), defaulting to ${smtpUser}`);
    emailFrom = smtpUser;
  }

  // Safeguard: if host looks like an email, it's probably misconfigured by the user
  if (smtpHost.includes('@')) {
    console.warn(`SMTP_HOST looks like an email (${smtpHost}), defaulting to smtp.qq.com`);
    smtpHost = "smtp.qq.com";
  }

  console.log(`Attempting to send email to ${to} via ${smtpHost}:${smtpPort} using ${smtpUser}...`);

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465, // true for 465, false for 587
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  try {
    const info = await transporter.sendMail({
      from: `"Polymarket Monitor" <${emailFrom}>`,
      to,
      subject,
      text,
    });
    console.log(`Email sent successfully: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Detailed Email Error:", error);
    throw error;
  }
}

// Monitoring logic
async function checkMonitors() {
  console.log(`[${new Date().toISOString()}] Starting monitor check...`);
  let monitors = [];
  try {
    monitors = db.prepare("SELECT * FROM monitors WHERE active = 1").all() as any[];
  } catch (dbErr) {
    console.error("Database error fetching monitors:", dbErr);
    return;
  }
  
  if (monitors.length === 0) {
    console.log("No active monitors found.");
    return;
  }

  for (const monitor of monitors) {
    try {
      console.log(`Checking monitor ${monitor.id} for market ${monitor.market_id}...`);
      const marketData = await getMarketPrice(monitor.market_id);
      
      if (!marketData || isNaN(marketData.price)) {
        console.warn(`Could not fetch valid data for market ${monitor.market_id}`);
        db.prepare("UPDATE monitors SET last_checked_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?")
          .run("Market data unavailable or invalid", monitor.id);
        continue;
      }

      const currentPrice = marketData.price * 100; // Convert to percentage
      console.log(`Market: ${marketData.name} | Current Price: ${currentPrice.toFixed(2)}% | Threshold: ${monitor.threshold}% (${monitor.condition})`);

      // Update current price and check time
      db.prepare("UPDATE monitors SET current_price = ?, last_checked_at = CURRENT_TIMESTAMP, last_error = NULL, market_name = ? WHERE id = ?")
        .run(currentPrice, marketData.name, monitor.id);

      let triggered = false;
      if (monitor.condition === 'above' && currentPrice >= monitor.threshold) {
        triggered = true;
      } else if (monitor.condition === 'below' && currentPrice <= monitor.threshold) {
        triggered = true;
      }

      if (triggered) {
        console.log(`Condition MET for monitor ${monitor.id}`);
        // Avoid spamming: only notify if the value has changed significantly (e.g. 0.5%) or it's the first time
        const shouldNotify = monitor.last_notified_value === null || Math.abs(currentPrice - monitor.last_notified_value) > 0.5;
        
        if (shouldNotify) {
          console.log(`Sending notification for monitor ${monitor.id} to ${monitor.email}...`);
          const subject = `Polymarket Alert: ${marketData.name}`;
          const text = `The probability for "${marketData.name}" is now ${currentPrice.toFixed(2)}%, which is ${monitor.condition} your threshold of ${monitor.threshold}%.
          
Market ID: ${monitor.market_id}
Check it here: https://polymarket.com/event/${monitor.market_id}`;

          try {
            await sendEmail(monitor.email, subject, text);
            db.prepare("UPDATE monitors SET last_notified_value = ? WHERE id = ?")
              .run(currentPrice, monitor.id);
          } catch (err: any) {
            console.error(`Email failed for monitor ${monitor.id}:`, err);
            db.prepare("UPDATE monitors SET last_error = ? WHERE id = ?")
              .run(`Email failed: ${err.message}`, monitor.id);
          }
        } else {
          console.log(`Notification skipped for monitor ${monitor.id} (insufficient change since last notification)`);
        }
      } else {
        console.log(`Condition NOT met for monitor ${monitor.id}`);
      }
    } catch (loopErr: any) {
      console.error(`Error in monitor loop for ID ${monitor.id}:`, loopErr);
      try {
        db.prepare("UPDATE monitors SET last_error = ? WHERE id = ?")
          .run(`Internal error: ${loopErr.message}`, monitor.id);
      } catch (dbErr) {
        console.error("Failed to log loop error to DB:", dbErr);
      }
    }
  }
}

// Run check every 2 minutes for more responsiveness
setInterval(checkMonitors, 2 * 60 * 1000);

// API Routes
app.get("/api/status", (req, res) => {
  const smtpHost = process.env.SMTP_HOST || "smtp.qq.com";
  res.json({
    database: "Connected",
    smtpHost: smtpHost.includes('@') ? "smtp.qq.com (Auto-corrected)" : smtpHost,
    checkInterval: "Every 2m",
    smtpUser: process.env.SMTP_USER || "1848368393@qq.com",
    emailFrom: process.env.EMAIL_FROM || process.env.SMTP_USER || "1848368393@qq.com"
  });
});

app.get("/api/monitors", (req, res) => {
  const monitors = db.prepare("SELECT * FROM monitors ORDER BY created_at DESC").all();
  res.json(monitors);
});

// Trending markets endpoint
app.get("/api/trending", async (req, res) => {
  try {
    const response = await fetchWithTimeout(`https://gamma-api.polymarket.com/markets?limit=12&active=true&closed=false`);
    if (!response.ok) throw new Error("Failed to fetch trending markets");
    
    const markets = await response.json();
    const results = markets.map((m: any) => ({
      id: m.id,
      question: m.question,
      price: parseFloat(getFirstPrice(m.outcomePrices) || m.lastTradePrice || "0"),
      volume: parseFloat(m.volume || "0"),
      groupItemTitle: m.groupItemTitle || m.xAxisValue
    }));

    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Discovery endpoint for price-based markets
app.get("/api/discovery", async (req, res) => {
  const { q, level } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  try {
    console.log(`Discovery search for: ${q} at level: ${level}`);
    // Fetch a large batch of markets to find price series
    const response = await fetchWithTimeout(`https://gamma-api.polymarket.com/markets?limit=500&search=${encodeURIComponent(q as string)}`);
    if (!response.ok) throw new Error("Failed to fetch markets from Gamma");
    
    const markets = await response.json();
    
    // Filter and map
    let filtered = markets;
    if (level) {
      filtered = markets.filter((m: any) => 
        m.xAxisValue === level || 
        m.question.includes(level as string) || 
        m.description?.includes(level as string)
      );
    }

    const results = filtered.map((m: any) => ({
      id: m.id,
      conditionId: m.conditionId,
      question: m.question,
      price: parseFloat(getFirstPrice(m.outcomePrices) || m.lastTradePrice || "0"),
      level: m.xAxisValue,
      groupItemTitle: m.groupItemTitle || m.xAxisValue
    }));

    res.json({ markets: results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/search", async (req, res) => {
  const query = req.query.q as string;
  if (!query) return res.status(400).json({ error: "Query required" });

  try {
    console.log(`Searching for: ${query}`);
    
    // 1. Search for events (Gamma API)
    const eventResp = await fetchWithTimeout(`https://gamma-api.polymarket.com/events?search=${encodeURIComponent(query)}&active=true&limit=10`);
    const events = await eventResp.json();
    
    // 2. Search for markets directly (Gamma API)
    const marketResp = await fetchWithTimeout(`https://gamma-api.polymarket.com/markets?search=${encodeURIComponent(query)}&active=true&limit=10`);
    const directMarkets = await marketResp.json();

    const allMarkets: any[] = [];
    
    // Process direct markets
    if (Array.isArray(directMarkets)) {
      directMarkets.forEach((m: any) => {
        allMarkets.push({
          id: m.conditionId || m.id,
          question: m.question,
          groupItemTitle: m.groupItemTitle || "Market Match",
          active: m.active,
          price: m.outcomePrices ? parseFloat(getFirstPrice(m.outcomePrices) || "0") : null
        });
      });
    }

    // Process events
    if (Array.isArray(events)) {
      events.forEach((event: any) => {
        if (event.markets) {
          event.markets.forEach((m: any) => {
            // Avoid duplicates
            const id = m.conditionId || m.id;
            if (!allMarkets.find(am => am.id === id)) {
              allMarkets.push({
                id: id,
                question: m.question,
                groupItemTitle: m.groupItemTitle || event.title,
                active: m.active,
                price: m.outcomePrices ? parseFloat(getFirstPrice(m.outcomePrices) || "0") : null
              });
            }
          });
        }
      });
    }

    // Filter for active markets and sort
    const activeMarkets = allMarkets.filter(m => m.active !== false);

    res.json({ markets: activeMarkets });
  } catch (err) {
    console.error("Search API Error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});
app.get("/api/market/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const market = await getMarketPrice(id);
    if (market) {
      res.json({
        markets: [{
          id: id,
          question: market.name,
          groupItemTitle: "Direct ID Match"
        }]
      });
    } else {
      res.status(404).json({ error: "Market not found" });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch market" });
  }
});

app.get("/api/resolve", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: "URL required" });

  try {
    // Handle various URL formats including language prefixes like /zh/
    const slugMatch = url.match(/(?:\/event\/|slug=)([^/?#&]+)/);
    if (!slugMatch) return res.status(400).json({ error: "Invalid Polymarket URL format" });

    const slug = slugMatch[1];
    const eventData = await resolveSlug(slug);
    
    if (!eventData) {
      return res.status(404).json({ error: `Event "${slug}" not found. Try entering the Market ID directly.` });
    }

    // Return markets for the user to choose from
    const markets = eventData.markets || (Array.isArray(eventData) ? eventData : [eventData]);
    
    res.json({
      title: eventData.title || eventData.question || slug,
      markets: markets.map((m: any) => ({
        id: m.id || m.conditionId,
        question: m.question || m.title,
        groupItemTitle: m.groupItemTitle || m.xAxisValue || m.outcomes?.[0],
        price: parseFloat(getFirstPrice(m.outcomePrices) || m.lastTradePrice || "0")
      }))
    });
  } catch (err) {
    console.error("Resolve API Error:", err);
    res.status(500).json({ error: "Resolution failed" });
  }
});

app.post("/api/monitors", async (req, res) => {
  const { market_id, threshold, condition, email } = req.body;
  
  console.log(`Received request to add monitor: ${market_id}, ${threshold}%, ${condition}, ${email}`);

  if (!market_id || threshold === undefined || !condition || !email) {
    console.warn("Missing required fields in POST /api/monitors");
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const marketData = await getMarketPrice(market_id);
    const marketName = marketData?.name || market_id;

    console.log(`Saving monitor to database for ${marketName}...`);
    const result = db.prepare(`
      INSERT INTO monitors (market_id, market_name, threshold, condition, email)
      VALUES (?, ?, ?, ?, ?)
    `).run(market_id, marketName, threshold, condition, email);

    console.log(`Monitor saved with ID: ${result.lastInsertRowid}`);

    // Run a check immediately for this new monitor
    checkMonitors().catch(err => console.error("Initial check failed:", err));

    res.json({ id: result.lastInsertRowid, market_name: marketName });
  } catch (err: any) {
    console.error("Failed to add monitor:", err);
    res.status(500).json({ error: "Failed to add monitor", details: err.message });
  }
});

app.delete("/api/monitors", (req, res) => {
  db.prepare("DELETE FROM monitors").run();
  res.json({ success: true });
});

app.delete("/api/monitors/:id", (req, res) => {
  db.prepare("DELETE FROM monitors WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/monitors/:id/toggle", (req, res) => {
  db.prepare("UPDATE monitors SET active = 1 - active WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/check-now", async (req, res) => {
  try {
    await checkMonitors();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/test-email", async (req, res) => {
  const { email, subject, text } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  
  const emailSubject = subject || "Polymarket Monitor Test";
  const emailText = text || "This is a test email from your Polymarket Monitor system.";

  try {
    const result = await sendEmail(email, emailSubject, emailText);
    res.json(result);
  } catch (err: any) {
    console.error("Test Email Route Error:", err);
    res.status(500).json({ 
      error: "Test failed", 
      details: err.message,
      code: err.code,
      command: err.command
    });
  }
});

// Vite middleware
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
    // SPA fallback: serve index.html for all non-API routes
    app.get("*", (req, res) => {
      if (!req.path.startsWith("/api/")) {
        res.sendFile(path.resolve("dist/index.html"));
      }
    });
  }

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // Initial check
    checkMonitors();
  });
}

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

startServer().catch(err => {
  console.error("CRITICAL SERVER ERROR:", err);
  process.exit(1);
});
