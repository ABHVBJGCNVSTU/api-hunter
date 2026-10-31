"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MatrixRain from "@/components/api-hunter/MatrixRain";
import { useToast } from "@/hooks/use-toast";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  Copy,
  Crosshair,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FileSearch,
  KeyRound,
  Play,
  Radar,
  RefreshCw,
  Server,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  Zap,
} from "lucide-react";

// ═══════════════════════════ types ═══════════════════════════

type LogLevel = "SYS" | "INFO" | "OK" | "WARN" | "ERR";

interface LogLine {
  i: number;
  t: number;
  l: LogLevel;
  m: string;
}

interface Progress {
  status: "idle" | "running" | "stopping";
  startedAt: number | null;
  reposQueued: number;
  reposDone: number;
  reposSkipped: number; // repos skipped — no new code since last visit
  currentRepo: string | null;
  currentFile: string | null;
  filesQueued: number;
  filesRead: number;
  urlsFound: number;
  newEndpoints: number;
  checkedAlive: number;
  checkedDead: number;
}

interface HubEndpoint {
  url: string;
  path: string;
  category: string;
  status: string;
  httpCode: number | null;
  responseMs: number | null;
  foundCount: number;
}

interface Hub {
  id: string;
  host: string;
  baseUrl: string;
  title: string | null;
  status: string;
  quality: number;
  tier: "ELITE" | "HUB" | "LOW";
  endpointCount: number;
  aliveEndpoints: number;
  categories: string[];
  repos: string[];
  repoCount: number;
  httpCode: number | null;
  responseMs: number | null;
  seeded: boolean;
  lastChecked: string | null;
  lastSeen: string;
  endpoints: HubEndpoint[];
}

interface Evidence {
  r: string;
  f: string;
  ln: number;
  s: string;
}

interface Endpoint {
  id: string;
  url: string;
  host: string;
  category: string;
  status: string;
  httpCode: number | null;
  responseMs: number | null;
  repos: string[];
  sourceFile: string | null;
  evidence: Evidence[];
  foundCount: number;
  firstSeen: string;
  isNew: boolean;
  lastSeen: string;
  lastChecked: string | null;
  checkCount: number;
}

interface ScanResp {
  progress: Progress;
  logs: LogLine[];
  chain247: boolean;
  chainCooldownUntil: number | null;
  chainRuns: number;
  tokenSet: boolean;
  bootAt: number;
  uptimeSec: number;
  scansStarted: number;
  stats: {
    total: number;
    alive: number;
    reachable: number;
    error: number;
    dead: number;
    hubsTotal: number;
    hubsAlive: number;
    hubsElite: number;
    reposScanned: number;
    filesRead: number;
    reposWatched: number; // repos in persistent push-memory
    new24h: number; // APIs discovered in the last 24h
  };
}

interface ConfigResp {
  tokenSet: boolean;
  tokenHint: string | null;
  chain247: boolean;
  chainRuns: number;
  rateLimit: {
    core: { remaining: number; limit: number; used: number; reset: number } | null;
    search: { remaining: number; limit: number; used: number; reset: number } | null;
    authenticated: boolean;
  } | null;
}

// ═══════════════════════════ meta ═══════════════════════════

const CATS: Record<string, { label: string; color: string }> = {
  "yt-dl": { label: "YT DL", color: "#ffb000" },
  "social-dl": { label: "SOCIAL DL", color: "#00e5ff" },
  "aio-dl": { label: "ALL-IN-1", color: "#b48bff" },
  "ai-chat": { label: "AI CHAT", color: "#00ff9d" },
  "ai-image": { label: "AI IMAGE", color: "#ff7ad9" },
  "ai-voice": { label: "AI VOICE", color: "#ffd166" },
  other: { label: "MISC", color: "#7aa87f" },
};

const TIER_STYLE: Record<string, { label: string; c: string; bg: string }> = {
  ELITE: { label: "◆ ELITE HUB", c: "#ffd166", bg: "rgba(255,209,102,0.12)" },
  HUB: { label: "◆ MULTI HUB", c: "#00e5ff", bg: "rgba(0,229,255,0.1)" },
  LOW: { label: "SINGLE", c: "#5f8f6a", bg: "rgba(95,143,106,0.12)" },
};

const STATUS_DOT: Record<string, string> = {
  ALIVE: "#00ff41",
  REACHABLE: "#ffb000",
  ERROR: "#ff8c66",
  DEAD: "#ff5f5f",
  UNKNOWN: "#3f5f4a",
};

const LOG_STYLE: Record<LogLevel, string> = {
  SYS: "text-[#7dffab] font-bold",
  INFO: "text-[#4f9e68]",
  OK: "text-[#00ff41]",
  WARN: "text-[#ffb000]",
  ERR: "text-[#ff5f5f]",
};

const BOOT_LINES = [
  "[SYS] API HUNTER CORE v4.0 HUB-RECON — INITIALIZING...",
  "[SYS] GITHUB FULL-REPO TREE WALKER ........... LOADED",
  "[SYS] DEEP FILE EXTRACTOR x6 POOL ............. LOADED",
  "[SYS] HUB SCORER (ELITE / HUB / JUNK) ......... LOADED",
  "[SYS] CROSS-FILE BASE/PATH JOINER ............. LOADED",
  "[SYS] 24/7 CHAIN LOOP (NEVER-STOP) ............ ARMED",
  "[OK] ALL SYSTEMS OPERATIONAL",
  "> AWAITING OPERATOR",
];

const TABS = [
  { key: "hubs", label: "HUBS", icon: Server },
  { key: "apis", label: "APIS", icon: Zap },
  { key: "terminal", label: "LOGS", icon: TerminalIcon },
  { key: "control", label: "CONTROL", icon: Crosshair },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function fmtTime(ts: number | string | null): string {
  if (!ts) return "—";
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtAgo(ts: number | string): string {
  const t = typeof ts === "string" ? new Date(ts).getTime() : ts;
  if (!t || Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ═══════════════════════════ boot overlay ═══════════════════════════

function BootOverlay({ onDone }: { onDone: () => void }) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= BOOT_LINES.length) {
      const t = setTimeout(onDone, 500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 150 : 200);
    return () => clearTimeout(t);
  }, [shown, onDone]);

  return (
    <div
      className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-[#020503] transition-opacity duration-500"
      onClick={onDone}
      role="button"
      aria-label="Skip boot sequence"
    >
      <div className="w-full max-w-md px-6 text-xs sm:text-sm">
        {BOOT_LINES.slice(0, shown).map((l, i) => (
          <div key={i} className={`line-in ${i < 6 ? "text-[#3f7f57]" : "text-[#00ff41] neon-text"}`}>
            {l}
          </div>
        ))}
        <div className="mt-6 text-center text-[10px] tracking-[0.3em] text-[#2f5f40]">TAP TO SKIP</div>
      </div>
    </div>
  );
}

// ═══════════════════════════ small parts ═══════════════════════════

function Led({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className="led"
      style={{
        background: color,
        boxShadow: color !== "#3f5f4a" ? `0 0 8px ${color}` : "none",
        animation: pulse ? "pulse-led 1.6s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function StatBox({ label, value, color = "#00ff41", icon }: { label: string; value: string | number; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="hud-panel flex flex-col gap-0.5 px-2.5 py-2">
      <div className="hud-label flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="font-display text-lg font-bold leading-none sm:text-xl" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const t = TIER_STYLE[tier] ?? TIER_STYLE.LOW;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold tracking-widest"
      style={{ color: t.c, background: t.bg, border: `1px solid ${t.c}44` }}
    >
      {t.label}
    </span>
  );
}

function CatBadge({ cat }: { cat: string }) {
  const c = CATS[cat] ?? CATS.other;
  return (
    <span className="whitespace-nowrap px-1.5 py-0.5 text-[9px] tracking-wider" style={{ color: c.color, background: `${c.color}14`, border: `1px solid ${c.color}33` }}>
      {c.label}
    </span>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

// ═══════════════════════════ hub card ═══════════════════════════

function HubCard({
  hub,
  onCopy,
  onCheck,
  onHide,
  busy,
}: {
  hub: Hub;
  onCopy: (text: string, label: string) => void;
  onCheck: (hub: Hub) => void;
  onHide: (hub: Hub) => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const dot = STATUS_DOT[hub.status] ?? STATUS_DOT.UNKNOWN;

  return (
    <div className="hud-panel status-in p-3 sm:p-4">
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <TierBadge tier={hub.tier} />
            {hub.seeded && (
              <span className="border border-[#b48bff44] bg-[#b48bff14] px-1.5 py-0.5 text-[9px] tracking-widest text-[#b48bff]">TARGET</span>
            )}
            <span className="flex items-center gap-1.5 text-[10px] text-[#4f9e68]">
              <Led color={dot} pulse={hub.status === "ALIVE"} />
              {hub.status}
              {hub.httpCode ? ` · ${hub.httpCode}` : ""}
              {hub.responseMs ? ` · ${hub.responseMs}ms` : ""}
            </span>
          </div>
          <a
            href={hub.baseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="glitch mt-1 block truncate font-display text-base font-bold text-[#00ff41] neon-text-soft hover:underline sm:text-lg"
          >
            {hub.host}
          </a>
          {hub.title && <div className="truncate text-[11px] text-[#4f9e68]">“{hub.title}”</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="font-display text-xl font-black text-[#00ff41]" title={`quality ${hub.quality}/100`}>
            {hub.quality}
            <span className="text-[10px] text-[#2f5f40]">/100</span>
          </div>
          <div className="h-1 w-14 bg-[#0a1f12]">
            <div className="h-full" style={{ width: `${hub.quality}%`, background: hub.quality >= 60 ? "#00ff41" : hub.quality >= 30 ? "#ffb000" : "#5f8f6a" }} />
          </div>
        </div>
      </div>

      {/* meta row */}
      <div className="mt-2.5 grid grid-cols-3 gap-1.5 text-center">
        <div className="border border-[#0a2f1a] bg-[#04140a] px-1 py-1.5">
          <div className="font-display text-sm font-bold text-[#00e5ff]">{hub.endpointCount}</div>
          <div className="text-[8px] tracking-widest text-[#4f9e68]">ENDPOINTS</div>
        </div>
        <div className="border border-[#0a2f1a] bg-[#04140a] px-1 py-1.5">
          <div className="font-display text-sm font-bold text-[#00ff9d]">{hub.aliveEndpoints}</div>
          <div className="text-[8px] tracking-widest text-[#4f9e68]">ALIVE</div>
        </div>
        <div className="border border-[#0a2f1a] bg-[#04140a] px-1 py-1.5">
          <div className="font-display text-sm font-bold text-[#b48bff]">{hub.repoCount}</div>
          <div className="text-[8px] tracking-widest text-[#4f9e68]">REPOS</div>
        </div>
      </div>

      {/* endpoint chips */}
      {hub.endpoints.length > 0 && (
        <div className="mt-2.5">
          <div className="hud-label mb-1">ENDPOINT MAP · TAP TO COPY FULL URL</div>
          <div className="flex flex-wrap gap-1">
            {(expanded ? hub.endpoints : hub.endpoints.slice(0, 8)).map((ep) => (
              <button
                key={ep.url}
                onClick={() => onCopy(ep.url, ep.url)}
                className="group flex max-w-full items-center gap-1 border border-[#0a3d1c] bg-[#04140a] px-1.5 py-1 text-left transition-colors hover:border-[#00ff41] hover:bg-[#0a2f1a]"
                title={`copy ${ep.url}`}
              >
                <Led color={STATUS_DOT[ep.status] ?? STATUS_DOT.UNKNOWN} />
                <span className="truncate text-[10px] text-[#7dffab] group-hover:text-[#00ff41]">{ep.path}</span>
                <Copy className="h-2.5 w-2.5 shrink-0 text-[#2f5f40] group-hover:text-[#00ff41]" />
              </button>
            ))}
            {hub.endpoints.length > 8 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 border border-dashed border-[#0a3d1c] px-1.5 py-1 text-[10px] text-[#4f9e68] hover:text-[#00ff41]"
              >
                {expanded ? "LESS" : `+${hub.endpoints.length - 8} MORE`}
                <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* categories + repos */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        {hub.categories.filter((c) => c !== "multi").slice(0, 4).map((c) => (
          <CatBadge key={c} cat={c} />
        ))}
        {hub.categories.includes("multi") && hub.categories.length <= 1 && <CatBadge cat="other" />}
        {hub.repos.length > 0 && (
          <span className="truncate text-[9px] text-[#2f5f40]" title={hub.repos.join(", ")}>
            SRC: {hub.repos.slice(0, 2).join(" · ")}
            {hub.repos.length > 2 ? ` +${hub.repos.length - 2}` : ""}
          </span>
        )}
      </div>

      {/* actions */}
      <div className="mt-3 grid grid-cols-4 gap-1.5">
        <a
          href={hub.baseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="neon-btn flex min-h-[40px] items-center justify-center gap-1 text-[10px]"
        >
          <ExternalLink className="h-3.5 w-3.5" /> OPEN
        </a>
        <button onClick={() => onCopy(hub.baseUrl, hub.baseUrl)} className="neon-btn flex min-h-[40px] items-center justify-center gap-1 text-[10px]">
          <Copy className="h-3.5 w-3.5" /> COPY
        </button>
        <button onClick={() => onCheck(hub)} disabled={busy} className="neon-btn flex min-h-[40px] items-center justify-center gap-1 text-[10px]">
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> CHECK
        </button>
        <button onClick={() => onHide(hub)} className="neon-btn neon-btn-danger flex min-h-[40px] items-center justify-center gap-1 text-[10px]">
          <EyeOff className="h-3.5 w-3.5" /> JUNK
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════ endpoint row ═══════════════════════════

function EndpointRow({ ep, showNew, onCopy, onCheck, onIgnore, busy }: { ep: Endpoint; showNew: boolean; onCopy: (ep: Endpoint) => void; onCheck: (ep: Endpoint) => void; onIgnore: (ep: Endpoint) => void; busy: boolean }) {
  const dot = STATUS_DOT[ep.status] ?? STATUS_DOT.UNKNOWN;
  return (
    <div className="hud-panel status-in p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Led color={dot} pulse={ep.status === "ALIVE"} />
            <span className="text-[9px] tracking-widest text-[#4f9e68]">{ep.status}{ep.httpCode ? ` · ${ep.httpCode}` : ""}{ep.responseMs != null ? ` · ${ep.responseMs}ms` : ""}</span>
            <CatBadge cat={ep.category} />
            {showNew && <span className="bg-[#ff7ad9] px-1 py-0.5 text-[8px] font-black tracking-wider text-[#020503]">NEW</span>}
            <span className="shrink-0 text-[9px] text-[#2f5f40]">{fmtAgo(ep.firstSeen)}</span>
          </div>
          <button onClick={() => onCopy(ep)} className="mt-1 block w-full truncate text-left text-[11px] text-[#00ff41] hover:underline sm:text-xs" title={ep.url}>
            {ep.url}
          </button>
          <div className="truncate text-[9px] text-[#2f5f40]" title={ep.repos.join(", ")}>
            {ep.repos[0] ?? "—"}{ep.sourceFile ? ` · ${ep.sourceFile}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button onClick={() => onCopy(ep)} className="neon-btn flex h-9 w-9 items-center justify-center" aria-label="copy url">
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => onCheck(ep)} disabled={busy} className="neon-btn flex h-9 w-9 items-center justify-center" aria-label="recheck">
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
          </button>
          <button onClick={() => onIgnore(ep)} className="neon-btn neon-btn-danger flex h-9 w-9 items-center justify-center" aria-label="hide">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════ main page ═══════════════════════════

export default function Home() {
  const { toast } = useToast();
  const [booted, setBooted] = useState(false);
  const [tab, setTab] = useState<TabKey>("apis");
  const [scan, setScan] = useState<ScanResp | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [hubTier, setHubTier] = useState<"all" | "ELITE" | "HUB" | "LOW">("all");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [epCat, setEpCat] = useState("core"); // CORE = downloaders + AI only (the operator's use-case)
  const [epStatus, setEpStatus] = useState("good"); // GOOD = ALIVE+REACHABLE only — falto (dead) APIs stay hidden
  const [epSort, setEpSort] = useState<"new" | "alive" | "checks">("new"); // new = discovery order — old APIs never bubble back up
  const [feed, setFeed] = useState<Endpoint[]>([]); // LATEST FINDS stream (newest discoveries)
  const [lastVisit, setLastVisit] = useState<number>(0); // visit watermark → only newer finds get the NEW badge
  const [config, setConfig] = useState<ConfigResp | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [busyHub, setBusyHub] = useState<string | null>(null);
  const [busyEp, setBusyEp] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const logSeqRef = useRef(0);

  // ---- polling: scan status + logs (2.5s)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/scan?since=${logSeqRef.current}`, { cache: "no-store" });
        if (!res.ok) return;
        const data: ScanResp = await res.json();
        if (!alive) return;
        setScan(data);
        if (data.logs.length > 0) {
          logSeqRef.current = data.logs[data.logs.length - 1].i;
          setLogs((prev) => [...prev, ...data.logs].slice(-400));
        }
      } catch {
        /* server restarting — keep polling */
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ---- polling: config (15s)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        if (!res.ok) return;
        const data: ConfigResp = await res.json();
        if (alive) setConfig(data);
      } catch {
        /* noop */
      }
    };
    tick();
    const t = setInterval(tick, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ---- polling: hubs (7s when tab visible)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const tierQ = hubTier === "all" ? "" : `&tier=${hubTier}`;
        const res = await fetch(`/api/hubs?limit=60${tierQ}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setHubs(data.items ?? []);
      } catch {
        /* noop */
      }
    };
    tick();
    const t = setInterval(tick, 7000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [hubTier]);

  // ---- NEW FINDS feed (6s — the LATEST FINDS ticker runs on every tab)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/results?limit=16&sort=new&category=core&status=good`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setFeed(data.items ?? []);
      } catch {
        /* noop */
      }
    };
    tick();
    const t = setInterval(tick, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ---- visit watermark: only discoveries AFTER the last dashboard visit show as NEW
  useEffect(() => {
    try {
      setLastVisit(Number(localStorage.getItem("apihunter_lastVisit") ?? 0));
      const t = setTimeout(() => localStorage.setItem("apihunter_lastVisit", String(Date.now())), 4000);
      return () => clearTimeout(t);
    } catch {
      /* private browsing — no storage */
    }
  }, []);

  // ---- polling: endpoints (6s when tab visible)
  useEffect(() => {
    if (tab !== "apis") return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/results?limit=80&sort=${epSort}&category=${epCat}&status=${epStatus}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) setEndpoints(data.items ?? []);
      } catch {
        /* noop */
      }
    };
    tick();
    const t = setInterval(tick, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tab, epCat, epStatus, epSort]);

  // ---- terminal auto scroll
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // ---- actions
  const toggleChain = useCallback(async () => {
    if (!scan) return;
    setToggling(true);
    try {
      const action = scan.chain247 ? "stop" : "start";
      const res = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await res.json();
      if (data.ok) {
        toast({ title: action === "start" ? "24/7 HUNT ENGAGED — NEVER STOPS" : "HUNT HALTED", description: action === "start" ? "Chain loop running: scan → cooldown → scan → ∞" : "Scanner disengaged." });
      } else {
        toast({ title: "COMMAND REJECTED", description: data.error ?? "unknown error", variant: "destructive" });
      }
    } catch {
      toast({ title: "LINK DOWN", description: "Could not reach command channel.", variant: "destructive" });
    } finally {
      setToggling(false);
    }
  }, [scan, toast]);

  const saveToken = useCallback(async () => {
    const res = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenInput }) });
    const data = await res.json();
    if (data.ok) {
      setTokenInput("");
      toast({ title: data.tokenSet ? "TOKEN SAVED TO VAULT" : "TOKEN CLEARED", description: data.tokenSet ? "Deep scan unlocked (5000 req/hr) — survives restarts." : "Anonymous mode (60 req/hr)." });
    } else {
      toast({ title: "VAULT REJECTED TOKEN", description: data.error, variant: "destructive" });
    }
  }, [tokenInput, toast]);

  const copyAction = useCallback(
    async (text: string, label: string) => {
      const ok = await copyText(text);
      toast({ title: ok ? "COPIED TO CLIPBOARD" : "COPY FAILED", description: ok ? label : "clipboard blocked", duration: 1600 });
    },
    [toast]
  );

  const checkHub = useCallback(
    async (hub: Hub) => {
      setBusyHub(hub.host);
      try {
        await fetch("/api/hubs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: hub.host, action: "recheck" }) });
      } finally {
        setBusyHub(null);
      }
    },
    []
  );

  const hideHub = useCallback(
    async (hub: Hub) => {
      await fetch("/api/hubs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: hub.host, action: "hide" }) });
      setHubs((prev) => prev.filter((h) => h.host !== hub.host));
      toast({ title: "JUNK FLAGGED", description: `${hub.host} hidden from the deck`, duration: 1600 });
    },
    [toast]
  );

  const checkEp = useCallback(async (ep: Endpoint) => {
    setBusyEp(ep.id);
    try {
      await fetch("/api/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: ep.id }) });
    } finally {
      setBusyEp(null);
    }
  }, []);

  const ignoreEp = useCallback(
    async (ep: Endpoint) => {
      await fetch(`/api/results?id=${ep.id}`, { method: "DELETE" });
      setEndpoints((prev) => prev.filter((e) => e.id !== ep.id));
      toast({ title: "API HIDDEN", description: ep.url, duration: 1400 });
    },
    [toast]
  );

  const progress = scan?.progress;
  const stats = scan?.stats;
  const chainOn = scan?.chain247 ?? false;
  const running = progress?.status === "running";
  const cooldownLeft = scan?.chainCooldownUntil ? Math.max(0, Math.round((scan.chainCooldownUntil - Date.now()) / 1000)) : 0;

  const visibleHubs = useMemo(() => {
    if (hubTier === "all") return hubs;
    return hubs.filter((h) => h.tier === hubTier);
  }, [hubs, hubTier]);

  // ---- boot gate
  if (!booted) return <BootOverlay onDone={() => setBooted(true)} />;

  return (
    <div className="hunter-root relative flex min-h-screen flex-col">
      <MatrixRain />
      <div className="scanlines" />

      {/* ═══════ HEADER ═══════ */}
      <header className="sticky top-0 z-40 border-b border-[#0a3d1c] bg-[#020503f2] backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center border border-[#00ff4155] bg-[#04140a]">
              <Radar className="h-5 w-5 text-[#00ff41]" />
            </div>
            <div>
              <div className="glitch flicker font-display text-sm font-black tracking-wider text-[#00ff41] neon-text sm:text-base">API//HUNTER</div>
              <div className="text-[9px] tracking-[0.28em] text-[#2f5f40]">GITHUB RECON · v4 HUB-RECON</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 border px-2 py-1 text-[9px] font-bold tracking-widest ${chainOn ? "border-[#00ff4155] bg-[#00ff4114] text-[#00ff41]" : "border-[#ffb00055] bg-[#ffb00014] text-[#ffb000]"}`}>
              <Led color={chainOn ? "#00ff41" : "#ffb000"} pulse={chainOn} />
              {chainOn ? "24/7 LIVE" : "STANDBY"}
            </div>
            <div className="hidden flex-col items-end sm:flex">
              <span className="text-[9px] tracking-widest text-[#2f5f40]">UPTIME</span>
              <span className="font-display text-xs text-[#7dffab]">{fmtClock(scan?.uptimeSec ?? 0)}</span>
            </div>
          </div>
        </div>

        {/* progress strip when running */}
        {running && progress && (
          <div className="border-t border-[#0a2f1a] bg-[#04140a]">
            <div className="mx-auto flex w-full max-w-5xl items-center gap-2 overflow-hidden px-3 py-1.5 text-[10px]">
              <Activity className="h-3 w-3 shrink-0 animate-pulse text-[#00ff41]" />
              <span className="shrink-0 text-[#00ff41]">
                [{progress.reposDone}/{progress.reposQueued}] REPOS
              </span>
              {progress.reposSkipped > 0 && <span className="shrink-0 text-[#ffb000]">SKIP-OLD {progress.reposSkipped}</span>}
              <span className="truncate text-[#4f9e68]">▸ {progress.currentRepo ?? "…"}</span>
              <span className="ml-auto shrink-0 text-[#2f5f40]">FILES {fmtNum(progress.filesRead)}</span>
            </div>
          </div>
        )}
        {chainOn && !running && cooldownLeft > 0 && (
          <div className="border-t border-[#0a2f1a] bg-[#04140a]">
            <div className="mx-auto w-full max-w-5xl px-3 py-1.5 text-[10px] text-[#ffb000]">
              CHAIN CYCLE #{scan?.chainRuns ?? 0} COMPLETE → NEXT LAUNCH IN {cooldownLeft}s
            </div>
          </div>
        )}
      </header>

      {/* ═══════ STATS ═══════ */}
      <section aria-label="live statistics" className="relative z-10 mx-auto grid w-full max-w-5xl grid-cols-2 gap-2 px-3 pt-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatBox label="ALIVE APIS" value={fmtNum(stats?.alive ?? 0)} color="#00ff41" icon={<Zap className="h-3 w-3" />} />
        <StatBox label="NEW 24H" value={fmtNum(stats?.new24h ?? 0)} color="#ff7ad9" icon={<Sparkles className="h-3 w-3" />} />
        <StatBox label="ELITE HUBS" value={fmtNum(stats?.hubsElite ?? 0)} color="#ffd166" icon={<Server className="h-3 w-3" />} />
        <StatBox label="REPOS WATCHED" value={fmtNum(stats?.reposWatched ?? 0)} color="#00e5ff" icon={<Eye className="h-3 w-3" />} />
        <StatBox label="REPOS RECON" value={fmtNum(stats?.reposScanned ?? 0)} color="#7dffab" icon={<FileSearch className="h-3 w-3" />} />
        <StatBox label="FILES DEEP-READ" value={fmtNum(stats?.filesRead ?? 0)} color="#b48bff" icon={<Database className="h-3 w-3" />} />
      </section>

      {/* ═══════ LATEST FINDS TICKER (always visible) ═══════ */}
      <section aria-label="latest discoveries" className="relative z-10 mx-auto mt-2 w-full max-w-5xl px-3">
        <div className="hud-panel flex items-stretch overflow-hidden">
          <div className="flex shrink-0 items-center gap-1.5 border-r border-[#0a2f1a] bg-[#04140a] px-2.5 py-2">
            <Sparkles className="h-3.5 w-3.5 animate-pulse text-[#ff7ad9]" />
            <span className="hud-label whitespace-nowrap text-[9px]" style={{ color: "#ff7ad9" }}>
              LATEST FINDS
            </span>
          </div>
          <div className="scrollbar-hacker flex flex-1 items-center gap-1.5 overflow-x-auto px-2 py-2">
            {feed.length === 0 && <span className="text-[10px] text-[#2f5f40]">AWAITING FIRST DISCOVERY…</span>}
            {feed.slice(0, 10).map((ep) => {
              const fresh = new Date(ep.firstSeen).getTime() > lastVisit;
              return (
                <button
                  key={ep.id}
                  onClick={() => copyAction(ep.url, ep.url)}
                  className="flex shrink-0 items-center gap-1.5 border border-[#0a3d1c] bg-[#04140a] px-2 py-1 transition-colors hover:border-[#00ff41]"
                  title={`${ep.url} — copy`}
                >
                  <Led color={STATUS_DOT[ep.status] ?? STATUS_DOT.UNKNOWN} />
                  <span className="max-w-[220px] truncate text-[10px] text-[#7dffab]">{ep.url.replace(/^https?:\/\//, "")}</span>
                  {fresh && <span className="bg-[#ff7ad9] px-1 text-[8px] font-black text-[#020503]">NEW</span>}
                  <span className="text-[8px] text-[#2f5f40]">{fmtAgo(ep.firstSeen)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══════ MAIN ═══════ */}
      <main className="relative z-10 mx-auto w-full max-w-5xl flex-1 px-3 pb-24 pt-3 md:pb-6">
        {/* ─── HUBS TAB ─── */}
        {tab === "hubs" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="hud-label mr-1">TIER:</span>
              {(["all", "ELITE", "HUB", "LOW"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setHubTier(t)}
                  className={`border px-2.5 py-1.5 text-[10px] font-bold tracking-widest transition-colors ${hubTier === t ? "border-[#00ff41] bg-[#00ff4118] text-[#00ff41]" : "border-[#0a3d1c] text-[#4f9e68] hover:border-[#00ff4188]"}`}
                >
                  {t.toUpperCase()}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-[#2f5f40]">{visibleHubs.length} SHOWN / {stats?.hubsTotal ?? 0} TOTAL</span>
            </div>
            {visibleHubs.length === 0 && (
              <div className="hud-panel p-8 text-center text-xs text-[#4f9e68]">
                NO HUBS IN THIS TIER YET.
                <br />
                <span className="text-[#2f5f40]">ENGAGE THE 24/7 CHAIN IN CONTROL → THE HUNTER FILLS THIS DECK AUTOMATICALLY.</span>
              </div>
            )}
            {visibleHubs.map((hub) => (
              <HubCard key={hub.id} hub={hub} onCopy={copyAction} onCheck={checkHub} onHide={hideHub} busy={busyHub === hub.host} />
            ))}
          </div>
        )}

        {/* ─── APIS TAB ─── */}
        {tab === "apis" && (
          <div className="flex flex-col gap-3">
            {/* NEW FINDS — discoveries since the operator's last dashboard visit */}
            {(() => {
              const newFinds = feed.filter((e) => new Date(e.firstSeen).getTime() > lastVisit);
              if (newFinds.length === 0) return null;
              return (
                <div className="hud-panel border-[#ff7ad955] p-3">
                  <div className="hud-label mb-2 flex items-center gap-1.5" style={{ color: "#ff7ad9" }}>
                    <Sparkles className="h-3.5 w-3.5" /> NEW FINDS — {newFinds.length} SINCE LAST VISIT
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {newFinds.slice(0, 6).map((ep) => (
                      <button
                        key={ep.id}
                        onClick={() => copyAction(ep.url, ep.url)}
                        className="flex items-center gap-2 border border-[#0a3d1c] bg-[#04140a] px-2 py-1.5 text-left transition-colors hover:border-[#00ff41]"
                      >
                        <Led color={STATUS_DOT[ep.status] ?? STATUS_DOT.UNKNOWN} pulse={ep.status === "ALIVE"} />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-[#00ff41]">{ep.url}</span>
                        <CatBadge cat={ep.category} />
                        <span className="shrink-0 text-[9px] text-[#2f5f40]">{fmtAgo(ep.firstSeen)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })()}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="hud-label mr-1">CAT:</span>
              {["core", "all", "yt-dl", "social-dl", "aio-dl", "ai-chat", "ai-image", "ai-voice", "other"].map((c) => (
                <button
                  key={c}
                  onClick={() => setEpCat(c)}
                  className={`border px-2 py-1.5 text-[9px] font-bold tracking-widest transition-colors ${epCat === c ? "border-[#00ff41] bg-[#00ff4118] text-[#00ff41]" : "border-[#0a3d1c] text-[#4f9e68] hover:border-[#00ff4188]"}`}
                >
                  {c === "core" ? "★ CORE" : c === "all" ? "ALL" : (CATS[c]?.label ?? c.toUpperCase())}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="hud-label mr-1">STATUS:</span>
              {["good", "all", "ALIVE", "REACHABLE", "ERROR", "DEAD"].map((s) => (
                <button
                  key={s}
                  onClick={() => setEpStatus(s)}
                  className={`border px-2 py-1.5 text-[9px] font-bold tracking-widest transition-colors ${epStatus === s ? "border-[#00ff41] bg-[#00ff4118] text-[#00ff41]" : "border-[#0a3d1c] text-[#4f9e68] hover:border-[#00ff4188]"}`}
                >
                  {s === "good" ? "GOOD · NO FALTO" : s.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="hud-label mr-1">SORT:</span>
              {(["new", "alive", "checks"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setEpSort(s)}
                  className={`border px-2 py-1.5 text-[9px] font-bold tracking-widest transition-colors ${epSort === s ? "border-[#00ff41] bg-[#00ff4118] text-[#00ff41]" : "border-[#0a3d1c] text-[#4f9e68] hover:border-[#00ff4188]"}`}
                >
                  {s === "new" ? "NEWEST FINDS" : s === "alive" ? "ALIVE FIRST" : "MOST SOURCED"}
                </button>
              ))}
              <span className="ml-auto hidden text-[9px] text-[#2f5f40] sm:inline">DISCOVERY ORDER — OLD APIS NEVER BUBBLE BACK UP</span>
            </div>
            {endpoints.length === 0 && (
              <div className="hud-panel p-8 text-center text-xs text-[#4f9e68]">NO ENDPOINTS FOR THIS FILTER YET — THE CHAIN WILL POPULATE IT.</div>
            )}
            <div className="flex flex-col gap-2">
              {endpoints.map((ep) => (
                <EndpointRow
                  key={ep.id}
                  ep={ep}
                  showNew={new Date(ep.firstSeen).getTime() > lastVisit}
                  onCopy={(e) => copyAction(e.url, e.url)}
                  onCheck={checkEp}
                  onIgnore={ignoreEp}
                  busy={busyEp === ep.id}
                />
              ))}
            </div>
          </div>
        )}

        {/* ─── TERMINAL TAB ─── */}
        {tab === "terminal" && (
          <div className="hud-panel flex flex-col" style={{ height: "calc(100vh - 300px)", minHeight: 380 }}>
            <div className="flex items-center justify-between border-b border-[#0a2f1a] px-3 py-2">
              <div className="flex items-center gap-2 text-[10px] tracking-widest text-[#4f9e68]">
                <TerminalIcon className="h-3.5 w-3.5 text-[#00ff41]" />
                LIVE RECON FEED
              </div>
              <button
                onClick={() => setAutoScroll((v) => !v)}
                className={`border px-2 py-1 text-[9px] tracking-widest ${autoScroll ? "border-[#00ff41] text-[#00ff41]" : "border-[#0a3d1c] text-[#4f9e68]"}`}
              >
                AUTO-SCROLL {autoScroll ? "ON" : "OFF"}
              </button>
            </div>
            <div ref={logRef} className="scrollbar-hacker flex-1 overflow-y-auto px-3 py-2 text-[10px] leading-relaxed sm:text-[11px]">
              {logs.map((l) => (
                <div key={l.i} className="line-in flex gap-2">
                  <span className="shrink-0 text-[#2f5f40]">{fmtTime(l.t)}</span>
                  <span className={`break-all ${LOG_STYLE[l.l]}`}>{l.m}</span>
                </div>
              ))}
              <div className="blink-cursor mt-1 text-[#00ff41]" />
            </div>
          </div>
        )}

        {/* ─── CONTROL TAB ─── */}
        {tab === "control" && (
          <div className="flex flex-col gap-3">
            {/* chain control */}
            <div className="hud-panel p-4">
              <div className="hud-label mb-2">24/7 CHAIN CONTROL — ONE TAP, NEVER STOPS</div>
              <p className="mb-3 text-[11px] leading-relaxed text-[#4f9e68]">
                Ek tap → scanner khud rotate karta rahega: WhatsApp bots → downloader APIs → AI models → scrapers. Har cycle mein naye repos ke
                <span className="text-[#00ff41]"> poore repo trees</span> (commands/, events/, index — har file) deep-scan hote hain. Restart ke baad bhi khud resume.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={toggleChain}
                  disabled={toggling || chainOn}
                  className="neon-btn flex min-h-[52px] items-center justify-center gap-2 text-xs font-bold"
                >
                  <Play className="h-4 w-4" /> {chainOn ? "HUNT RUNNING…" : "START 24/7 HUNT"}
                </button>
                <button onClick={toggleChain} disabled={toggling || !chainOn} className="neon-btn neon-btn-danger flex min-h-[52px] items-center justify-center gap-2 text-xs font-bold">
                  <Square className="h-4 w-4" /> HALT
                </button>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-[9px]">
                <div className="border border-[#0a2f1a] bg-[#04140a] py-1.5">
                  <div className="font-display text-sm text-[#00ff41]">{scan?.chainRuns ?? 0}</div>
                  <div className="tracking-widest text-[#2f5f40]">CYCLES</div>
                </div>
                <div className="border border-[#0a2f1a] bg-[#04140a] py-1.5">
                  <div className="font-display text-sm text-[#00e5ff]">{scan?.scansStarted ?? 0}</div>
                  <div className="tracking-widest text-[#2f5f40]">SCANS</div>
                </div>
                <div className="border border-[#0a2f1a] bg-[#04140a] py-1.5">
                  <div className={`font-display text-sm ${scan?.tokenSet ? "text-[#00ff41]" : "text-[#ffb000]"}`}>{scan?.tokenSet ? "DEEP" : "LITE"}</div>
                  <div className="tracking-widest text-[#2f5f40]">MODE</div>
                </div>
              </div>
            </div>

            {/* token vault */}
            <div className="hud-panel p-4">
              <div className="mb-2 flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-[#ffd166]" />
                <span className="hud-label">GITHUB TOKEN VAULT {config?.tokenSet ? `· SAVED ${config.tokenHint}` : "· EMPTY"}</span>
              </div>
              <p className="mb-2 text-[11px] text-[#4f9e68]">
                Token yahan paste karo — <span className="text-[#ffd166]">DB mein save</span> hota hai, restart ke baad bhi scan chalta rahega. Bina token: 60 req/hr, token ke saath: 5000 req/hr.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder={config?.tokenSet ? "•••••••••••••••••••• (saved — overwrite ya chhor do)" : "ghp_xxxxxxxxxxxxxxxxxxxx"}
                  className="min-h-[44px] flex-1 border border-[#0a3d1c] bg-[#04140a] px-3 text-xs text-[#00ff41] placeholder:text-[#2f5f40] focus:border-[#00ff41] focus:outline-none"
                  autoComplete="off"
                />
                <button onClick={saveToken} className="neon-btn flex min-h-[44px] items-center justify-center gap-1 px-4 text-[10px]">
                  <CheckCircle2 className="h-3.5 w-3.5" /> SAVE
                </button>
              </div>
            </div>

            {/* github rate limit */}
            {config?.rateLimit && (
              <div className="hud-panel p-4">
                <div className="hud-label mb-2">GITHUB RATE WINDOW</div>
                <div className="flex flex-col gap-2 text-[10px]">
                  {(["core", "search"] as const).map((k) => {
                    const r = config.rateLimit?.[k];
                    if (!r) return null;
                    const pct = Math.round((r.remaining / Math.max(r.limit, 1)) * 100);
                    return (
                      <div key={k} className="flex items-center gap-2">
                        <span className="w-14 text-[#4f9e68]">{k.toUpperCase()}</span>
                        <div className="h-2 flex-1 bg-[#0a1f12]">
                          <div className="h-full" style={{ width: `${pct}%`, background: pct > 25 ? "#00ff41" : "#ffb000" }} />
                        </div>
                        <span className="w-20 text-right text-[#7dffab]">
                          {r.remaining}/{r.limit}
                        </span>
                      </div>
                    );
                  })}
                  <div className="text-[9px] text-[#2f5f40]">
                    {config.rateLimit.authenticated ? "OPERATOR TOKEN ACTIVE" : "ANONYMOUS — TOKEN SAVE KARO DEEP MODE KE LIYE"}
                    {config.rateLimit.core ? ` · RESET ${fmtTime(config.rateLimit.core.reset * 1000)}` : ""}
                  </div>
                </div>
              </div>
            )}

            {/* export */}
            <div className="hud-panel p-4">
              <div className="hud-label mb-2">INTEL EXPORT</div>
              <div className="grid grid-cols-2 gap-2">
                <a href="/api/export?format=json" className="neon-btn flex min-h-[44px] items-center justify-center gap-1 text-[10px]">
                  <ExternalLink className="h-3.5 w-3.5" /> JSON PACK
                </a>
                <a href="/api/export?format=csv" className="neon-btn flex min-h-[44px] items-center justify-center gap-1 text-[10px]">
                  <ExternalLink className="h-3.5 w-3.5" /> CSV SHEET
                </a>
              </div>
              <div className="mt-2 text-center text-[9px] text-[#2f5f40]">
                HUBS + ALIVE APIS + EVIDENCE — sab kuch export
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ═══════ FOOTER (desktop) ═══════ */}
      <footer className="relative z-10 mt-auto hidden border-t border-[#0a2f1a] py-3 text-center text-[9px] tracking-[0.25em] text-[#2f5f40] md:block">
        API//HUNTER v4 · FULL-REPO DEEP RECON · HUB-SCORED · 24/7 CHAIN · EVIDENCE-STAMPED
      </footer>

      {/* ═══════ MOBILE BOTTOM NAV ═══════ */}
      <nav aria-label="sections" className="fixed inset-x-0 bottom-0 z-40 border-t border-[#0a3d1c] bg-[#020503f5] backdrop-blur-sm md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="grid grid-cols-4">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[9px] font-bold tracking-widest transition-colors ${active ? "text-[#00ff41]" : "text-[#2f5f40]"}`}
                aria-current={active ? "page" : undefined}
              >
                <Icon className={`h-5 w-5 ${active ? "drop-shadow-[0_0_6px_rgba(0,255,65,0.7)]" : ""}`} />
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* desktop tab switcher (in-flow, under stats) */}
      <div className="relative z-10 mx-auto hidden w-full max-w-5xl gap-1.5 px-3 pt-3 md:flex">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex min-h-[40px] flex-1 items-center justify-center gap-1.5 border px-3 text-[11px] font-bold tracking-widest transition-colors ${active ? "border-[#00ff41] bg-[#00ff4118] text-[#00ff41]" : "border-[#0a3d1c] text-[#4f9e68] hover:border-[#00ff4188]"}`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
