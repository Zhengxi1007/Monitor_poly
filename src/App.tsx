import React, { useState, useEffect } from 'react';
import { Bell, Trash2, Plus, Activity, Mail, ExternalLink, Power, PowerOff, AlertCircle, RefreshCw, Search, Send } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Monitor {
  id: number;
  market_id: string;
  market_name: string;
  threshold: number;
  condition: 'above' | 'below';
  email: string;
  last_notified_value: number | null;
  current_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  active: number;
  created_at: string;
}

export default function App() {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [marketId, setMarketId] = useState('');
  const [threshold, setThreshold] = useState('');
  const [condition, setCondition] = useState<'above' | 'below'>('above');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const [resolvedMarkets, setResolvedMarkets] = useState<{id: string, question: string, groupItemTitle?: string, price?: number}[]>([]);
  const [trendingMarkets, setTrendingMarkets] = useState<{id: string, question: string, price: number, volume: number, groupItemTitle?: string}[]>([]);
  const [loadingTrending, setLoadingTrending] = useState(false);

  const [checking, setChecking] = useState(false);

  const [systemStatus, setSystemStatus] = useState({
    database: 'Connecting...',
    smtpHost: 'Loading...',
    checkInterval: 'Loading...'
  });

  useEffect(() => {
    fetchMonitors();
    fetchTrending();
    fetchStatus();
    const interval = setInterval(() => {
      fetchMonitors();
      fetchStatus();
    }, 10000); // Refresh UI every 10s
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setSystemStatus(data);
    } catch (err) {
      console.error('Failed to fetch status');
    }
  };

  const fetchTrending = async () => {
    setLoadingTrending(true);
    try {
      const res = await fetch('/api/trending');
      const data = await res.json();
      if (Array.isArray(data)) {
        setTrendingMarkets(data);
      } else {
        console.error('Trending markets API returned an error:', data);
        setTrendingMarkets([]);
      }
    } catch (err) {
      console.error('Failed to fetch trending markets', err);
      setTrendingMarkets([]);
    } finally {
      setLoadingTrending(false);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      await fetch('/api/check-now', { method: 'POST' });
      await fetchMonitors();
    } catch (err) {
      console.error(err);
    } finally {
      setChecking(false);
    }
  };

  const testEmail = async () => {
    if (!email) {
      setError('Please enter an email address first');
      return;
    }
    setTestingEmail(true);
    setError('');
    try {
      const res = await fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || 'Test failed');
      alert('Test email sent! Please check your inbox (and spam folder).');
    } catch (err: any) {
      setError(`Email test failed: ${err.message}`);
    } finally {
      setTestingEmail(false);
    }
  };

  const resolveUrl = async () => {
    if (!marketId) return;
    
    setResolving(true);
    setError('');
    try {
      let endpoint = '';
      const isUrl = marketId.includes('polymarket.com');
      const isDirectId = /^\d+$/.test(marketId) || marketId.startsWith('0x');

      if (isUrl) {
        endpoint = `/api/resolve?url=${encodeURIComponent(marketId)}`;
      } else if (isDirectId) {
        endpoint = `/api/market/${encodeURIComponent(marketId)}`;
      } else {
        // Smart discovery: check if query has a price level (e.g. "BTC 70000")
        const parts = marketId.trim().split(/\s+/);
        const hasNumber = parts.some(p => /^\d+$/.test(p));
        
        if (hasNumber && parts.length > 1) {
          const level = parts.find(p => /^\d+$/.test(p));
          const query = parts.filter(p => !/^\d+$/.test(p)).join(' ');
          endpoint = `/api/discovery?q=${encodeURIComponent(query)}&level=${encodeURIComponent(level || '')}`;
        } else {
          endpoint = `/api/search?q=${encodeURIComponent(marketId)}`;
        }
      }
        
      const res = await fetch(endpoint);
      const data = await res.json();
      
      if (!res.ok) throw new Error(data.error || 'Failed to find markets');
      
      setResolvedMarkets(data.markets || []);
      if (data.markets?.length === 0) {
        setError('No active markets found. Try a different URL or search term.');
      }
    } catch (err: any) {
      console.error('Resolve error:', err);
      setError(err.message || 'Could not find markets. Please enter the Market ID manually.');
    } finally {
      setResolving(false);
    }
  };

  const selectMarket = (id: string) => {
    setMarketId(id);
    setResolvedMarkets([]);
  };

  const fetchMonitors = async () => {
    try {
      const res = await fetch('/api/monitors');
      const data = await res.json();
      if (Array.isArray(data)) {
        setMonitors(data);
      } else {
        console.error('Monitors API returned an error:', data);
        setMonitors([]);
      }
    } catch (err) {
      console.error('Failed to fetch monitors', err);
      setMonitors([]);
    }
  };

  const addMonitor = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market_id: marketId,
          threshold: parseFloat(threshold),
          condition,
          email,
        }),
      });
      if (!res.ok) throw new Error('Failed to add monitor');
      
      setMarketId('');
      setThreshold('');
      setEmail('');
      fetchMonitors();
    } catch (err) {
      setError('Failed to add monitor. Please check the Market ID.');
    } finally {
      setLoading(false);
    }
  };

  const deleteMonitor = async (id: number) => {
    await fetch(`/api/monitors/${id}`, { method: 'DELETE' });
    fetchMonitors();
  };

  const testMonitorEmail = async (monitor: any) => {
    setTestingEmail(true);
    setError('');
    try {
      const res = await fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          email: monitor.email,
          subject: `TEST ALERT: ${monitor.market_name}`,
          text: `This is a manual test alert for your monitor: ${monitor.market_name}.\n\nCondition: ${monitor.condition} ${monitor.threshold}%\nCurrent Price: ${monitor.current_price?.toFixed(2) || 'N/A'}%`
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || 'Test failed');
      alert(`Test alert sent to ${monitor.email}!`);
    } catch (err: any) {
      setError(`Monitor test failed: ${err.message}`);
    } finally {
      setTestingEmail(false);
    }
  };

  const toggleMonitor = async (id: number) => {
    await fetch(`/api/monitors/${id}/toggle`, { method: 'POST' });
    fetchMonitors();
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Activity className="text-black w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Polymarket Monitor</h1>
              <p className="text-xs text-zinc-500 font-mono uppercase tracking-widest">Real-time Odds Alerts</p>
            </div>
          </div>
            <div className="flex items-center gap-4">
              <button
                onClick={runCheck}
                disabled={checking || loading}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 rounded-xl border border-emerald-500/20 transition-all text-xs font-medium"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
                {checking ? 'Checking...' : 'Check Now'}
              </button>
              <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 bg-white/5 px-3 py-1.5 rounded-full border border-white/10">
                <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                SYSTEM ACTIVE
              </div>
            </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-12">
        {/* Trending Markets Section */}
        <section className="mb-16">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-semibold flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-500" />
              Trending Markets
            </h2>
            <button 
              onClick={fetchTrending}
              disabled={loadingTrending}
              className="text-xs font-mono text-zinc-500 hover:text-emerald-500 flex items-center gap-2 transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${loadingTrending ? 'animate-spin' : ''}`} />
              REFRESH TRENDING
            </button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {loadingTrending ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-24 bg-zinc-900/30 rounded-2xl border border-white/5 animate-pulse" />
              ))
            ) : (
              trendingMarkets.map((m) => (
                <div 
                  key={m.id}
                  className="group bg-zinc-900/50 border border-white/5 rounded-2xl p-4 hover:border-emerald-500/30 transition-all cursor-pointer"
                  onClick={() => setMarketId(m.id)}
                >
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[10px] font-mono text-emerald-500 font-bold uppercase tracking-wider">
                      {m.groupItemTitle || 'Market'}
                    </span>
                    <span className="text-sm font-mono font-bold text-emerald-400">
                      {(m.price * 100).toFixed(1)}%
                    </span>
                  </div>
                  <h3 className="text-xs font-medium text-zinc-200 line-clamp-2 mb-2 group-hover:text-white transition-colors">
                    {m.question}
                  </h3>
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-[9px] font-mono text-zinc-600">ID: {m.id}</span>
                    <button 
                      className="text-[9px] font-bold text-emerald-500 hover:text-emerald-400 uppercase tracking-widest"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMarketId(m.id);
                      }}
                    >
                      Monitor +
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          {/* Form Section */}
          <div className="lg:col-span-1">
            <div className="sticky top-28">
              <h2 className="text-2xl font-semibold mb-6 flex items-center gap-2">
                <Plus className="w-5 h-5 text-emerald-500" />
                New Alert
              </h2>
              <form onSubmit={addMonitor} className="space-y-6 bg-zinc-900/50 p-6 rounded-2xl border border-white/5 shadow-2xl">
                <div>
                  <label className="block text-xs font-mono text-zinc-500 uppercase mb-2 tracking-wider">Market URL or ID</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      placeholder="Paste Polymarket URL or search..."
                      className="flex-1 bg-black border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                      value={marketId}
                      onChange={(e) => setMarketId(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          resolveUrl();
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={resolveUrl}
                      disabled={resolving || !marketId}
                      className="px-4 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all disabled:opacity-50"
                      title="Search or Resolve URL"
                    >
                      <Search className={`w-4 h-4 ${resolving ? 'animate-pulse text-emerald-500' : 'text-zinc-400'}`} />
                    </button>
                  </div>
                  
                  {resolving && (
                    <div className="mt-2 flex items-center gap-2 text-[10px] text-emerald-500 animate-pulse">
                      <Activity className="w-3 h-3" /> Searching Polymarket...
                    </div>
                  )}

                  {resolvedMarkets.length > 0 && (
                    <div className="mt-3 space-y-2 max-h-48 overflow-y-auto p-2 bg-black rounded-xl border border-white/10">
                      <p className="text-[10px] font-bold text-zinc-500 uppercase px-2 py-1">Select a specific market:</p>
                      {resolvedMarkets.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => selectMarket(m.id)}
                          className="w-full text-left p-2 rounded-lg hover:bg-emerald-500/10 text-xs transition-colors border border-transparent hover:border-emerald-500/20"
                        >
                          <div className="flex justify-between items-start">
                            <div className="font-bold text-emerald-400">{m.groupItemTitle || 'Market'}</div>
                            {m.price !== undefined && m.price !== null && (
                              <div className="text-emerald-500 font-mono font-bold">{(m.price * 100).toFixed(1)}%</div>
                            )}
                          </div>
                          <div className="text-zinc-400 truncate">{m.question}</div>
                          <div className="text-[9px] font-mono text-zinc-600 mt-1">ID: {m.id}</div>
                        </button>
                      ))}
                    </div>
                  )}

                  <p className="mt-2 text-[10px] text-zinc-600 leading-relaxed">
                    Tip: Try <span className="text-emerald-500 font-mono">"BTC 70000"</span> to find specific price levels instantly!
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-mono text-zinc-500 uppercase mb-2 tracking-wider">Condition</label>
                    <select
                      className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors appearance-none"
                      value={condition}
                      onChange={(e) => setCondition(e.target.value as any)}
                    >
                      <option value="above">Above (≥)</option>
                      <option value="below">Below (≤)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-mono text-zinc-500 uppercase mb-2 tracking-wider">Threshold (%)</label>
                    <input
                      type="number"
                      required
                      placeholder="75"
                      className="w-full bg-black border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                      value={threshold}
                      onChange={(e) => setThreshold(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-mono text-zinc-500 uppercase mb-2 tracking-wider">Alert Email</label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                      <input
                        type="email"
                        required
                        placeholder="your@email.com"
                        className="w-full bg-black border border-white/10 rounded-xl pl-11 pr-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={testEmail}
                      disabled={testingEmail}
                      className="px-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl border border-white/10 transition-all text-xs font-mono"
                    >
                      {testingEmail ? '...' : 'TEST'}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-400 text-xs bg-red-400/10 p-3 rounded-xl border border-red-400/20">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                  ) : (
                    <>
                      <Bell className="w-4 h-4" />
                      Create Monitor
                    </>
                  )}
                </button>
              </form>
              
              <div className="mt-8 p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/10">
                <h4 className="text-xs font-bold text-emerald-500 uppercase mb-2">System Status</h4>
                <div className="space-y-2 text-[10px] font-mono">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Database:</span>
                    <span className="text-emerald-400">{systemStatus.database}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">SMTP Host:</span>
                    <span className="text-zinc-300">{systemStatus.smtpHost}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Auto-Check:</span>
                    <span className="text-zinc-300">{systemStatus.checkInterval}</span>
                  </div>
                </div>
                <p className="mt-4 text-[11px] text-zinc-400 leading-relaxed">
                  To receive emails, you must configure SMTP settings in the <code className="text-emerald-400">.env</code> file. Otherwise, alerts will only be logged to the server console.
                </p>
              </div>
            </div>
          </div>

          {/* List Section */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-semibold flex items-center gap-2">
                <Activity className="w-5 h-5 text-emerald-500" />
                Active Monitors
              </h2>
              <div className="flex items-center gap-4">
                <button 
                  onClick={fetchMonitors}
                  className="text-[10px] font-mono text-zinc-500 hover:text-emerald-500 flex items-center gap-2 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  REFRESH
                </button>
                <button 
                  onClick={async () => {
                    if (confirm('Clear all monitors?')) {
                      await fetch('/api/monitors', { method: 'DELETE' });
                      fetchMonitors();
                    }
                  }}
                  className="text-[10px] font-mono text-zinc-500 hover:text-red-500 flex items-center gap-2 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  CLEAR ALL
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <AnimatePresence mode="popLayout">
                {monitors.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center py-20 bg-zinc-900/30 rounded-3xl border border-dashed border-white/10"
                  >
                    <Bell className="w-12 h-12 text-zinc-700 mx-auto mb-4" />
                    <p className="text-zinc-500">No active monitors. Create one to get started.</p>
                  </motion.div>
                ) : (
                  monitors.map((monitor) => (
                    <motion.div
                      key={monitor.id}
                      layout
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className={`group relative bg-zinc-900/50 border border-white/5 rounded-2xl p-6 transition-all hover:border-emerald-500/30 ${monitor.active ? '' : 'opacity-60 grayscale'}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-bold text-lg truncate">{monitor.market_name}</h3>
                            <a 
                              href={`https://polymarket.com/event/${monitor.market_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-zinc-500 hover:text-emerald-500 transition-colors"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          </div>
                          <div className="flex flex-wrap gap-3 mt-3">
                            <span className="text-[10px] font-mono bg-black px-2 py-1 rounded border border-white/10 text-zinc-400" title={monitor.market_id}>
                              ID: {monitor.market_id}
                            </span>
                            <span className={`text-[10px] font-mono px-2 py-1 rounded border ${monitor.condition === 'above' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'}`}>
                              IF {monitor.condition.toUpperCase()} {monitor.threshold}%
                            </span>
                            <span className="text-[10px] font-mono bg-black px-2 py-1 rounded border border-white/10 text-zinc-400 flex items-center gap-1">
                              <Mail className="w-3 h-3" /> {monitor.email}
                            </span>
                          </div>
                          
                          <div className="mt-4 pt-4 border-t border-white/5 flex flex-wrap gap-4 text-[10px] font-mono uppercase tracking-wider">
                            <div className="flex items-center gap-1.5">
                              <span className="text-zinc-500">Current:</span>
                              <span className={monitor.current_price !== null ? 'text-emerald-400 font-bold' : 'text-zinc-600'}>
                                {monitor.current_price !== null ? `${monitor.current_price.toFixed(2)}%` : 'Pending'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-zinc-500">Last Check:</span>
                              <span className="text-zinc-400">
                                {monitor.last_checked_at ? new Date(monitor.last_checked_at).toLocaleTimeString() : 'Never'}
                              </span>
                            </div>
                          </div>

                          {monitor.last_error && (
                            <div className="mt-3 p-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2">
                              <AlertCircle className="w-3 h-3 text-red-500 mt-0.5 shrink-0" />
                              <span className="text-[10px] text-red-400 leading-tight">{monitor.last_error}</span>
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => testMonitorEmail(monitor)}
                            disabled={testingEmail}
                            className={`p-2 rounded-xl border transition-all ${testingEmail ? 'opacity-50' : 'bg-zinc-800 border-white/10 text-zinc-400 hover:bg-zinc-700 hover:text-emerald-500'}`}
                            title="Send test alert to this email"
                          >
                            <Send className={`w-5 h-5 ${testingEmail ? 'animate-pulse' : ''}`} />
                          </button>
                          <button
                            onClick={() => runCheck()}
                            disabled={checking}
                            className={`p-2 rounded-xl border transition-all ${checking ? 'opacity-50 cursor-not-allowed' : 'bg-zinc-800 border-white/10 text-zinc-400 hover:bg-zinc-700 hover:text-emerald-500'}`}
                            title="Refresh now"
                          >
                            <RefreshCw className={`w-5 h-5 ${checking ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            onClick={() => toggleMonitor(monitor.id)}
                            className={`p-2 rounded-xl border transition-all ${monitor.active ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500 hover:bg-emerald-500/20' : 'bg-zinc-800 border-white/10 text-zinc-500 hover:bg-zinc-700'}`}
                            title={monitor.active ? "Deactivate" : "Activate"}
                          >
                            {monitor.active ? <Power className="w-5 h-5" /> : <PowerOff className="w-5 h-5" />}
                          </button>
                          <button
                            onClick={() => deleteMonitor(monitor.id)}
                            className="p-2 bg-red-500/10 border border-red-500/20 text-red-500 rounded-xl hover:bg-red-500/20 transition-all"
                            title="Delete"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>
                      </div>

                      {monitor.last_notified_value !== null && (
                        <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
                          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Last Notified Value</span>
                          <span className="text-sm font-bold text-emerald-500">{monitor.last_notified_value.toFixed(2)}%</span>
                        </div>
                      )}
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </main>

      <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-white/5 mt-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 text-zinc-600">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4" />
            <span className="text-xs font-mono">POLYMARKET MONITOR v1.0.0</span>
          </div>
          <p className="text-[10px] text-center md:text-right leading-relaxed max-w-md">
            This tool monitors Polymarket probabilities using the CLOB API. 
            Checks are performed every 5 minutes. Ensure your SMTP settings are correct for email delivery.
          </p>
        </div>
      </footer>
    </div>
  );
}
