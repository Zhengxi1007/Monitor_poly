import { useEffect, useState, CSSProperties, FormEvent } from "react";

type Monitor = {
  id: number;
  market_id: string;
  market_name: string | null;
  threshold: number;
  condition: "above" | "below";
  email: string;
  active: number;
  current_price: number | null;
  order_placed: number;
  trade_direction: "long" | "short" | null;
  order_notional_usdt: number | null;
  okx_order_id?: string | null;
  last_error?: string | null;
};

type MarketOption = {
  id: string;
  question: string;
  groupItemTitle?: string;
  price?: number | null;
};

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export default function App() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [options, setOptions] = useState<MarketOption[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [form, setForm] = useState({
    market_id: "",
    market_name: "",
    threshold: "50",
    condition: "above",
    trade_direction: "short",
    order_notional_usdt: "1000",
    email: "",
  });

  const loadMonitors = async () => {
    const data = await api("/api/monitors");
    setMonitors(data);
  };

  useEffect(() => {
    loadMonitors().catch((e) => setMessage(e.message));
  }, []);

  const resolveUrl = async () => {
    setLoading(true);
    setMessage("");
    try {
      const data = await api(`/api/resolve?url=${encodeURIComponent(urlInput)}`);
      setOptions(data.markets || []);
      setMessage(`已解析到 ${data.markets?.length || 0} 个市场`);
    } catch (e: any) {
      setOptions([]);
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  };

  const searchMarkets = async () => {
    setLoading(true);
    setMessage("");
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(searchInput)}`);
      setOptions(data.markets || []);
      setMessage(`已搜索到 ${data.markets?.length || 0} 个市场`);
    } catch (e: any) {
      setOptions([]);
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  };

  const chooseMarket = (option: MarketOption) => {
    setForm((prev) => ({
      ...prev,
      market_id: option.id,
      market_name: option.question,
    }));
    setMessage(`已选择 market_id=${option.id}`);
  };

  const submitMonitor = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      await api("/api/monitors", {
        method: "POST",
        body: JSON.stringify({
          market_id: form.market_id,
          threshold: Number(form.threshold),
          condition: form.condition,
          email: form.email,
          trade_direction: form.trade_direction,
          trade_enabled: true,
          order_notional_usdt: Number(form.order_notional_usdt),
        }),
      });
      setMessage("监控已创建");
      await loadMonitors();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  };

  const runCheck = async () => {
    setLoading(true);
    try {
      await api("/api/check-now", { method: "POST" });
      await loadMonitors();
      setMessage("已执行立即检查");
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  };

  const testOrder = async (tradeDirection: "long" | "short") => {
    setLoading(true);
    try {
      const data = await api("/api/test-order", {
        method: "POST",
        body: JSON.stringify({
          market_id: form.market_id || "1345530",
          tradeDirection,
          notionalUsdt: Number(form.order_notional_usdt),
        }),
      });
      setMessage(`测试下单成功，订单号 ${data.order?.ordId || "未知"}`);
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleMonitor = async (id: number) => {
    await api(`/api/monitors/${id}/toggle`, { method: "POST" });
    await loadMonitors();
  };

  const deleteMonitor = async (id: number) => {
    await api(`/api/monitors/${id}`, { method: "DELETE" });
    await loadMonitors();
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24, fontFamily: "Segoe UI, sans-serif" }}>
      <h1 style={{ marginBottom: 8 }}>Polymarket 监控</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        保留原本的市场搜索和 URL 解析流程，只新增手动选择多空方向与 OKX Demo 自动下单能力。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 20 }}>
        <div style={card}>
          <h2 style={title}>解析市场</h2>
          <label>Polymarket 网址</label>
          <input
            style={input}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://polymarket.com/event/what-price-will-bitcoin-hit-before-2027"
          />
          <button style={secondaryBtn} onClick={resolveUrl} disabled={loading || !urlInput}>
            解析网址
          </button>

          <label style={{ marginTop: 16, display: "block" }}>关键词搜索</label>
          <input
            style={input}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="bitcoin 2027"
          />
          <button style={secondaryBtn} onClick={searchMarkets} disabled={loading || !searchInput}>
            搜索市场
          </button>

          <div style={{ marginTop: 16, display: "grid", gap: 10, maxHeight: 320, overflow: "auto" }}>
            {options.map((item) => (
              <button key={`${item.id}-${item.question}`} type="button" style={optionBtn} onClick={() => chooseMarket(item)}>
                <div style={{ fontWeight: 700 }}>{item.question}</div>
                <div style={{ color: "#666", fontSize: 14 }}>
                  market_id: {item.id}
                  {item.groupItemTitle ? ` | ${item.groupItemTitle}` : ""}
                </div>
              </button>
            ))}
            {options.length === 0 ? <div style={{ color: "#777" }}>解析或搜索后，这里会出现可选市场。</div> : null}
          </div>
        </div>

        <form style={card} onSubmit={submitMonitor}>
          <h2 style={title}>创建监控</h2>
          <label>Market ID</label>
          <input
            style={input}
            value={form.market_id}
            onChange={(e) => setForm((prev) => ({ ...prev, market_id: e.target.value }))}
          />
          <div style={{ color: "#666", marginTop: -8, marginBottom: 12 }}>
            {form.market_name ? `已选市场: ${form.market_name}` : "可通过左侧解析或搜索后自动回填"}
          </div>

          <label>触发条件</label>
          <select
            style={input}
            value={form.condition}
            onChange={(e) => setForm((prev) => ({ ...prev, condition: e.target.value }))}
          >
            <option value="above">above</option>
            <option value="below">below</option>
          </select>

          <label>阈值百分比</label>
          <input
            style={input}
            value={form.threshold}
            onChange={(e) => setForm((prev) => ({ ...prev, threshold: e.target.value }))}
          />

          <label>交易方向</label>
          <select
            style={input}
            value={form.trade_direction}
            onChange={(e) => setForm((prev) => ({ ...prev, trade_direction: e.target.value }))}
          >
            <option value="long">做多 / long</option>
            <option value="short">做空 / short</option>
          </select>

          <label>下单金额 USDT</label>
          <input
            style={input}
            value={form.order_notional_usdt}
            onChange={(e) => setForm((prev) => ({ ...prev, order_notional_usdt: e.target.value }))}
          />

          <label>邮件地址</label>
          <input
            style={input}
            value={form.email}
            onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
          />

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
            <button style={primaryBtn} type="submit" disabled={loading}>
              创建监控
            </button>
            <button style={secondaryBtn} type="button" onClick={runCheck} disabled={loading}>
              立即检查
            </button>
            <button style={secondaryBtn} type="button" onClick={() => testOrder("long")} disabled={loading}>
              测试做多
            </button>
            <button style={secondaryBtn} type="button" onClick={() => testOrder("short")} disabled={loading}>
              测试做空
            </button>
          </div>

          {message ? <div style={{ marginTop: 16, background: "#f4f6f8", padding: 12, borderRadius: 8 }}>{message}</div> : null}
        </form>
      </div>

      <div style={{ ...card, marginTop: 20 }}>
        <h2 style={title}>当前监控</h2>
        <div style={{ display: "grid", gap: 12 }}>
          {monitors.map((monitor) => (
            <div key={monitor.id} style={itemCard}>
              <div style={{ fontWeight: 700 }}>{monitor.market_name || monitor.market_id}</div>
              <div>Market ID: {monitor.market_id}</div>
              <div>
                触发: {monitor.condition} {monitor.threshold}% | 方向: {monitor.trade_direction || "未设置"} | 金额:{" "}
                {monitor.order_notional_usdt || 1000} USDT
              </div>
              <div>
                当前价格: {monitor.current_price !== null ? `${monitor.current_price.toFixed(2)}%` : "暂无"} | 状态:{" "}
                {monitor.active ? "运行中" : "已暂停"}
              </div>
              <div>
                下单状态: {monitor.order_placed ? `已下单 ${monitor.okx_order_id || ""}` : "未下单"}
                {monitor.last_error ? ` | 错误: ${monitor.last_error}` : ""}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button style={secondaryBtn} onClick={() => toggleMonitor(monitor.id)}>
                  {monitor.active ? "暂停" : "启用"}
                </button>
                <button style={dangerBtn} onClick={() => deleteMonitor(monitor.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
          {monitors.length === 0 ? <div>还没有监控。</div> : null}
        </div>
      </div>
    </div>
  );
}

const card: CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 20,
};

const title: CSSProperties = {
  marginTop: 0,
};

const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  marginBottom: 14,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #cfd6dd",
};

const primaryBtn: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  background: "#0f766e",
  color: "#fff",
  cursor: "pointer",
};

const secondaryBtn: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "1px solid #cfd6dd",
  background: "#fff",
  cursor: "pointer",
};

const dangerBtn: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  background: "#b91c1c",
  color: "#fff",
  cursor: "pointer",
};

const optionBtn: CSSProperties = {
  textAlign: "left",
  border: "1px solid #ddd",
  background: "#fff",
  borderRadius: 10,
  padding: 12,
  cursor: "pointer",
};

const itemCard: CSSProperties = {
  border: "1px solid #eee",
  borderRadius: 10,
  padding: 16,
};
