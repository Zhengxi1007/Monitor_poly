import { useEffect, useState } from "react";

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

const api = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
};

export default function App() {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    market_id: "1345530",
    threshold: "50",
    condition: "above",
    trade_direction: "short",
    order_notional_usdt: "1000",
    email: "",
  });

  const load = async () => {
    const data = await api("/api/monitors");
    setMonitors(data);
  };

  useEffect(() => {
    load().catch((e) => setMessage(e.message));
  }, []);

  const submit = async (e: React.FormEvent) => {
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
          trade_direction: form.trade_direction,
          order_notional_usdt: Number(form.order_notional_usdt),
          trade_enabled: true,
          email: form.email,
        }),
      });
      setMessage("监控已创建");
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setLoading(false);
    }
  };

  const removeMonitor = async (id: number) => {
    await api(`/api/monitors/${id}`, { method: "DELETE" });
    await load();
  };

  const toggleMonitor = async (id: number) => {
    await api(`/api/monitors/${id}/toggle`, { method: "POST" });
    await load();
  };

  const checkNow = async () => {
    setLoading(true);
    try {
      await api("/api/check-now", { method: "POST" });
      await load();
      setMessage("已立即执行检查");
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
          market_id: form.market_id,
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

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: 24, fontFamily: "Segoe UI, sans-serif" }}>
      <h1 style={{ marginBottom: 8 }}>Polymarket 监控 + OKX 模拟盘</h1>
      <p style={{ color: "#555", marginTop: 0 }}>
        手动设置触发数值，手动选择做多或做空。命中后保留邮件提醒，并在 OKX Demo 只下一次单。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 20 }}>
        <form onSubmit={submit} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 20 }}>
          <h2 style={{ marginTop: 0 }}>创建监控</h2>
          <label>Market ID</label>
          <input value={form.market_id} onChange={(e) => setForm({ ...form, market_id: e.target.value })} style={inputStyle} />

          <label>触发条件</label>
          <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} style={inputStyle}>
            <option value="above">above</option>
            <option value="below">below</option>
          </select>

          <label>阈值百分比</label>
          <input value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} style={inputStyle} />

          <label>交易方向</label>
          <select
            value={form.trade_direction}
            onChange={(e) => setForm({ ...form, trade_direction: e.target.value })}
            style={inputStyle}
          >
            <option value="long">做多 / long</option>
            <option value="short">做空 / short</option>
          </select>

          <label>下单金额 USDT</label>
          <input
            value={form.order_notional_usdt}
            onChange={(e) => setForm({ ...form, order_notional_usdt: e.target.value })}
            style={inputStyle}
          />

          <label>邮件地址</label>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={inputStyle} />

          <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <button disabled={loading} style={primaryButton} type="submit">
              创建监控
            </button>
            <button disabled={loading} style={secondaryButton} type="button" onClick={checkNow}>
              立即检查
            </button>
            <button disabled={loading} style={secondaryButton} type="button" onClick={() => testOrder("long")}>
              测试做多
            </button>
            <button disabled={loading} style={secondaryButton} type="button" onClick={() => testOrder("short")}>
              测试做空
            </button>
          </div>
        </form>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 20 }}>
          <h2 style={{ marginTop: 0 }}>说明</h2>
          <p>默认只对 `1345530` 映射到 `BTC-USDT-SWAP`。</p>
          <p>触发条件决定何时触发，交易方向决定触发后开多还是开空。</p>
          <p>同一条监控成功下单后不会重复下单，但仍会继续保留监控和邮件状态。</p>
          {message ? <div style={{ background: "#f4f6f8", padding: 12, borderRadius: 8 }}>{message}</div> : null}
        </div>
      </div>

      <div style={{ marginTop: 24, border: "1px solid #ddd", borderRadius: 12, padding: 20 }}>
        <h2 style={{ marginTop: 0 }}>当前监控</h2>
        <div style={{ display: "grid", gap: 12 }}>
          {monitors.map((m) => (
            <div key={m.id} style={{ border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 700 }}>{m.market_name || m.market_id}</div>
              <div>Market ID: {m.market_id}</div>
              <div>
                规则: {m.condition} {m.threshold}% | 方向: {m.trade_direction || "未设置"} | 金额:{" "}
                {m.order_notional_usdt || 1000} USDT
              </div>
              <div>
                当前价格: {m.current_price ? `${m.current_price.toFixed(2)}%` : "暂无"} | 状态:{" "}
                {m.active ? "运行中" : "已暂停"}
              </div>
              <div>
                下单状态: {m.order_placed ? `已下单 ${m.okx_order_id || ""}` : "未下单"}
                {m.last_error ? ` | 错误: ${m.last_error}` : ""}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button style={secondaryButton} onClick={() => toggleMonitor(m.id)}>
                  {m.active ? "暂停" : "启用"}
                </button>
                <button style={dangerButton} onClick={() => removeMonitor(m.id)}>
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  marginBottom: 14,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #cfd6dd",
};

const primaryButton: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  background: "#0f766e",
  color: "#fff",
  cursor: "pointer",
};

const secondaryButton: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "1px solid #cfd6dd",
  background: "#fff",
  cursor: "pointer",
};

const dangerButton: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  background: "#b91c1c",
  color: "#fff",
  cursor: "pointer",
};
