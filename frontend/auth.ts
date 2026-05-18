'use client';
import { useEffect, useMemo, useState, useCallback, memo } from 'react';
import {
  LayoutDashboard, Brain, Sparkles, Users, TrendingUp,
  TrendingDown, Trophy, LineChart, ClipboardList, AlertTriangle,
} from 'lucide-react';
import DateRangePicker, { PRESETS, PRESET_LABELS } from './date-range-picker';
import SubjectMultiSelect, { applySubjectFilter } from './subject-multiselect';
import { fetchWithRetry } from '../lib/fetch-with-retry';

// Stable empty defaults — prevents new array/object literals being created on every
// render (which would defeat React.memo on children that receive these as props).
const EMPTY_ARRAY  = Object.freeze([]);
const EMPTY_OBJECT = Object.freeze({});

// ─────────────────────────── mappings ───────────────────────────
const SUBJECTS = {
  testbook_ugcnet: 'Common',
  pritipaper1: 'Paper 1 · Priti',
  tulikamam: 'Paper 1 · Tulika',
  anshikamaamtestbook: 'Paper 1 · Anshika',
  testbookrajatsir: 'Paper 1 · Rajat Sir',
  pradyumansir_testbook: 'Political Science',
  ashwanisir_testbook: 'History',
  kiranmaamtestbook: 'Public Administration',
  manojsonker_testbook: 'Sociology',
  heenamaam_testbook: 'Education',
  aditimaam_testbook: 'Home Science',
  karansir_testbook: 'Law',
  testbookdakshita: 'English',
  ashishsir_testbook: 'Geography',
  shachimaam_testbook: 'Economics',
  monikamaamtestbook: 'Management 1',
  yogitamaamtestbook: 'Management 2',
  evs_anshikamaamtestbook: 'Environmental Science',
  daminimaam_testbook: 'Library Science',
  testbookshahna: 'Computer Science',
  prakashsirtestbook: 'Sanskrit',
  kesharisir_testbook: 'Hindi',
  testbookniharikamaam: 'Commerce',
  mrinalinimaam_testbook: 'Psychology',
  testbook_gauravsir: 'Physical Education',
};

const POST_TYPE_COLORS = {
  'MCQ Poll': '#3b82f6', 'Poll': '#3b82f6', 'YouTube Class': '#dc2626',
  'Link': '#06b6d4', 'Photo': '#10b981', 'Document': '#10b981',
  'Video': '#dc2626', 'Audio': '#8b5cf6', 'Telegram Link': '#0ea5e9',
  'Message': '#64748b',
};

// ─────────────────────────── formatters ───────────────────────────
function fmtNum(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  if (n >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + 'L';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString('en-IN');
}
function fmtFull(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-IN');
}
function fmtPct(n, d = 1) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return n.toFixed(d) + '%';
}
function fmtSigned(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + fmtNum(n);
}
function fmtSignedFull(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + fmtFull(n);
}
function deltaPct(curr, prev) {
  if (curr === null || curr === undefined || prev === null || prev === undefined || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function aggregate(channels) {
  if (!channels || channels.length === 0) return null;
  let subs=0, joined=0, lost=0, posts=0, views=0, forwards=0, reactions=0;
  let withEng=0, engSum=0, withNotif=0, notifSum=0;
  for (const c of channels) {
    subs += c.subscribers || 0;
    joined += c.subsGained || 0;
    lost += c.subsLost || 0;
    posts += c.posts || 0;
    views += c.totalViews || 0;
    forwards += c.totalForwards || 0;
    reactions += c.totalReactions || 0;
    if (c.engagementRate !== null && c.engagementRate !== undefined) { withEng++; engSum += c.engagementRate; }
    if (c.notifPct !== null && c.notifPct !== undefined) { withNotif++; notifSum += c.notifPct; }
  }
  return {
    subs, joined, lost, net: joined - lost,
    posts, views, forwards, reactions,
    avgEng: withEng ? engSum / withEng : null,
    avgNotif: withNotif ? notifSum / withNotif : null,
  };
}

// ─────────────────────────── component ───────────────────────────
export default function OverviewSection() {
  const [range, setRange]                 = useState(() => ({ ...PRESETS.last30d(), preset: 'last30d' }));
  const [data, setData]                   = useState(null);
  const [lastFetched, setLastFetched]     = useState(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [filterSubjects, setFilterSubjects] = useState([]);

  const [briefing, setBriefing]           = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingError, setBriefingError] = useState(null);
  const [briefingGeneratedAt, setBriefingGeneratedAt] = useState(null);
  const [briefingHistory, setBriefingHistory] = useState([]); // array of cached briefings for this scope

  const [retryStatus, setRetryStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRetryStatus(null);
    fetchWithRetry(
      `/api/overview-metrics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      {},
      {
        onRetry: ({ attempt, status }) => {
          if (!cancelled) setRetryStatus(`Server warming up (attempt ${attempt + 1})…`);
        },
      },
    )
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (!d.ok) { setError(d.error || 'unknown'); setData(null); }
        else { setData(d); setError(null); setLastFetched(new Date().toISOString()); }
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) { setLoading(false); setRetryStatus(null); } });
    return () => { cancelled = true; };
  }, [range.from, range.to]);

  // When range or subject filter changes, look up cached briefing for this scope.
  // Compute the same filter_key the server uses: sorted CSV of subjects, or 'ALL' if none/all.
  const filterKeyForCache = useMemo(() => {
    if (!filterSubjects || filterSubjects.length === 0) return 'ALL';
    return [...filterSubjects].map((s) => String(s).trim()).filter(Boolean).sort().join('|') || 'ALL';
  }, [filterSubjects]);

  useEffect(() => {
    let cancelled = false;
    setBriefing(null);
    setBriefingError(null);
    setBriefingGeneratedAt(null);
    setBriefingHistory([]);

    const from = (range.from || '').slice(0, 10);
    const to   = (range.to   || '').slice(0, 10);
    if (!from || !to) return;

    // Latest cached briefing for this scope
    const latestUrl = `/api/portfolio-insights?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&filter_key=${encodeURIComponent(filterKeyForCache)}`;
    fetch(latestUrl)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.ok && j.cached) {
          setBriefing(j.cached);
          setBriefingGeneratedAt(j.generated_at);
        }
      })
      .catch(() => { /* silent — generate-on-demand still works */ });

    // History list for this scope
    fetch(latestUrl + '&history=1')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.ok && Array.isArray(j.history)) setBriefingHistory(j.history);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [range.from, range.to, filterKeyForCache]);

  // Subject options derived from current data
  const allSubjects = useMemo(() => {
    const set = new Set();
    (data?.current?.channels || []).forEach((c) => set.add(SUBJECTS[c.username] || c.username));
    return Array.from(set).sort();
  }, [data]);

  // Apply subject filter to all data slices
  const currChannels = useMemo(
    () => applySubjectFilter(data?.current?.channels, filterSubjects, SUBJECTS),
    [data, filterSubjects]
  );
  const priorChannels = useMemo(
    () => applySubjectFilter(data?.prior?.channels, filterSubjects, SUBJECTS),
    [data, filterSubjects]
  );
  const filteredTopPosts = useMemo(() => {
    if (!data?.topPosts) return [];
    if (filterSubjects.length === 0) return data.topPosts.slice(0, 5);
    if (filterSubjects.includes('__none__')) return [];
    return data.topPosts.filter((p) => {
      const subj = SUBJECTS[p.chatUsername] || p.chatUsername;
      return filterSubjects.includes(subj);
    }).slice(0, 5);
  }, [data, filterSubjects]);

  const aggCurr  = useMemo(() => aggregate(currChannels), [currChannels]);
  const aggPrior = useMemo(() => aggregate(priorChannels), [priorChannels]);

  // Top movers
  const sortedByNet = useMemo(() => {
    return [...(currChannels || [])]
      .filter((c) => c.subsNet !== null && c.subsNet !== undefined)
      .sort((a, b) => (b.subsNet || 0) - (a.subsNet || 0));
  }, [currChannels]);
  const topGainers = sortedByNet.slice(0, 5);
  const topLosers  = sortedByNet.slice(-5).reverse();

  const fetchBriefing = async () => {
    if (!currChannels?.length) return;
    setBriefingLoading(true);
    setBriefingError(null);
    try {
      const subjectsLabel = filterSubjects.length === 0 || filterSubjects.length === allSubjects.length
        ? 'All subjects' : filterSubjects.join(', ');
      const res = await fetchWithRetry('/api/portfolio-insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current:  { from: range.from, to: range.to, channels: currChannels },
          prior:    data?.prior ? { ...data.prior, channels: priorChannels } : null,
          topPosts: filteredTopPosts,
          range,
          subjectsLabel,
          filterSubjects,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setBriefing(json);
        setBriefingGeneratedAt(json.generatedAt || new Date().toISOString());
        // Refresh history list so the new briefing appears in the dropdown
        const histUrl = `/api/portfolio-insights?from=${encodeURIComponent((range.from || '').slice(0,10))}&to=${encodeURIComponent((range.to || '').slice(0,10))}&filter_key=${encodeURIComponent(filterKeyForCache)}&history=1`;
        fetch(histUrl).then((r) => r.json()).then((j) => {
          if (j.ok && Array.isArray(j.history)) setBriefingHistory(j.history);
        }).catch(() => {});
      }
      else setBriefingError(json.error || 'failed');
    } catch (e) { setBriefingError(e.message); }
    finally { setBriefingLoading(false); }
  };

  // Allow user to load a past briefing from the history dropdown
  const loadHistoricalBriefing = useCallback((historyEntry) => {
    if (!historyEntry?.briefing) return;
    setBriefing(historyEntry.briefing);
    setBriefingGeneratedAt(historyEntry.generated_at);
    setBriefingError(null);
  }, []);

  return (
    <div>
      <Header range={range} filterSubjects={filterSubjects} lastFetched={lastFetched} />

      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 12px', background: '#fff', border: '1px solid #e2e8f0',
        borderRadius: 10, marginBottom: 14,
      }}>
        <DateRangePicker value={range} onChange={setRange} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <SubjectMultiSelect
            options={allSubjects}
            value={filterSubjects}
            onChange={setFilterSubjects}
            label="Subjects"
          />
          <div role="status" aria-live="polite" style={{ fontSize: 12, color: retryStatus ? '#b45309' : '#64748b', whiteSpace: 'nowrap' }}>
            {retryStatus || (loading ? 'Loading…' : `${currChannels.filter((c) => (c.subscribers || 0) > 0).length} channels`)}
          </div>
        </div>
      </div>

      {error && (
        <ErrorBanner error={error} />
      )}

      {/* Executive Briefing */}
      <ExecutiveBriefing
        briefing={briefing}
        loading={briefingLoading}
        error={briefingError}
        onGenerate={fetchBriefing}
        hasData={!!aggCurr}
        generatedAt={briefingGeneratedAt}
        history={briefingHistory}
        onLoadHistorical={loadHistoricalBriefing}
      />

      {/* Hero KPIs */}
      {loading && !data ? (
        <HeroKPISkeletonStrip />
      ) : (
        <HeroKPIStrip current={aggCurr} prior={aggPrior} />
      )}

      {/* Total Subscribers Chart (full width) — moved above Daily Growth */}
      <div style={{ marginBottom: 14 }}>
        {loading && !data ? (
          <ChartSkeleton height={280} />
        ) : (
          <SubscribersChart
            growthByChannel={data?.growthByChannel || EMPTY_ARRAY}
            priorGrowthByChannel={data?.priorGrowthByChannel || EMPTY_ARRAY}
            priorRange={data?.priorRange || null}
            currentRange={range}
            channels={currChannels}
            subjects={SUBJECTS}
          />
        )}
      </div>

      {/* Daily Growth Chart + Top Movers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: 14, marginBottom: 14 }}>
        {loading && !data ? (
          <ChartSkeleton height={240} />
        ) : (
          <DailyGrowthChart
            dailyByChannel={data?.dailyByChannel || EMPTY_ARRAY}
            channels={currChannels}
            subjects={SUBJECTS}
          />
        )}
        {loading && !data ? (
          <TopMoversSkeleton />
        ) : (
          <TopMoversPanel
            topGainers={topGainers}
            topLosers={topLosers}
            topPosts={filteredTopPosts}
            subjects={SUBJECTS}
          />
        )}
      </div>

      {/* Recommended Actions */}
      <RecommendedActions briefing={briefing} />
    </div>
  );
}

// ─────────────────────────── skeleton primitives ───────────────────────────
const Skeleton = memo(function Skeleton({ width = '100%', height = 16, radius = 4, style = EMPTY_OBJECT }) {
  return (
    <div
      className="skeleton-shimmer"
      style={{
        width,
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
});

const HeroKPISkeletonStrip = memo(function HeroKPISkeletonStrip() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10, marginBottom: 14 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{
          background: 'white', borderRadius: 10, padding: '12px 14px',
          border: '1px solid #e2e8f0', minHeight: 78,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <Skeleton width="55%" height={10} />
          <Skeleton width="75%" height={22} style={{ marginTop: 4 }} />
          <Skeleton width="50%" height={11} style={{ marginTop: 2 }} />
        </div>
      ))}
    </div>
  );
});

const ChartSkeleton = memo(function ChartSkeleton({ height = 280, label }) {
  return (
    <div style={{ background: 'white', borderRadius: 10, border: '1px solid #e2e8f0', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <Skeleton width={180} height={14} />
        <Skeleton width={140} height={11} />
      </div>
      <div style={{ position: 'relative', height }}>
        {/* Faux Y-axis ticks */}
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 24, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} width={28} height={9} />)}
        </div>
        {/* Faux chart body */}
        <div style={{ position: 'absolute', left: 44, right: 8, top: 8, bottom: 28 }}>
          <Skeleton width="100%" height="100%" radius={6} />
        </div>
        {/* Faux X-axis ticks */}
        <div style={{ position: 'absolute', left: 44, right: 8, bottom: 0, display: 'flex', justifyContent: 'space-between' }}>
          {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} width={32} height={9} />)}
        </div>
      </div>
      {label && (
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8, textAlign: 'center' }}>{label}</div>
      )}
    </div>
  );
});

const TopMoversSkeleton = memo(function TopMoversSkeleton() {
  return (
    <div style={{ background: 'white', borderRadius: 10, border: '1px solid #e2e8f0', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {[0, 1].map((sec) => (
        <div key={sec}>
          <Skeleton width={120} height={11} style={{ marginBottom: 8 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', background: '#f8fafc', borderRadius: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                  <Skeleton width={14} height={11} />
                  <div style={{ flex: 1 }}>
                    <Skeleton width="60%" height={12} />
                    <Skeleton width="40%" height={10} style={{ marginTop: 3 }} />
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <Skeleton width={50} height={13} />
                  <Skeleton width={70} height={9} style={{ marginTop: 3 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});

// ─────────────────────────── sub-components ───────────────────────────

function Header({ range, filterSubjects, lastFetched }) {
  const filterLabel = (() => {
    if (!filterSubjects || filterSubjects.length === 0) return 'all subjects';
    if (filterSubjects.includes('__none__')) return 'no subjects';
    if (filterSubjects.length === 1) return `${filterSubjects[0]} only`;
    return `${filterSubjects.length} subjects`;
  })();
  const rangeLabel = (PRESET_LABELS.find((p) => p.key === range.preset)?.label) || 'Custom range';

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Re-render "updated X ago" every 30s
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const updatedAgo = lastFetched ? (() => {
    const secs = Math.max(0, Math.round((now - new Date(lastFetched).getTime()) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs}h ago`;
  })() : null;

  return (
    <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <LayoutDashboard size={22} strokeWidth={2.2} />
          Overview
        </h1>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
          Executive view · <strong style={{ color: '#475569' }}>{rangeLabel}</strong> · {filterLabel}
        </div>
      </div>
      {updatedAgo && (
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
          Updated {updatedAgo}
        </div>
      )}
    </div>
  );
}

function ErrorBanner({ error }) {
  return (
    <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
      <strong>Error:</strong> {error}
    </div>
  );
}

function ExecutiveBriefing({ briefing, loading, error, onGenerate, hasData, generatedAt, history, onLoadHistorical }) {
  const [showHistory, setShowHistory] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Format "x ago" — same pattern as Header
  const formatAgo = (iso) => {
    if (!iso) return null;
    const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  };

  const generatedAgo = formatAgo(generatedAt);
  const hasMultipleVersions = Array.isArray(history) && history.length > 1;

  return (
    <div style={{
      background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
      border: '1px solid #93c5fd',
      borderRadius: 12, padding: '14px 16px', marginBottom: 14,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: briefing || loading || error ? 10 : 0, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Brain size={18} strokeWidth={2.2} style={{ color: '#0c4a6e' }} />
          <strong style={{ fontSize: 14, color: '#0c4a6e' }}>Executive Briefing</strong>
          {generatedAgo && (
            <span style={{ fontSize: 11, color: '#075985', background: '#bae6fd', padding: '2px 8px', borderRadius: 10, fontWeight: 600 }} title={`Generated at ${new Date(generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`}>
              Generated {generatedAgo}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
          {hasMultipleVersions && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              aria-expanded={showHistory}
              aria-haspopup="menu"
              aria-controls="briefing-history-menu"
              style={{
                background: showHistory ? '#0c4a6e' : 'transparent',
                color: showHistory ? 'white' : '#0c4a6e',
                border: '1px solid #0c4a6e',
                padding: '5px 10px', borderRadius: 6, fontSize: 11,
                fontWeight: 600, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            >
              History ({history.length}) <span aria-hidden="true">{showHistory ? '▲' : '▼'}</span>
            </button>
          )}
          <button onClick={onGenerate} disabled={loading || !hasData} style={{
            background: loading ? '#94a3b8' : '#0c4a6e', color: 'white',
            border: 'none', padding: '5px 12px', borderRadius: 6, fontSize: 12,
            fontWeight: 600, cursor: loading || !hasData ? 'not-allowed' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {loading ? (
              'Analyzing…'
            ) : briefing ? (
              <>↻ Regenerate</>
            ) : (
              <><Sparkles size={13} strokeWidth={2.2} /> Generate briefing</>
            )}
          </button>
        </div>
      </div>

      {/* History dropdown — anchored to button */}
      {showHistory && hasMultipleVersions && (
        <div
          id="briefing-history-menu"
          role="menu"
          aria-label="Past briefings for this scope"
          onKeyDown={(e) => { if (e.key === 'Escape') setShowHistory(false); }}
          style={{
            position: 'absolute', top: 48, right: 16,
            background: 'white', border: '1px solid #cbd5e1', borderRadius: 8,
            boxShadow: '0 10px 30px rgba(0,0,0,0.12)', minWidth: 280, maxHeight: 360, overflowY: 'auto',
            zIndex: 30,
          }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #e2e8f0', fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Past briefings · this scope
          </div>
          {history.map((h, i) => {
            const isCurrent = h.generated_at === generatedAt;
            return (
              <button
                key={h.id || i}
                role="menuitem"
                aria-current={isCurrent ? 'true' : undefined}
                onClick={() => { onLoadHistorical?.(h); setShowHistory(false); }}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '10px 12px',
                  background: isCurrent ? '#f0f9ff' : 'transparent',
                  border: 'none', borderBottom: '1px solid #f1f5f9',
                  cursor: 'pointer', fontSize: 12, color: '#0f172a',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                }}
                onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
              >
                <div>
                  <div style={{ fontWeight: isCurrent ? 700 : 500 }}>{formatAgo(h.generated_at) || 'just now'}</div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                    {new Date(h.generated_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} IST
                  </div>
                </div>
                {isCurrent && <span style={{ fontSize: 9, fontWeight: 700, color: '#0c4a6e', background: '#bae6fd', padding: '2px 6px', borderRadius: 6 }}>SHOWING</span>}
              </button>
            );
          })}
        </div>
      )}

      {!briefing && !loading && !error && (
        <div style={{ fontSize: 13, color: '#075985', lineHeight: 1.6 }}>
          Get a leadership-style summary of network health, biggest wins, and biggest concerns — based on real Telegram data for the selected date range.
        </div>
      )}

      {loading && (
        <div style={{ fontSize: 12, color: '#075985' }}>Generating briefing from {fmtNum(25)} channel datasets… ~8s</div>
      )}

      {error && (
        <div style={{ background: '#fff', borderRadius: 6, padding: '10px 12px', fontSize: 12, color: '#991b1b' }}>
          <strong>Couldn't generate briefing:</strong> {error}
        </div>
      )}

      {briefing && (
        <div style={{ background: 'white', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: '#0f172a', lineHeight: 1.7 }}>
          {briefing.briefing}
        </div>
      )}
    </div>
  );
}

const HeroKPIStrip = memo(function HeroKPIStrip({ current, prior }) {
  if (!current) return null;
  // Threshold-based warnings. The shape: { metric: { lowBelow, message } }.
  // Currently only Avg Engagement has a defined "concerning" threshold based on
  // Telegram-channel industry norms (1% engagement = baseline for sub-100K channels).
  const items = [
    { label: 'Subscribers',   value: fmtNum(current.subs),    delta: deltaPct(current.subs, prior?.subs),    invert: false, tip: 'Total subscribers across selected channels (current)' },
    { label: 'Joined',        value: fmtNum(current.joined),  delta: deltaPct(current.joined, prior?.joined), invert: false, tip: 'New followers in the period — ground truth from Telegram broadcast stats' },
    { label: 'Left',          value: fmtNum(current.lost),    delta: deltaPct(current.lost, prior?.lost),    invert: true,  tip: 'Followers who left in the period. Lower is better — delta inverted (down arrow = improvement).' },
    { label: 'Net Growth',    value: fmtSigned(current.net),  delta: deltaPct(current.net, prior?.net),      invert: false, tip: 'Joined − Left during the period' },
    { label: 'Total Views',   value: fmtNum(current.views),   delta: deltaPct(current.views, prior?.views),  invert: false, tip: 'Total views across all posts in the period' },
    {
      label: 'Avg Engagement',
      value: fmtPct(current.avgEng, 2),
      delta: deltaPct(current.avgEng, prior?.avgEng),
      invert: false,
      tip: 'Mean engagement % across channels: (forwards+reactions+replies)/views. Industry baseline for Telegram channels under 100K subs is around 1–3%. Below 1% suggests content is not resonating.',
      // Warning: under 1%, show a subtle indicator
      warning: (current.avgEng != null && current.avgEng < 1) ? {
        message: 'Engagement below 1% industry baseline',
        severity: current.avgEng < 0.5 ? 'high' : 'medium',
      } : null,
    },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10, marginBottom: 14 }}>
      {items.map((it) => <HeroKPI key={it.label} {...it} />)}
    </div>
  );
});

const HeroKPI = memo(function HeroKPI({ label, value, delta, invert, tip, warning }) {
  const [showTip, setShowTip] = useState(false);
  // For "Left" we invert the color: down = good (green), up = bad (red)
  const isPositive = delta === null ? null : (invert ? delta < 0 : delta > 0);
  // 0.05 threshold so anything that rounds to 0.0% gets the neutral right-arrow,
  // not a colored up/down arrow over a 0.0% label (which was confusing).
  const isZero     = delta !== null && Math.abs(delta) < 0.05;
  const color = isZero ? '#94a3b8' : isPositive ? '#15803d' : '#dc2626';
  const arrow = isZero ? '→' : isPositive ? '↑' : '↓';

  // Warning styling: subtle yellow/red top border + small badge
  const warnAccent = warning
    ? (warning.severity === 'high' ? '#dc2626' : '#f59e0b')
    : null;
  const warnBg = warning
    ? (warning.severity === 'high' ? '#fef2f2' : '#fffbeb')
    : null;

  // Compose a full ARIA label so screen readers announce the card's full meaning
  // in one breath rather than reading individual visual fragments.
  const directionWord = isZero ? 'unchanged' : isPositive ? 'up' : 'down';
  const ariaLabel = (() => {
    const parts = [`${label}: ${value}`];
    if (delta != null) parts.push(`${directionWord} ${Math.abs(delta).toFixed(1)} percent versus prior period`);
    if (warning) parts.push(`warning: ${warning.message}`);
    return parts.join(', ');
  })();

  return (
    <div role="group" aria-label={ariaLabel} style={{
      background: warnBg || 'white', borderRadius: 10, padding: '12px 14px',
      border: warnAccent ? `1px solid ${warnAccent}55` : '1px solid #e2e8f0',
      borderTop: warnAccent ? `3px solid ${warnAccent}` : '1px solid #e2e8f0',
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
        <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
          {label}
          {warning && (
            <span title={warning.message} aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'help', color: warnAccent }}>
              <AlertTriangle size={11} strokeWidth={2.4} />
            </span>
          )}
        </div>
        {tip && (
          <div
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
            style={{
              width: 14, height: 14, borderRadius: '50%',
              background: '#e2e8f0', color: '#64748b',
              fontSize: 9, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'help', fontStyle: 'italic',
              fontFamily: 'Georgia, serif',
              flexShrink: 0,
            }}
          >i</div>
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', marginTop: 4, lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ marginTop: 4, fontSize: 11, fontWeight: 600, color }}>
        {delta === null ? <span style={{ color: '#94a3b8' }}>no prior data</span> : (
          <>{arrow} {Math.abs(delta).toFixed(1)}%{' '}
            <span
              style={{ color: '#94a3b8', fontWeight: 500, cursor: 'help', borderBottom: '1px dotted #cbd5e1' }}
              title="Comparison: same metric in the equal-length window immediately before the selected range (e.g. for Last 30d, prior = the 30 days before that)"
            >vs prior</span>
          </>
        )}
      </div>

      {showTip && tip && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          right: 0,
          background: '#0f172a',
          color: '#e2e8f0',
          padding: '8px 10px',
          borderRadius: 6,
          fontSize: 11,
          lineHeight: 1.5,
          width: 240,
          boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
          zIndex: 20,
          pointerEvents: 'none',
          fontWeight: 400,
          letterSpacing: 'normal',
          textTransform: 'none',
        }}>
          {tip}
        </div>
      )}
    </div>
  );
});


// ─────────────────────────── Network Growth Chart (auto daily/monthly) ───────────────────────────
const DailyGrowthChart = memo(function DailyGrowthChart({ dailyByChannel, channels, subjects }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const allowedSet = useMemo(() => new Set((channels || []).map((c) => c.username)), [channels]);

  // Filter rows to allowed channels first
  const filteredRows = useMemo(
    () => (dailyByChannel || []).filter((r) => allowedSet.has(r.channel)),
    [dailyByChannel, allowedSet]
  );

  // Determine bucket granularity from data span
  const dateSet = useMemo(() => {
    const s = new Set();
    filteredRows.forEach((r) => s.add(r.date));
    return Array.from(s).sort();
  }, [filteredRows]);

  // > 60 distinct days = bucket by month, else by day
  const bucketBy = dateSet.length > 60 ? 'month' : 'day';

  // Aggregate into buckets
  const buckets = useMemo(() => {
    const map = new Map();
    for (const row of filteredRows) {
      const key = bucketBy === 'month' ? row.date.slice(0, 7) : row.date;
      let b = map.get(key);
      if (!b) {
        b = { key, dates: new Set(), joined: 0, left: 0, byChannel: new Map() };
        map.set(key, b);
      }
      b.dates.add(row.date);
      b.joined += row.joined || 0;
      b.left   += row.left || 0;
      const cs = b.byChannel.get(row.channel) || { joined: 0, left: 0 };
      cs.joined += row.joined || 0;
      cs.left   += row.left || 0;
      b.byChannel.set(row.channel, cs);
    }
    return Array.from(map.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((b) => ({
        key: b.key,
        days: b.dates.size,
        joined: b.joined,
        left: b.left,
        byChannel: Array.from(b.byChannel.entries()).map(([ch, st]) => ({
          channel: ch, joined: st.joined, left: st.left,
        })),
      }));
  }, [filteredRows, bucketBy]);

  const totalJoined = buckets.reduce((s, b) => s + b.joined, 0);
  const totalLeft   = buckets.reduce((s, b) => s + b.left, 0);
  const totalNet    = totalJoined - totalLeft;
  const latestDate  = dateSet[dateSet.length - 1] || null;

  // Moving avg (7 buckets)
  const movingAvg = useMemo(() => {
    return buckets.map((_, i) => {
      const window = buckets.slice(Math.max(0, i - 6), i + 1);
      const sum = window.reduce((s, b) => s + (b.joined - b.left), 0);
      return sum / window.length;
    });
  }, [buckets]);

  if (buckets.length === 0) {
    return (
      <div style={{ background: 'white', borderRadius: 10, border: '1px solid #e2e8f0', padding: 18 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#0f172a', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <LineChart size={15} strokeWidth={2.2} />
          Network Growth
        </h3>
        <div style={{ marginTop: 40, color: '#94a3b8', fontSize: 13, textAlign: 'center' }}>
          No follower data in this range.
        </div>
      </div>
    );
  }

  const W = 560, H = 320, PAD_L = 50, PAD_R = 16, PAD_T = 20, PAD_B = 40;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const maxJoined = Math.max(...buckets.map((b) => b.joined), 1);
  const maxLeft   = Math.max(...buckets.map((b) => b.left), 1);
  const yMax = Math.max(maxJoined, maxLeft);
  const niceMax = Math.pow(10, Math.floor(Math.log10(yMax))) * Math.ceil(yMax / Math.pow(10, Math.floor(Math.log10(yMax))));

  const yScale = (v) => PAD_T + chartH / 2 - (v / niceMax) * (chartH / 2);
  const xScale = (i) => PAD_L + (chartW / buckets.length) * (i + 0.5);
  const barW = Math.min(38, Math.max(3, (chartW / buckets.length) * 0.7));

  const yTicks = [niceMax, niceMax / 2, 0, -niceMax / 2, -niceMax];

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const formatBucket = (key) => {
    if (bucketBy === 'month') {
      const [y, m] = key.split('-');
      return `${MONTH_NAMES[parseInt(m,10) - 1]} ${y.slice(2)}`;
    }
    const [y, m, d] = key.split('-');
    return `${MONTH_NAMES[parseInt(m,10) - 1]} ${parseInt(d, 10)}`;
  };

  const xLabelStride = Math.max(1, Math.floor((buckets.length - 1) / 5));

  const hovered = hoverIdx !== null ? buckets[hoverIdx] : null;
  const hoveredTopChannels = hovered ? [...hovered.byChannel]
    .sort((a, b) => (b.joined - b.left) - (a.joined - a.left)).slice(0, 3) : [];

  const maLinePoints = buckets.map((_, i) => `${xScale(i)},${yScale(movingAvg[i])}`).join(' ');

  const bucketLabel = bucketBy === 'month' ? 'monthly' : 'daily';
  const maLabel = bucketBy === 'month' ? '7-mo avg' : '7-day avg';

  return (
    <div style={{ background: 'white', borderRadius: 10, border: '1px solid #e2e8f0', padding: 16, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <LineChart size={15} strokeWidth={2.2} />
            Network Growth
            <span style={{ color: '#94a3b8', fontWeight: 500, fontSize: 11 }}>({bucketLabel})</span>
          </span>
        </h3>
        <div style={{ fontSize: 11, color: '#64748b' }}>
          <span style={{ color: '#15803d', fontWeight: 700 }}>+{fmtNum(totalJoined)} Joined</span>
          {' · '}
          <span style={{ color: '#dc2626', fontWeight: 700 }}>-{fmtNum(totalLeft)} Left</span>
          {' · '}
          <span style={{ color: totalNet >= 0 ? '#15803d' : '#dc2626', fontWeight: 800 }}>
            Net {fmtSigned(totalNet)}
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible' }}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} y1={yScale(t)} x2={W - PAD_R} y2={yScale(t)}
              stroke={t === 0 ? '#cbd5e1' : '#f1f5f9'} strokeWidth="1" />
            <text x={PAD_L - 6} y={yScale(t) + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
              {t > 0 ? '+' : ''}{fmtNum(t)}
            </text>
          </g>
        ))}

        {buckets.map((b, i) => {
          const isHover = hoverIdx === i;
          return (
            <g key={b.key}
               onMouseEnter={() => setHoverIdx(i)}
               onMouseLeave={() => setHoverIdx(null)}
               style={{ cursor: 'pointer' }}
            >
              <rect x={xScale(i) - (chartW / buckets.length) / 2} y={PAD_T}
                width={chartW / buckets.length} height={chartH}
                fill="transparent" />

              <rect x={xScale(i) - barW / 2} y={yScale(b.joined)}
                width={barW} height={yScale(0) - yScale(b.joined)}
                fill={isHover ? '#15803d' : '#22c55e'} rx="1" />

              <rect x={xScale(i) - barW / 2} y={yScale(0)}
                width={barW} height={yScale(-b.left) - yScale(0)}
                fill={isHover ? '#b91c1c' : '#ef4444'} rx="1" opacity="0.85" />
            </g>
          );
        })}

        <polyline points={maLinePoints} fill="none" stroke="#0f172a" strokeWidth="2" opacity="0.7" />

        {buckets.map((b, i) => {
          if (i % xLabelStride !== 0) return null;
          return (
            <text key={b.key} x={xScale(i)} y={H - PAD_B + 14}
              textAnchor="middle" fontSize="10" fill="#64748b">
              {formatBucket(b.key)}
            </text>
          );
        })}

        {hovered !== null && (
          <line x1={xScale(hoverIdx)} y1={PAD_T} x2={xScale(hoverIdx)} y2={H - PAD_B}
            stroke="#0f172a" strokeWidth="1" strokeDasharray="2,3" opacity="0.3" pointerEvents="none" />
        )}
      </svg>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', fontSize: 11, color: '#475569', marginTop: 4 }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#22c55e', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />Joined</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#ef4444', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />Left</span>
        <span><span style={{ display: 'inline-block', width: 14, height: 2, background: '#0f172a', marginRight: 4, verticalAlign: 'middle', opacity: 0.7 }} />{maLabel} net</span>
      </div>

      {hovered && (
        <div style={{
          position: 'absolute', top: 60, right: 24,
          background: '#0f172a', color: 'white',
          padding: '10px 12px', borderRadius: 8, fontSize: 11, minWidth: 200,
          boxShadow: '0 4px 14px rgba(0,0,0,0.18)', pointerEvents: 'none', zIndex: 5,
        }}>
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
            {bucketBy === 'month'
              ? (() => {
                  const [y, m] = hovered.key.split('-');
                  return `${MONTH_NAMES[parseInt(m,10) - 1]} ${y} · ${hovered.days} days`;
                })()
              : new Date(hovered.key + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' })
            }
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px' }}>
            <span style={{ color: '#86efac' }}>Joined</span>
            <span style={{ fontWeight: 700, textAlign: 'right' }}>+{fmtFull(hovered.joined)}</span>
            <span style={{ color: '#fca5a5' }}>Left</span>
            <span style={{ fontWeight: 700, textAlign: 'right' }}>-{fmtFull(hovered.left)}</span>
            <span style={{ color: '#cbd5e1', borderTop: '1px solid #334155', paddingTop: 3 }}>Net</span>
            <span style={{ fontWeight: 800, textAlign: 'right', borderTop: '1px solid #334155', paddingTop: 3,
              color: (hovered.joined - hovered.left) >= 0 ? '#86efac' : '#fca5a5' }}>
              {fmtSignedFull(hovered.joined - hovered.left)}
            </span>
          </div>
          {hoveredTopChannels.length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #334155' }}>
              <div style={{ color: '#94a3b8', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 3 }}>
                TOP CONTRIBUTORS
              </div>
              {hoveredTopChannels.map((c) => {
                const net = c.joined - c.left;
                return (
                  <div key={c.channel} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10 }}>
                    <span style={{ color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {subjects[c.channel] || c.channel}
                    </span>
                    <span style={{ color: net >= 0 ? '#86efac' : '#fca5a5', fontWeight: 700 }}>
                      {fmtSignedFull(net)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, lineHeight: 1.5, textAlign: 'center' }}>
        Hover bars for {bucketBy === 'month' ? 'monthly' : 'daily'} detail · Latest data: {latestDate || 'n/a'} <span style={{ color: '#cbd5e1' }}>(Telegram&apos;s follower data lags 1 day)</span>
      </div>
    </div>
  );
});

// ─────────────────────────── Subscribers Chart (total subs over time, line/area) ───────────────────────────
const SubscribersChart = memo(function SubscribersChart({ growthByChannel, priorGrowthByChannel = EMPTY_ARRAY, priorRange = null, currentRange = null, channels, subjects }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  // Comparison-overlay toggle. Off by default — keeps the chart simple for first-time viewers.
  const [showCompare, setShowCompare] = useState(false);

  const allowedSet = useMemo(() => new Set((channels || []).map((c) => c.username)), [channels]);

  // Filter rows by selected subjects
  const filteredRows = useMemo(
    () => (growthByChannel || []).filter((r) => allowedSet.has(r.channel)),
    [growthByChannel, allowedSet]
  );
  // Same filter for prior period
  const filteredPriorRows = useMemo(
    () => (priorGrowthByChannel || []).filter((r) => allowedSet.has(r.channel)),
    [priorGrowthByChannel, allowedSet]
  );

  // Aggregate: sum total_subs across allowed channels per date
  const dailySeriesRaw = useMemo(() => {
    const map = new Map(); // date → { total, channelSubs: {channel:total} }
    for (const row of filteredRows) {
      let b = map.get(row.date);
      if (!b) { b = { date: row.date, total: 0, channelSubs: {} }; map.set(row.date, b); }
      b.total += row.total || 0;
      b.channelSubs[row.channel] = row.total || 0;
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredRows]);

  // Append today's LIVE data point if growthGraph hasn't caught up yet.
  // Telegram's growthGraph lags ~1 day, so today's row only lands after the next snapshot.
  // We use live subscriber counts (channels[].subscribers) to plot today as a "live" point.
  // Only append if the user is actually viewing a range that reaches near today
  // (otherwise a custom range like "Apr 1-15" would get a spurious May 18 point).
  const dailySeries = useMemo(() => {
    if (dailySeriesRaw.length === 0) return dailySeriesRaw;
    const todayIst = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
    const lastDate = dailySeriesRaw[dailySeriesRaw.length - 1].date;
    if (lastDate >= todayIst) return dailySeriesRaw; // already have today (or future, shouldn't happen)

    // Only inject if the latest history is within ~3 days of today
    // (avoids polluting historical-range views with today's point)
    const daysGap = Math.round((new Date(`${todayIst}T00:00:00Z`) - new Date(`${lastDate}T00:00:00Z`)) / 86400000);
    if (daysGap > 3) return dailySeriesRaw;

    // Yesterday's channel-level snapshot — used to compute per-channel deltas for the live point
    const yesterdayChannelSubs = dailySeriesRaw[dailySeriesRaw.length - 1].channelSubs || {};

    // Sum live counts from the filtered allowed channels only (mirrors filteredRows logic)
    const liveChannelSubs = {};
    const liveChannelDeltas = {}; // per-channel: live − yesterday
    let liveTotal = 0;
    for (const c of (channels || [])) {
      if (!allowedSet.has(c.username)) continue;
      const subs = c.subscribers ?? 0;
      if (subs <= 0) continue;
      liveChannelSubs[c.username] = subs;
      liveChannelDeltas[c.username] = subs - (yesterdayChannelSubs[c.username] || 0);
      liveTotal += subs;
    }
    // Don't fabricate a point if we have no live data
    if (liveTotal === 0) return dailySeriesRaw;

    return [
      ...dailySeriesRaw,
      { date: todayIst, total: liveTotal, channelSubs: liveChannelSubs, channelDeltas: liveChannelDeltas, isLive: true },
    ];
  }, [dailySeriesRaw, channels, allowedSet]);

  // Aggregate prior period: same shape as dailySeriesRaw but using prior dates
  const priorDailySeriesRaw = useMemo(() => {
    const map = new Map();
    for (const row of filteredPriorRows) {
      let b = map.get(row.date);
      if (!b) { b = { date: row.date, total: 0 }; map.set(row.date, b); }
      b.total += row.total || 0;
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredPriorRows]);

  // Aligned prior series: re-map prior dates onto the current period's day index.
  // Day 0 of prior = priorRange.from; Day 0 of current = currentRange.from.
  // To overlay them on the same x-axis we shift prior dates forward by the period offset.
  const priorAlignedByDate = useMemo(() => {
    if (!showCompare || !priorRange || !currentRange || priorDailySeriesRaw.length === 0) return {};
    const priorStartMs   = new Date(priorRange.from).getTime();
    const currentStartMs = new Date(currentRange.from).getTime();
    const offsetMs = currentStartMs - priorStartMs; // positive — shift prior dates forward to current
    const out = {};
    for (const p of priorDailySeriesRaw) {
      const aligned = new Date(new Date(p.date + 'T00:00:00Z').getTime() + offsetMs);
      const alignedStr = aligned.toISOString().slice(0, 10);
      out[alignedStr] = p.total;
    }
    return out;
  }, [showCompare, priorRange, currentRange, priorDailySeriesRaw]);

  // For tooltip: also expose prior raw-date lookup so we can show "vs Apr 18 (prior)" date
  const priorRawByAlignedDate = useMemo(() => {
    if (!showCompare || !priorRange || !currentRange || priorDailySeriesRaw.length === 0) return {};
    const priorStartMs   = new Date(priorRange.from).getTime();
    const currentStartMs = new Date(currentRange.from).getTime();
    const offsetMs = currentStartMs - priorStartMs;
    const out = {};
    for (const p of priorDailySeriesRaw) {
      const aligned = new Date(new Date(p.date + 'T00:00:00Z').getTime() + offsetMs);
      out[aligned.toISOString().slice(0, 10)] = p.date;
    }
    return out;
  }, [showCompare, priorRange, currentRange, priorDailySeriesRaw]);

  if (dailySeries.length === 0) {
    return (
      <div style={{ background: 'white', borderRadius: 10, border: '1px solid #e2e8f0', padding: 18 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#0f172a', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Users size={15} strokeWidth={2.2} />
          Total Subscribers
        </h3>
        <div style={{ marginTop: 40, color: '#94a3b8', fontSize: 13, textAlign: 'center' }}>
          No subscriber data in this range.
        </div>
      </div>
    );
  }

  const startSubs = dailySeries[0].total;
  const endSubs   = dailySeries[dailySeries.length - 1].total;
  const netChange = endSubs - startSubs;
  const pctChange = startSubs > 0 ? (netChange / startSubs) * 100 : 0;

  const W = 1100, H = 280, PAD_L = 56, PAD_R = 16, PAD_T = 20, PAD_B = 36;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  // Y-scale: don't start at 0 — start at floor(min * 0.95) so the line has visible slope
  const allTotals = dailySeries.map((d) => d.total);
  // Include prior-aligned values in y-scale calculation so the second line isn't clipped
  const priorVisibleTotals = Object.values(priorAlignedByDate);
  const yScaleSource = [...allTotals, ...priorVisibleTotals];
  const dataMin = Math.min(...yScaleSource);
  const dataMax = Math.max(...yScaleSource);
  // Pad min/max so line doesn't touch edges
  const yPad = Math.max(1, (dataMax - dataMin) * 0.1);
  const yMin = Math.max(0, Math.floor((dataMin - yPad) / 100) * 100);
  const yMax = Math.ceil((dataMax + yPad) / 100) * 100;

  const xScale = (i) => PAD_L + (chartW / Math.max(1, dailySeries.length - 1)) * i;
  const yScale = (v) => PAD_T + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  // Build polyline + area path
  const linePoints = dailySeries.map((d, i) => `${xScale(i)},${yScale(d.total)}`).join(' ');
  // Prior line: same x positions as current, but y from priorAlignedByDate. Days
  // without a prior value get skipped (gaps in the line).
  const priorLineSegments = useMemo(() => {
    if (!showCompare) return [];
    const segs = [];
    let curr = [];
    for (let i = 0; i < dailySeries.length; i++) {
      const v = priorAlignedByDate[dailySeries[i].date];
      if (v != null && v > 0) {
        curr.push(`${xScale(i)},${yScale(v)}`);
      } else if (curr.length > 0) {
        segs.push(curr.join(' '));
        curr = [];
      }
    }
    if (curr.length > 0) segs.push(curr.join(' '));
    return segs;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCompare, priorAlignedByDate, dailySeries.length, yMin, yMax]);
  const areaPath = `M ${PAD_L},${yScale(yMin)} ` +
                   dailySeries.map((d, i) => `L ${xScale(i)},${yScale(d.total)}`).join(' ') +
                   ` L ${xScale(dailySeries.length - 1)},${yScale(yMin)} Z`;

  // Y ticks: 4 evenly-spaced values between yMin and yMax
  const yTicks = [yMin, yMin + (yMax - yMin) * 0.33, yMin + (yMax - yMin) * 0.67, yMax].map((v) => Math.round(v));

  // X labels: ~6 evenly spaced
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const formatDate = (dateStr) => {
    const [y, m, d] = dateStr.split('-');
    return `${MONTH_NAMES[parseInt(m,10) - 1]} ${parseInt(d, 10)}`;
  };
  const xLabelStride = Math.max(1, Math.floor((dailySeries.length - 1) / 6));

  const hovered = hoverIdx !== null ? dailySeries[hoverIdx] : null;
  const hoveredTopChannels = hovered
    ? Object.entries(hovered.channelSubs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
    : [];

  // Δ from the chart's leftmost data point (shown as "Since {date}")
  const hoveredDelta = hovered ? hovered.total - startSubs : 0;

  // Anchor-flip tooltip when hovering rightmost data points so it doesn't obscure them
  const tooltipFlipLeft = hovered && hoverIdx !== null && (hoverIdx / Math.max(1, dailySeries.length - 1)) > 0.65;

  // Find SVG x position from mouse
  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    if (svgX < PAD_L || svgX > W - PAD_R) { setHoverIdx(null); return; }
    const idx = Math.round(((svgX - PAD_L) / chartW) * (dailySeries.length - 1));
    if (idx >= 0 && idx < dailySeries.length) setHoverIdx(idx);
  };

  return (
    <div style={{ background: 'white', borderRadius: 10, border: '1px solid #e2e8f0', padding: 16, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Users size={15} strokeWidth={2.2} />
            Total Subscribers
            <span style={{ color: '#94a3b8', fontWeight: 500, fontSize: 11 }}>(cumulative)</span>
          </span>
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Compare-to-prior toggle */}
          {priorRange && priorDailySeriesRaw.length > 0 && (
            <button
              onClick={() => setShowCompare((v) => !v)}
              title={showCompare ? 'Hide prior period overlay' : `Overlay the equivalent prior period (${new Date(priorRange.from).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${new Date(priorRange.to).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontSize: 11, fontWeight: 600,
                background: showCompare ? '#0f172a' : 'white',
                color: showCompare ? 'white' : '#475569',
                border: '1px solid ' + (showCompare ? '#0f172a' : '#cbd5e1'),
                borderRadius: 6, padding: '4px 10px',
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'inline-block', width: 12, height: 0, borderTop: '2px dashed #94a3b8', marginRight: 2 }} />
              Compare prior period
            </button>
          )}
          <div style={{ fontSize: 11, color: '#64748b' }}>
            <span style={{ fontWeight: 700, color: '#0f172a' }}>{fmtNum(startSubs)}</span>
            {' → '}
            <span style={{ fontWeight: 700, color: '#0f172a' }}>{fmtNum(endSubs)}</span>
            {' · '}
            <span style={{ fontWeight: 800, color: netChange >= 0 ? '#15803d' : '#dc2626' }}>
              {fmtSigned(netChange)} ({pctChange >= 0 ? '+' : ''}{pctChange.toFixed(1)}%)
            </span>
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: 'block', overflow: 'visible' }}
        role="img"
        aria-label={`Total subscribers chart: ${fmtNum(startSubs)} on ${dailySeries[0].date} to ${fmtNum(endSubs)} on ${dailySeries[dailySeries.length - 1].date}, ${netChange >= 0 ? 'up' : 'down'} ${Math.abs(netChange).toLocaleString('en-IN')} subscribers (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(1)}%). Use left and right arrow keys to inspect daily values.`}
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        onFocus={() => { if (hoverIdx === null) setHoverIdx(dailySeries.length - 1); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setHoverIdx((i) => Math.max(0, (i ?? dailySeries.length - 1) - 1));
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setHoverIdx((i) => Math.min(dailySeries.length - 1, (i ?? 0) + 1));
          } else if (e.key === 'Home') {
            e.preventDefault();
            setHoverIdx(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            setHoverIdx(dailySeries.length - 1);
          } else if (e.key === 'Escape') {
            setHoverIdx(null);
            e.currentTarget.blur();
          }
        }}
      >
        {/* Y gridlines + labels */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} y1={yScale(t)} x2={W - PAD_R} y2={yScale(t)} stroke="#f1f5f9" strokeWidth="1" />
            <text x={PAD_L - 8} y={yScale(t) + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
              {fmtNum(t)}
            </text>
          </g>
        ))}

        {/* Area fill */}
        <path d={areaPath} fill="#3b82f6" fillOpacity="0.12" />

        {/* Prior period overlay (drawn before current so current renders on top) */}
        {showCompare && priorLineSegments.map((seg, i) => (
          <polyline
            key={`prior-${i}`}
            points={seg}
            fill="none"
            stroke="#94a3b8"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeDasharray="5,4"
            opacity="0.85"
          />
        ))}

        {/* Line — split into historical (solid) + live extension (dashed) if we have a live point */}
        {(() => {
          const hasLive = dailySeries.length > 0 && dailySeries[dailySeries.length - 1].isLive;
          if (!hasLive) {
            return <polyline points={linePoints} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinejoin="round" />;
          }
          // Historical: all but last point. Live: last 2 points (joined by dashed segment).
          const histPoints = dailySeries.slice(0, -1).map((d, i) => `${xScale(i)},${yScale(d.total)}`).join(' ');
          const lastI = dailySeries.length - 1;
          const liveSegment = `${xScale(lastI - 1)},${yScale(dailySeries[lastI - 1].total)} ${xScale(lastI)},${yScale(dailySeries[lastI].total)}`;
          return (
            <>
              <polyline points={histPoints}  fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinejoin="round" />
              <polyline points={liveSegment} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinejoin="round" strokeDasharray="6,4" opacity="0.7" />
              {/* Permanent dot on the live point so it's clearly visible */}
              <circle cx={xScale(lastI)} cy={yScale(dailySeries[lastI].total)} r="4.5"
                fill="#3b82f6" stroke="white" strokeWidth="2" />
              {/* "live" label above the dot */}
              <text x={xScale(lastI)} y={yScale(dailySeries[lastI].total) - 12} textAnchor="middle"
                fontSize="9" fontWeight="700" fill="#3b82f6">LIVE</text>
            </>
          );
        })()}

        {/* X labels */}
        {dailySeries.map((d, i) => {
          if (i % xLabelStride !== 0) return null;
          return (
            <text key={d.date} x={xScale(i)} y={H - PAD_B + 14} textAnchor="middle" fontSize="10" fill="#64748b">
              {formatDate(d.date)}
            </text>
          );
        })}

        {/* Hover indicator: vertical line + dot */}
        {hovered !== null && (
          <>
            <line x1={xScale(hoverIdx)} y1={PAD_T} x2={xScale(hoverIdx)} y2={H - PAD_B}
              stroke="#0f172a" strokeWidth="1" strokeDasharray="3,3" opacity="0.4" pointerEvents="none" />
            <circle cx={xScale(hoverIdx)} cy={yScale(hovered.total)} r="5"
              fill="#3b82f6" stroke="white" strokeWidth="2" pointerEvents="none" />
          </>
        )}
      </svg>

      {hovered && (
        <div style={{
          position: 'absolute', top: 60,
          ...(tooltipFlipLeft ? { left: 24 } : { right: 24 }),
          background: '#0f172a', color: 'white',
          padding: '10px 12px', borderRadius: 8, fontSize: 11, minWidth: 240, maxWidth: 280,
          boxShadow: '0 4px 14px rgba(0,0,0,0.18)', pointerEvents: 'none', zIndex: 5,
        }}>
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: hovered.isLive ? 2 : 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{new Date(hovered.date + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' })}</span>
            {hovered.isLive && (
              <span style={{ background: '#3b82f6', color: 'white', padding: '1px 6px', borderRadius: 8, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em' }}>
                LIVE
              </span>
            )}
          </div>
          {hovered.isLive && (
            <div style={{ fontSize: 9, color: '#94a3b8', marginBottom: 6, lineHeight: 1.4 }}>
              Live snapshot · today's data not yet on Telegram's growthGraph (~1 day lag)
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px' }}>
            <span style={{ color: '#cbd5e1' }}>Total subs</span>
            <span style={{ fontWeight: 800, textAlign: 'right' }}>{fmtFull(hovered.total)}</span>
            <span style={{ color: '#cbd5e1' }}>Since {new Date(dailySeries[0].date + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
            <span style={{ fontWeight: 700, textAlign: 'right', color: hoveredDelta >= 0 ? '#86efac' : '#fca5a5' }}>
              {fmtSignedFull(hoveredDelta)}
            </span>
            {showCompare && priorAlignedByDate[hovered.date] != null && (() => {
              const priorVal = priorAlignedByDate[hovered.date];
              const priorOriginalDate = priorRawByAlignedDate[hovered.date];
              const diff = hovered.total - priorVal;
              const diffPct = priorVal > 0 ? (diff / priorVal) * 100 : 0;
              return (
                <>
                  <span style={{ color: '#94a3b8', borderTop: '1px solid #334155', paddingTop: 4, marginTop: 2 }}>
                    Prior · {priorOriginalDate ? new Date(priorOriginalDate + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}
                  </span>
                  <span style={{ color: '#cbd5e1', textAlign: 'right', borderTop: '1px solid #334155', paddingTop: 4, marginTop: 2 }}>
                    {fmtFull(priorVal)}
                  </span>
                  <span style={{ color: '#94a3b8', fontSize: 10 }}>vs prior</span>
                  <span style={{ textAlign: 'right', color: diff >= 0 ? '#86efac' : '#fca5a5', fontWeight: 700, fontSize: 10 }}>
                    {fmtSignedFull(diff)} ({diffPct >= 0 ? '+' : ''}{diffPct.toFixed(1)}%)
                  </span>
                </>
              );
            })()}
          </div>
          {hoveredTopChannels.length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #334155' }}>
              <div style={{ color: '#94a3b8', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 3 }}>
                TOP CHANNELS (by subs){hovered.isLive ? ' · Δ since yesterday' : ''}
              </div>
              {hoveredTopChannels.map(([ch, total]) => {
                const delta = hovered.channelDeltas ? hovered.channelDeltas[ch] : null;
                return (
                  <div key={ch} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10 }}>
                    <span style={{ color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {subjects[ch] || ch}
                    </span>
                    <span style={{ color: '#cbd5e1', fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {fmtFull(total)}
                      {delta != null && (
                        <span style={{ marginLeft: 4, color: delta > 0 ? '#86efac' : delta < 0 ? '#fca5a5' : '#64748b', fontSize: 9, fontWeight: 600 }}>
                          {delta > 0 ? '▲' : delta < 0 ? '▼' : '='} {delta === 0 ? '0' : (delta > 0 ? '+' : '') + delta.toLocaleString('en-IN')}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showCompare && priorRange && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 18, fontSize: 11, color: '#475569', marginTop: 4 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 18, height: 2, background: '#3b82f6' }} />
            Current period
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2px dashed #94a3b8' }} />
            Prior · {new Date(priorRange.from).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – {new Date(priorRange.to).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
          </span>
        </div>
      )}

      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, lineHeight: 1.5, textAlign: 'center' }}>
        Move mouse across chart or use arrow keys for daily detail · Y-axis zoomed to show slope · Data: Telegram broadcast stats (growthGraph)
      </div>

      {/* Screen-reader live region: announces values when keyboard-navigating through the chart */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {hovered ? `${hovered.date}: ${fmtFull(hovered.total)} total subscribers, ${hoveredDelta >= 0 ? 'up' : 'down'} ${Math.abs(hoveredDelta).toLocaleString('en-IN')} since period start${hovered.isLive ? ' (live)' : ''}.` : ''}
      </div>
    </div>
  );
});

// ─────────────────────────── Top Movers Panel ───────────────────────────
const TopMoversPanel = memo(function TopMoversPanel({ topGainers, topLosers, topPosts, subjects }) {
  return (
    <div style={{ background: 'white', borderRadius: 10, border: '1px solid #e2e8f0', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <MoverList title={<><TrendingUp size={12} strokeWidth={2.4} style={{ color: '#15803d' }} /> Top Gainers</>} items={topGainers} subjects={subjects} type="gainer" />
      <MoverList title={<><TrendingDown size={12} strokeWidth={2.4} style={{ color: '#dc2626' }} /> Largest Losses</>} items={topLosers} subjects={subjects} type="loser" />
      <TopPostsList posts={topPosts} subjects={subjects} />
    </div>
  );
});

const MoverList = memo(function MoverList({ title, items, subjects, type }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: '0.04em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 5 }}>{title}</div>
        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 600 }} title="Format: Net change · Joined / Left for the selected range">
          Net · Joined / Left
        </div>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>—</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map((c, i) => {
            const subj = subjects[c.username] || c.username;
            const isPositive = (c.subsNet || 0) > 0;
            const isHover = hoverIdx === i;
            return (
              <a
                key={c.username}
                href={`https://t.me/${c.username}`}
                target="_blank"
                rel="noopener noreferrer"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 8px', borderRadius: 6,
                  background: isHover ? '#f1f5f9' : '#f8fafc',
                  textDecoration: 'none', color: '#0f172a',
                  transition: 'background 0.1s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ color: '#94a3b8', fontSize: 11, minWidth: 14 }}>{i + 1}.</span>
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subj}</span>
                    <span style={{ fontSize: 10, color: '#64748b' }}>@{c.username}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: isPositive ? '#15803d' : '#dc2626' }}>
                    {fmtSigned(c.subsNet)}
                  </div>
                  <div style={{ fontSize: 9, color: '#94a3b8' }}>
                    +{fmtNum(c.subsGained)} / -{fmtNum(c.subsLost)}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
});

const TopPostsList = memo(function TopPostsList({ posts, subjects }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: '0.04em', marginBottom: 6, textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <Trophy size={12} strokeWidth={2.4} style={{ color: '#ca8a04' }} />
        Top Posts in range
      </div>
      {posts.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>—</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {posts.map((p, i) => {
            const subj = subjects[p.chatUsername] || p.chatUsername;
            const typeColor = POST_TYPE_COLORS[p.postType] || '#64748b';
            return (
              <a
                key={`${p.chatUsername}-${p.messageId}`}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  padding: '6px 8px', borderRadius: 6, background: '#f8fafc',
                  textDecoration: 'none', color: '#0f172a',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                  <span style={{ color: '#94a3b8', fontSize: 11 }}>{i + 1}.</span>
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#0f172a' }}>{subj}</span>
                    {p.preview && (
                      <span style={{ fontSize: 10, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>
                        {p.preview}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#3b82f6' }}>{fmtNum(p.views)}</div>
                  <span style={{ background: typeColor + '22', color: typeColor, padding: '1px 5px', borderRadius: 8, fontSize: 9, fontWeight: 700 }}>
                    {p.postType}
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
});

// ─────────────────────────── Recommended Actions ───────────────────────────
const RecommendedActions = memo(function RecommendedActions({ briefing }) {
  if (!briefing?.actions || briefing.actions.length === 0) return null;
  const PRIORITY_PILL = {
    high:   { bg: '#fee2e2', color: '#991b1b', label: 'HIGH' },
    medium: { bg: '#fef3c7', color: '#92400e', label: 'MED' },
    low:    { bg: '#dbeafe', color: '#1e40af', label: 'LOW' },
  };
  return (
    <div style={{
      background: 'white', border: '1px solid #e2e8f0',
      borderRadius: 12, padding: '14px 16px', marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <ClipboardList size={16} strokeWidth={2.2} style={{ color: '#0f172a' }} />
        <strong style={{ fontSize: 14, color: '#0f172a' }}>Recommended Actions</strong>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>this week</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {briefing.actions.map((a, i) => {
          const p = PRIORITY_PILL[a.priority] || PRIORITY_PILL.medium;
          return (
            <div key={i} style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              padding: '8px 10px', background: '#f8fafc', borderRadius: 8,
            }}>
              <span style={{
                background: p.bg, color: p.color, fontSize: 9, fontWeight: 700,
                padding: '3px 7px', borderRadius: 8, letterSpacing: '0.05em',
                minWidth: 38, textAlign: 'center', marginTop: 1, flexShrink: 0,
              }}>{p.label}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: '#0f172a', lineHeight: 1.5 }}>{a.text}</div>
                {Array.isArray(a.channels) && a.channels.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {a.channels.map((u) => (
                      <a
                        key={u}
                        href={`https://t.me/${u}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          background: '#e2e8f0', color: '#475569',
                          padding: '1px 6px', borderRadius: 10,
                          fontSize: 9, fontWeight: 600, textDecoration: 'none',
                        }}
                      >@{u}</a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
