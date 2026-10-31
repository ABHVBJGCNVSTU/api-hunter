// API HUNTER - Scanner Engine v3 (DEEP FULL-REPO SCAN)
// Scans GitHub for recently-updated repos, walks the ENTIRE repo tree
// (commands/, plugins/, events/, handlers/, index.js, configs — every code
// file), extracts live API endpoints with variable tracking + cross-file
// base/path joining, categorizes and health-checks each endpoint.

// HUB-CENTRIC v4: multi-API websites (anabot.my.id / jerrycoder style) are the
// prize — hosts carrying MANY distinct endpoints get scored, tiered and probed;
// single stray URLs sink to the bottom so the operator never sees junk.

import { db } from "@/lib/db";
import { log, state, resetProgress, type ScanConfig } from "@/lib/scan-state";

// ------------------------------------------------------------------ types

interface RepoItem {
  full_name: string;
  default_branch: string;
  pushed_at: string;
  stargazers_count: number;
  description: string | null;
}

export interface TreeFile {
  path: string;
  size: number;
}

export interface EvidenceEntry {
  r: string; // repo
  f: string; // file path
  ln: number; // line number (0 = n/a)
  s: string; // code snippet (trimmed)
}

// ------------------------------------------------------- query presets

export const PRESETS: Record<string, { label: string; build: (since: string, lang: string) => string[] }> = {
  "wa-bots": {
    label: "WHATSAPP BOTS (MD)",
    build: (since, lang) => [
      `whatsapp bot pushed:>${since}${lang}`,
      `whatsapp bot md pushed:>${since}${lang}`,
      `wabot pushed:>${since}${lang}`,
      `topic:whatsapp-bot pushed:>${since}${lang}`,
    ],
  },
  "wa-multi": {
    label: "WA BOTS (ANY LANGUAGE)",
    build: (since, lang) => [
      `whatsapp bot md pushed:>${since}${lang}`,
      `whatsapp bot pushed:>${since}${lang}`,
    ],
  },
  "api-downloader": {
    label: "DOWNLOADER APIS",
    build: (since) => [
      `downloader api pushed:>${since}`,
      `youtube downloader api pushed:>${since}`,
      `tiktok instagram downloader api pushed:>${since}`,
      `aio downloader pushed:>${since}`,
    ],
  },
  "ai-apis": {
    label: "AI MODEL APIS",
    build: (since) => [
      `free ai api pushed:>${since}`,
      `ai image api pushed:>${since}`,
      `tts api pushed:>${since}`,
      `gemini gpt api scraper pushed:>${since}`,
    ],
  },
  "scrapers": {
    label: "SCRAPER / API COLLECTIONS",
    build: (since) => [
      `scraper api pushed:>${since} language:javascript`,
      `api collection pushed:>${since}`,
      `apis list pushed:>${since}`,
      `rest api free pushed:>${since} language:javascript`,
    ],
  },
};

export const ALL_PRESET_KEYS = Object.keys(PRESETS);

function langSuffix(language: string): string {
  return language && language !== "any" ? ` language:${language}` : "";
}

// ------------------------------------------------------- depth levels

// DEEP SCAN: how many files of each repo's FULL tree we actually read.
export const DEPTHS: Record<string, { label: string; files: number; desc: string }> = {
  quick: { label: "QUICK", files: 12, desc: "config + readme + index only" },
  deep: { label: "DEEP", files: 90, desc: "commands / plugins / events / handlers + configs" },
  ultra: { label: "ULTRA", files: 320, desc: "ENTIRE repo tree — nothing escapes" },
};

// ------------------------------------------------------- github helpers

function ghHeaders(token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "api-hunter-recon",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghFetch(url: string, token: string | null, timeoutMs = 15000): Promise<{ ok: boolean; status: number; data: unknown; rateLimited: boolean }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: ghHeaders(token), signal: ctl.signal });
    const data = await res.json().catch(() => null);
    const rateLimited = res.status === 403 || res.status === 429;
    return { ok: res.ok, status: res.status, data, rateLimited };
  } catch {
    return { ok: false, status: 0, data: null, rateLimited: false };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchRateLimit(token: string | null) {
  const r = await ghFetch("https://api.github.com/rate_limit", token, 10000);
  if (!r.ok || !r.data) return null;
  const d = r.data as {
    resources?: { core?: { limit: number; used: number; remaining: number; reset: number }; search?: { limit: number; used: number; remaining: number; reset: number } };
  };
  return {
    core: d.resources?.core ?? null,
    search: d.resources?.search ?? null,
    authenticated: !!token,
  };
}

async function searchRepos(query: string, token: string | null): Promise<{ repos: RepoItem[]; rateLimited: boolean }> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=25`;
  const r = await ghFetch(url, token, 20000);
  if (!r.ok || !r.data) return { repos: [], rateLimited: r.rateLimited };
  const d = r.data as { items?: RepoItem[] };
  return { repos: d.items ?? [], rateLimited: false };
}

async function getRepoTree(repo: string, branch: string, token: string | null): Promise<{ files: TreeFile[]; truncated: boolean } | null> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const r = await ghFetch(url, token, 25000);
  if (!r.ok || !r.data) return null;
  const d = r.data as { tree?: Array<{ path: string; type: string; size?: number }>; truncated?: boolean };
  if (!d.tree) return null;
  return {
    files: d.tree.filter((f) => f.type === "blob").map((f) => ({ path: f.path, size: f.size ?? 0 })),
    truncated: !!d.truncated,
  };
}

// ------------------------------------------------------- file picking (DEEP)

const MAX_FILE_SIZE = 300 * 1024; // 300KB
const RAW_POOL = 6; // parallel raw.githubusercontent fetches (CDN — not API rate-limited)

// paths that never matter
const SKIP_PATH = /(node_modules|dist\/|\.next\/|build\/|\.png|\.jpe?g|\.gif|\.svg|\.webp|\.ico|\.woff2?|\.ttf|\.otf|\.eot|\.mp3|\.mp4|\.zip|\.tar|\.gz$|\.lock$|\.bin$|\.dat$|\.db$|\.session$|creds\.json|auth_state|\.baileys)/i;

// every file type we are willing to read in deep mode
const SCANNABLE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|java|php|rb|kt|go|json|txt|md|yml|yaml|env|cfg|ini|sh)$/i;

// folders where bot authors hide the actual API calls (user's core request:
// "commands Mai shaid event Mai shaid main index mai")
const HUNT_FOLDERS_RE =
  /(\/|^)(commands?|cmd|plugins?|events?|handlers?|features?|systems?|cores?|modules?|libs?|helpers?|utils?|functions?|services?|controllers?|routes?|apis?|endpoints?|downloaders?|ai|tools?|message|scraper|scrapers|data)(\/|$)/i;

// high-value files that usually contain API endpoint lists
function filePriority(path: string): number {
  const p = path.toLowerCase();
  const base = p.split("/").pop() ?? p;
  if (/^readme(\.md|\.txt)?$/.test(base)) return 12;
  if (/^(apis?|endpoints?|links?|urls?)\.(js|ts|json|mjs|txt|md)$/.test(base)) return 12;
  if (/^(config|settings|configs)\.(js|ts|mjs|cjs|json)$/.test(base)) return 11;
  if (/^\.env/.test(base)) return 10;
  if (/api.*(js|ts|json)$/.test(base)) return 9;
  if (/^(package|const|constants|constant|global|vars?)\.(js|ts|json)$/.test(base)) return 7;
  if (HUNT_FOLDERS_RE.test(p)) return 6; // commands/, events/, plugins/ ... DEEP TARGETS
  if (/^(index|main|server|bot)\.(js|ts|mjs)$/.test(base)) return 5;
  if (/\.(js|ts|mjs|cjs|py|java|php|rb|kt|go)$/.test(base)) return 3;
  if (/\.(json|yml|yaml|txt|md|env|cfg|ini|sh)$/.test(base)) return 2;
  return 0;
}

export function pickFiles(tree: TreeFile[], depth = "deep"): TreeFile[] {
  const cap = DEPTHS[depth]?.files ?? DEPTHS.deep.files;
  const pathDepth = (f: TreeFile) => f.path.split("/").length;
  const candidates = tree
    .filter((f) => f.size > 0 && f.size <= MAX_FILE_SIZE && !SKIP_PATH.test(f.path))
    .map((f) => ({ f, pr: filePriority(f.path) }))
    .filter((x) => x.pr > 0 && (x.pr >= 3 || SCANNABLE_RE.test(x.f.path)))
    .sort((a, b) => b.pr - a.pr || pathDepth(a.f) - pathDepth(b.f) || a.f.path.localeCompare(b.f.path));
  return candidates.slice(0, cap).map((x) => x.f);
}

// Fallback when the core API is rate-limited: probe high-probability file
// paths directly on raw.githubusercontent.com (CDN — not API rate-limited).
const FALLBACK_PATHS = [
  "README.md",
  "readme.md",
  "package.json",
  "config.js",
  "config.ts",
  "settings.js",
  "config.json",
  "apis.js",
  "api.js",
  "endpoints.js",
  "constants.js",
  "const.js",
  "global.js",
  "index.js",
  "main.js",
  "server.js",
  ".env",
  ".env.example",
  ".env.sample",
];

async function probeRawFile(repo: string, branch: string, path: string): Promise<TreeFile | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`, {
      method: "HEAD",
      headers: { "User-Agent": "api-hunter-recon" },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_FILE_SIZE) return null;
    return { path, size: len || 1024 };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fallbackFiles(repo: string, branch: string): Promise<TreeFile[]> {
  const hits = await checkPool(FALLBACK_PATHS, (p) => probeRawFile(repo, branch, p), 5);
  return hits.filter((h): h is TreeFile => h !== null);
}

async function fetchRaw(repo: string, branch: string, path: string): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`, {
      headers: { "User-Agent": "api-hunter-recon" },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, MAX_FILE_SIZE);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------- URL extraction

const URL_REGEX = /https?:\/\/[a-zA-Z0-9-._~%]+(?::\d{2,5})?(?:\/[a-zA-Z0-9-._~%/]*)?/g;

const EXCLUDE_HOST_RE =
  /(^|\.)(github\.com|githubusercontent\.com|github\.io|npmjs\.(?:org|com)|yarnpkg\.com|nodejs\.org|shields\.io|img\.shields\.io|travis-ci\.(?:org|com)|circleci\.com|docker\.com|amazonaws\.com|cloudflare\.(?:com|ipfs)|youtube\.com|youtu\.be|whatsapp\.com|chat\.whatsapp\.com|wa\.me|api\.whatsapp\.com|telegr\.am|telegram\.org|t\.me|discord(?:app)?\.com|discord\.gg|facebook\.com|instagram\.com|pinterest\.(?:com|co\.uk)|pin\.it|tiktok\.com|google\.com|googleapis\.com|gstatic\.com|youtube-nocookie\.com|wikipedia\.org|wikimedia\.org|wikia\.com|fandom\.com|bing\.com|w3\.org|schema\.org|mozilla\.org|mongodb\.(?:com|net)|mongoosejs\.com|prisma\.io|postgresql\.org|sqlite\.org|redis\.io|localhost|test\.com|example\.(?:com|org)|adobe\.com|figma\.com|canva\.com|fonts\.(?:googleapis|gstatic)\.com|fontawesome\.com|patreon\.com|ko-fi\.com|buymeacoffee\.com|paypal\.(?:com|me)|opencollective\.com|liberapay\.com|bit\.ly|tinyurl\.com|cutt\.ly|shorturl\.at|s\.id|gitlab\.com|sourceforge\.net|codeberg\.org|openai\.com|ai\.google\.dev|anthropic\.com|deepseek\.com|mistral\.ai|vercel\.com|replit\.com|render\.com|nvidia\.com|hetzner\.(?:com|de|cloud)|ollama\.com|groq\.com|together\.ai|fireworks\.ai|deepinfra\.com|openrouter\.ai|cohere\.(?:com|ai)|cerebras\.ai|twilio\.com|sendgrid\.com|mailgun\.com|supabase\.(?:co|com|in)|firebaseio\.com|digitalocean\.com|linode\.com|vultr\.com|backblaze\.com|wasabisys\.com|huggingface\.co|replicate\.com|stability\.ai|midjourney\.com|perplexity\.ai|x\.ai|azure\.com|microsoft\.com|apple\.com|amazon\.com|cloudinary\.com|imgur\.com|imgbb\.com|postimg\.cc|ibb\.co|telegra\.ph|graph\.org|plus\.google|bugs\.chromium\.org|developer\.mozilla\.org|stackoverflow\.com|medium\.com|dev\.to|reddit\.com|twitter\.com|x\.com|spotify\.com|\.invalid$|\.test$|\.example$|\.localhost$)/i;

// URL paths that are documentation / pages / assets — never API endpoints
const EXCLUDE_PATH_RE = /(\.(png|jpe?g|gif|svg|webp|ico|css|woff2?|ttf|otf|mp[34]|pdf|zip|xml|rss)(\?|$)|\/(wiki|docs?|blog|support|faq|guides?|tutorials?|changelog|privacy|terms|about|contact|dashboard|panel|deploy|features)(\/|$)|github\.com\/|vercel\.com\/(new|dashboard))/i;

// hosting TLDs / SaaS domains that commonly serve community APIs
const API_HOST_RE =
  /(^|\.)(vercel\.app|vercel\.dev|workers\.dev|pages\.dev|netlify\.app|onrender\.com|render\.com|railway\.app|up\.railway\.app|fly\.dev|deno\.dev|glitch\.me|repl\.co|replit\.dev|replit\.app|pythonanywhere\.com|firebaseapp\.com|web\.app|ephemeral\.domains|eu\.org|eu\.cc|biz\.id|my\.id|zone\.id|pp\.ua|cars\.id|file\.cs|cloud\.okteto\.net|koyeb\.app|azurewebsites\.net|cloudfunctions\.net|run\.app|amazonwebservices\.dev|crbtc\.ovh|us\.kg|eu\.org)$/i;

function isPrivateHost(host: string): boolean {
  return (
    /^localhost$/i.test(host) ||
    /^127\./.test(host) ||
    /^0\.0\.0\.0$/.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^\[?::1\]?$/.test(host)
  );
}

// template/placeholder hosts that bot configs use as "fill in your own URL"
const PLACEHOLDER_HOST_RE =
  /(tu-?url|tudominio|tu[-_]?api|sua[-_]?url|seuurl|your[-_]?(url|api|domain|render|app|host|server|site|key)|example[-_.]?(com|org|api)|placeholder|dummy|my[-_]?api[-_]?url|insert[-_]?|change[-_]?me|xxx+|test[-_]?api$|^api\.(example|test|dominio))/i;

function isPlaceholderHost(host: string): boolean {
  return PLACEHOLDER_HOST_RE.test(host);
}

// bare platform/provider apex domains are vendor sites, never APIs.
// community APIs live on SUBDOMAINS of these (e.g. foo.vercel.app) —
// reject only the exact apex, keep subdomains alive.
const PLATFORM_APEX_RE =
  /^(vercel\.app|vercel\.dev|workers\.dev|pages\.dev|netlify\.app|onrender\.com|railway\.app|up\.railway\.app|fly\.dev|deno\.dev|glitch\.me|repl\.co|replit\.dev|replit\.app|koyeb\.app|web\.app|firebaseapp\.com|azurewebsites\.net|cloudfunctions\.net|run\.app|amazonwebservices\.dev|pythonanywhere\.com|eu\.org|eu\.cc|biz\.id|my\.id|zone\.id|pp\.ua|cars\.id|file\.cs|us\.kg|crbtc\.ovh|vercel\.com|railway\.com|netlify\.com|cloudflare\.com|github\.io)$/i;

export function hostLooksApi(host: string): boolean {
  const h = host.toLowerCase();
  if (h.startsWith("api.") || h.startsWith("apis.") || h.includes("-api.") || h.includes("api-") || /api\d/.test(h)) return true;
  if (API_HOST_RE.test(h)) return true;
  return false;
}

// shared candidate filter → returns hostname, or null if rejected
function filterCandidateUrl(url: string): string | null {
  if (url.length < 11 || url.length > 200) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (isPrivateHost(host)) return null;
  if (isPlaceholderHost(host)) return null;
  if (EXCLUDE_HOST_RE.test(host)) return null;
  if (EXCLUDE_PATH_RE.test(url)) return null;
  if (PLATFORM_APEX_RE.test(host.toLowerCase())) return null; // bare vendor apex (railway.app etc.) — junk
  return host;
}

function lineOf(text: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function snippetAt(text: string, idx: number, len: number): string {
  const ls = text.lastIndexOf("\n", idx);
  const le = text.indexOf("\n", idx + len);
  const raw = text.slice(ls + 1, le === -1 ? text.length : le).trim();
  return raw.length > 180 ? raw.slice(0, 180) + "…" : raw;
}

export interface ExtractedUrl {
  url: string;
  host: string;
  score: number;
  ctx: string; // local context around the URL — used for categorization
  line: number; // 1-based line number where found (0 = n/a)
  snippet: string; // source line containing the URL
}

// raw URL pass — same as v2 but now with line/snippet evidence
export function extractUrls(text: string, fileName: string): ExtractedUrl[] {
  const found = new Map<string, ExtractedUrl>();
  let m: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;
  while ((m = URL_REGEX.exec(text)) !== null) {
    let url = m[0].replace(/[.,;:)\]]+$/, "");
    const host = filterCandidateUrl(url);
    if (!host) continue;

    let score = 0;
    if (hostLooksApi(host)) score += 4;
    if (/\/api(\/|$)/i.test(url)) score += 2;
    const line = lineOf(text, m.index);
    // context = the source LINE containing the URL (clipped to ±120 chars),
    // so keywords from neighbouring config keys never leak in
    const lineStart = text.lastIndexOf("\n", m.index);
    const lineEnd = text.indexOf("\n", m.index + url.length);
    const start = Math.max(m.index - 120, lineStart + 1, 0);
    const end = Math.min(m.index + url.length + 120, lineEnd === -1 ? text.length : lineEnd);
    const ctx = text.slice(start, end).toLowerCase();
    const snippet = snippetAt(text, m.index, url.length);
    if (/api|endpoint|base_?url|apikey|api_key/.test(ctx)) score += 1;
    if (/(downloader|download|ytdl|tiktok|instagram|gpt|gemini|tts|voice|image)/i.test(ctx)) score += 1;
    if (/^(config|settings|apis?|endpoints?|\.env)/i.test(fileName.split("/").pop() ?? "")) score += 1;

    if (score < 3) continue;

    url = url.replace(/\/+$/, "");
    const prev = found.get(url);
    if (!prev || prev.score < score) found.set(url, { url, host, score, ctx, line, snippet });
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------- DEEP extraction
// v3: variables, call-sites, template literals, cross-file path harvesting

// `const X = "https://..."` / `let Y = 'https://...'` / python `X = "https://..."` / java `String X = "https://..."`
const VAR_ASSIGN_RE =
  /(?:(?:const|let|var|final\s+\w+|String)\s+([A-Za-z_$][\w$]*)\s*=\s*|^\s*([A-Za-z_][\w]*)\s*=\s*)["'`](https?:\/\/[^"'`\s]{11,200})["'`]/gm;

// fetch('...') / axios.get("...") / got(`...`) / fetchJson('...') / requests.get('...')
const CALL_SITE_RE =
  /(?:fetch|axios(?:\.(?:get|post|put|delete|patch))?|got|fetchJson|requesty?|requests\.(?:get|post)|urllib\.request|http\.(?:get|post)|client\.(?:get|post))\s*\(\s*["'`](https?:\/\/[^"'`\s]{11,200})["'`]/g;

// `${VAR}/endpoint` template literals (query prefix allowed, stripped on push)
const TEMPLATE_USE_RE = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}(\/[a-zA-Z0-9-._~%/]{2,80}(?:\?[a-zA-Z0-9=&_%.]{0,40})?)/g;

// VAR + '/endpoint' string concat (query prefix allowed, stripped on push)
const CONCAT_USE_RE = /([A-Za-z_$][\w$]*)\s*\+\s*["'`](\/[a-zA-Z0-9-._~%/]{2,80}(?:\?[a-zA-Z0-9=&_%.]{0,40})?)["'`]/g;

// harvest endpoint-looking path strings ("/api/ytdl", "/download/youtube"...)
const PATH_HARVEST_RE =
  /["'`](\/(?:api|apis|v[0-9]{1,2}|download|downloader|dl|ytdl|ytmp3|ytmp4|yt|tiktok|tikwm|instagram|igdl|insta|facebook|fbdl|fbdown|fb|pinterest|pindl|pin|twitter|tts|voice|ai|image|img|chatgpt|gpt|gemini|llama|openai|suno|remini|enhance|upscale|toanime|toimage|stalk|search|play|media|fetch|upload|nano|banana|flux|dalle|diffusion|soundly|ringtone|lyrics)[a-zA-Z0-9\/_?=-]{0,60})["'`]/gi;

export interface DeepExtractResult {
  urls: ExtractedUrl[];
  paths: string[]; // repo-level endpoint paths harvested for cross-file join
}

export function deepExtract(text: string, fileName: string): DeepExtractResult {
  const urls = new Map<string, ExtractedUrl>();

  const push = (urlRaw: string, score: number, idx: number) => {
    let url = urlRaw.replace(/[.,;:)\]]+$/, "").replace(/\?.*$/, ""); // strip query for storage
    const host = filterCandidateUrl(url);
    if (!host) return;
    url = url.replace(/\/+$/, "");
    if (!hostLooksApi(host) && score < 4) return; // call-sites / joins must be api-ish unless strong
    // line-clamped context so keywords from neighbouring lines never leak in
    const lineStart = text.lastIndexOf("\n", idx);
    const lineEnd = text.indexOf("\n", idx + urlRaw.length);
    const ctx = text.slice(Math.max(idx - 100, lineStart + 1, 0), Math.min(idx + urlRaw.length + 100, lineEnd === -1 ? text.length : lineEnd)).toLowerCase();
    const prev = urls.get(url);
    if (!prev || prev.score < score)
      urls.set(url, { url, host, score, ctx, line: lineOf(text, idx), snippet: snippetAt(text, idx, urlRaw.length) });
  };

  // pass 1 — raw URLs (best evidence)
  for (const u of extractUrls(text, fileName)) urls.set(u.url, u);

  // pass 2 — variable assignment map (base URLs stored in constants)
  const varMap = new Map<string, string>();
  let m: RegExpExecArray | null;
  VAR_ASSIGN_RE.lastIndex = 0;
  while ((m = VAR_ASSIGN_RE.exec(text)) !== null) {
    const name = m[1] ?? m[2];
    const url = m[3].replace(/[.,;:)\]]+$/, "").replace(/\?.*$/, "");
    if (filterCandidateUrl(url)) varMap.set(name, url.replace(/\/+$/, ""));
  }

  // pass 3 — call sites with full URLs (strong signal even without api-ish host)
  CALL_SITE_RE.lastIndex = 0;
  while ((m = CALL_SITE_RE.exec(text)) !== null) push(m[1], 5, m.index);

  // pass 4 — `${VAR}/path` template usage
  TEMPLATE_USE_RE.lastIndex = 0;
  while ((m = TEMPLATE_USE_RE.exec(text)) !== null) {
    const base = varMap.get(m[1]);
    if (base) push(base + m[2], 5, m.index);
  }

  // pass 5 — VAR + "/path" concat usage
  CONCAT_USE_RE.lastIndex = 0;
  while ((m = CONCAT_USE_RE.exec(text)) !== null) {
    const base = varMap.get(m[1]);
    if (base) push(base + m[2], 5, m.index);
  }

  // pass 6 — harvest endpoint paths for cross-file joining
  const paths = new Set<string>();
  PATH_HARVEST_RE.lastIndex = 0;
  while ((m = PATH_HARVEST_RE.exec(text)) !== null) {
    const p = m[1];
    if (p.length >= 4 && p.length <= 80 && !p.endsWith("/")) paths.add(p);
  }

  return { urls: [...urls.values()].sort((a, b) => b.score - a.score).slice(0, 20), paths: [...paths].slice(0, 60) };
}

// ------------------------------------------------------- categorization

export type Category = "yt-dl" | "social-dl" | "aio-dl" | "ai-chat" | "ai-image" | "ai-voice" | "other";

export function categorize(url: string, context = ""): Category {
  const s = (url + " " + context).toLowerCase();

  const yt = /(youtube|youtu\.be|ytdl|yt-?dl|ytsearch|ytmp3|ytmp4|ytplay|yt-audio|yt-?video)/i.test(s);
  const social = /(tiktok|tikwm|tiklydown|instagram|insta-?dl|igdl|igstory|ig-?dl|facebook|fbdown|fbdl|fb-?dl|pinterest|pindl|pin-?dl|pinterestdl|twitter|sndcdn|soundcloud|spotify-?dl|mediafire|terabox|stalk)/i.test(s);
  const aio = /(^|[^a-z])(aio|all-?in-?one|alldown|multi-?dl|mixdl)([^a-z]|$)/i.test(s);
  if (aio && (yt || social || /dl|download/i.test(url))) return "aio-dl";
  if (yt && !social) return "yt-dl";
  if (social) return "social-dl";

  if (/(tts|text-?to-?speech|voice|speech|sound-?of-?text|voicemaker|audio-?api)/i.test(s)) return "ai-voice";
  if (
    /(nano-?banana|dall-?e|diffusion|stable-?diffusion|midjourney|flux|image-?edit|edit-?img|imgedit|enhance|upscale|removebg|remove-?bg|remini|toonify|cartoon|anime-?img|img-?anime|hd-?image|image-?hd|text-?to-?image|text2image|img-?gen|image-?gen|photoleap|face-?swap|avatar|logo-?maker|canva-?api)/i.test(s) ||
    /(\/ai\/(image|img|photo))|(image|photo)\/(edit|enhance|upscale)/i.test(s)
  )
    return "ai-image";
  if (
    /(chatgpt|gpt-?[345o]|openai|gemini(?!.*image)|bard|claude|llama|mistral|deepseek|qwen|blackbox|perplexit|groq|davinchi|ozzochat|vito|ai-?chat|chat-?ai|copilot|text-?gen|llm)/i.test(s)
  )
    return "ai-chat";

  return "other";
}

// ------------------------------------------------------- health check

export type CheckStatus = "ALIVE" | "REACHABLE" | "ERROR" | "DEAD";

export interface CheckResult {
  status: CheckStatus;
  httpCode: number | null;
  ms: number;
}

export async function healthCheck(url: string, timeoutMs = 9000): Promise<CheckResult> {
  const start = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ApiHunter/1.0)" },
    });
    const ms = Date.now() - start;
    let status: CheckStatus;
    if (res.status >= 200 && res.status < 400) status = "ALIVE";
    else if (res.status === 429 || res.status === 401 || res.status === 403) status = "ALIVE"; // up but gated/rate-limited
    else if (res.status >= 400 && res.status < 500) status = "REACHABLE"; // needs params/path
    else status = "ERROR";
    return { status, httpCode: res.status, ms };
  } catch {
    return { status: "DEAD", httpCode: null, ms: Date.now() - start };
  } finally {
    clearTimeout(t);
  }
}

export async function checkPool<T, R>(items: T[], worker: (item: T) => Promise<R>, size = 6): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ------------------------------------------------------- HUB engine (v4)

export interface HubProbeResult {
  status: CheckStatus;
  httpCode: number | null;
  ms: number;
  title: string | null;
}

// Probe the hub's landing page — an API hub answers with HTML/JSON on "/".
export async function probeHubLanding(host: string): Promise<HubProbeResult> {
  const start = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(`https://${host}/`, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ApiHunter/1.0)" },
    });
    const ms = Date.now() - start;
    let title: string | null = null;
    if (res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 60000);
      const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(text);
      if (m) title = m[1].trim().slice(0, 100);
    }
    let status: CheckStatus;
    if (res.status >= 200 && res.status < 400) status = "ALIVE";
    else if (res.status === 429 || res.status === 401 || res.status === 403) status = "ALIVE"; // up but gated
    else if (res.status >= 400 && res.status < 500) status = "REACHABLE";
    else status = "ERROR";
    return { status, httpCode: res.status, ms, title };
  } catch {
    return { status: "DEAD", httpCode: null, ms: Date.now() - start, title: null };
  } finally {
    clearTimeout(t);
  }
}

export function computeTier(endpointCount: number): "ELITE" | "HUB" | "LOW" {
  if (endpointCount >= 8) return "ELITE"; // full multi-API ecosystem
  if (endpointCount >= 2) return "HUB"; // multi-endpoint API site
  return "LOW"; // single stray reference — likely junk
}

export function computeQuality(status: string, endpointCount: number, repoCount: number, aliveEndpoints: number, tier: string): number {
  const base = status === "ALIVE" ? 25 : status === "REACHABLE" ? 12 : 0;
  const epScore = Math.min(45, endpointCount * 3);
  const repoScore = Math.min(15, repoCount * 3);
  const aliveScore = Math.min(15, aliveEndpoints * 2);
  const tierBonus = tier === "ELITE" ? 15 : tier === "HUB" ? 5 : 0;
  return Math.min(100, Math.round(base + epScore + repoScore + aliveScore + tierBonus));
}

// Recount everything known about a host and re-score the hub.
export async function rescoreHub(host: string, repo?: string): Promise<void> {
  try {
    const eps = await db.apiEndpoint.findMany({
      where: { host, ignored: false },
      select: { category: true, status: true },
    });
    const endpointCount = eps.length;
    const aliveEndpoints = eps.filter((e) => e.status === "ALIVE" || e.status === "REACHABLE").length;
    const cats = [...new Set(eps.map((e) => e.category).filter((c) => c !== "other"))];
    const existing = await db.apiHub.findUnique({ where: { host } });
    if (!existing) {
      await db.apiHub.create({
        data: {
          host,
          baseUrl: `https://${host}`,
          reposSeen: repo ? JSON.stringify([repo]) : "[]",
        },
      });
    }
    let reposSeen: string[] = [];
    try {
      reposSeen = JSON.parse((existing?.reposSeen ?? "[]") as string);
    } catch {
      reposSeen = [];
    }
    if (repo && !reposSeen.includes(repo)) reposSeen = [repo, ...reposSeen].slice(0, 12);
    const repoCount = reposSeen.length;
    const status = existing?.status ?? "UNKNOWN";
    const tier = computeTier(endpointCount);
    const quality = computeQuality(status, endpointCount, repoCount, aliveEndpoints, tier);
    await db.apiHub.upsert({
      where: { host },
      create: {
        host,
        baseUrl: `https://${host}`,
        endpointCount,
        aliveEndpoints,
        categories: JSON.stringify(cats),
        reposSeen: JSON.stringify(reposSeen),
        repoCount,
        tier,
        quality,
      },
      update: {
        endpointCount,
        aliveEndpoints,
        categories: JSON.stringify(cats.length ? cats : JSON.parse(existing?.categories ?? "[]")),
        reposSeen: JSON.stringify(reposSeen),
        repoCount,
        tier,
        quality,
        lastSeen: new Date(),
      },
    });
  } catch {
    /* hub scoring must never break a scan */
  }
}

// Probe up to `limit` stale hub landings (cheapest-first: best hubs first).
export async function probeHubs(limit = 6): Promise<void> {
  const stale = await db.apiHub.findMany({
    where: {
      hidden: false,
      OR: [{ lastChecked: null }, { lastChecked: { lt: new Date(Date.now() - 60 * 60 * 1000) } }],
    },
    orderBy: [{ quality: "desc" }],
    take: limit,
  });
  if (stale.length === 0) return;
  log("SYS", `HUB PROBE POOL → ${stale.length} HUB(S) LAND-CHECK`);
  await checkPool(
    stale,
    async (hub) => {
      if (hub.seeded && hub.lastChecked) return true; // re-probe seeds only once per hour via query filter
      const probe = await probeHubLanding(hub.host);
      const eps = await db.apiEndpoint.findMany({ where: { host: hub.host, ignored: false }, select: { status: true } });
      const endpointCount = eps.length;
      const aliveEndpoints = eps.filter((e) => e.status === "ALIVE" || e.status === "REACHABLE").length;
      const tier = computeTier(endpointCount);
      const quality = computeQuality(probe.status, endpointCount, hub.repoCount, aliveEndpoints, tier);
      await db.apiHub.update({
        where: { id: hub.id },
        data: {
          status: probe.status,
          httpCode: probe.httpCode,
          responseMs: probe.ms,
          title: probe.title ?? hub.title,
          lastChecked: new Date(),
          tier,
          quality,
        },
      });
      log(
        probe.status === "ALIVE" ? "OK" : probe.status === "DEAD" ? "WARN" : "INFO",
        `HUB ${hub.host} → ${probe.status}${probe.httpCode ? ` (${probe.httpCode})` : ""} ${probe.ms}ms${probe.title ? ` | "${probe.title}"` : ""}`
      );
      return true;
    },
    4
  );
}

// ------------------------------------------------------- DB persistence

function mergeJsonArray(json: string, incoming: string[], cap: number): string {
  try {
    const arr: unknown[] = JSON.parse(json);
    const merged = [...incoming, ...arr].slice(0, cap);
    // dedupe by r+f+ln key
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of merged) {
      const key = JSON.stringify(item).slice(0, 120);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    }
    return JSON.stringify(out);
  } catch {
    return JSON.stringify(incoming.slice(0, cap));
  }
}

function mergeRepos(json: string, repo: string): string {
  try {
    const arr: string[] = JSON.parse(json);
    const next = [repo, ...arr.filter((r) => r !== repo)].slice(0, 5);
    return JSON.stringify(next);
  } catch {
    return JSON.stringify([repo]);
  }
}

async function saveEndpoint(url: string, host: string, category: Category, repo: string, evidence: EvidenceEntry[]): Promise<boolean> {
  const existing = await db.apiEndpoint.findUnique({ where: { url } });
  if (existing) {
    await db.apiEndpoint.update({
      where: { url },
      data: {
        foundCount: { increment: 1 },
        lastSeen: new Date(),
        category: existing.category === "other" && category !== "other" ? category : existing.category,
        sourceRepos: mergeRepos(existing.sourceRepos, repo),
        evidence: mergeJsonArray(existing.evidence, evidence, 8),
      },
    });
    return false;
  }
  try {
    await db.apiEndpoint.create({
      data: {
        url,
        host,
        category,
        sourceRepos: JSON.stringify([repo]),
        sourceFile: evidence[0]?.f ?? null,
        evidence: JSON.stringify(evidence.slice(0, 8)),
      },
    });
    log("OK", `NEW API [${category}] ${url}`);
    return true;
  } catch (e) {
    // race: a parallel pool worker saved the same URL between findUnique and create
    if ((e as { code?: string })?.code === "P2002") {
      await db.apiEndpoint
        .update({
          where: { url },
          data: {
            foundCount: { increment: 1 },
            lastSeen: new Date(),
            sourceRepos: mergeRepos(JSON.stringify([repo]), repo),
            evidence: mergeJsonArray(JSON.stringify(evidence.slice(0, 8)), evidence, 8),
          },
        })
        .catch(() => undefined);
      return false;
    }
    throw e;
  }
}

async function checkNewEndpoints(urls: string[]): Promise<void> {
  const s = state();
  if (urls.length === 0) return;
  log("SYS", `HEALTH-CHECK POOL → ${urls.length} NEW ENDPOINT(S) x6`);
  await checkPool(
    urls,
    async (url) => {
      const r = await healthCheck(url);
      await db.apiEndpoint.update({
        where: { url },
        data: {
          status: r.status,
          httpCode: r.httpCode,
          responseMs: r.ms,
          lastChecked: new Date(),
          lastAlive: r.status === "ALIVE" ? new Date() : undefined,
          checkCount: { increment: 1 },
        },
      });
      if (r.status === "ALIVE") {
        s.checkedAlive += 1;
        log("OK", `CHECK ${url} → ${r.status} (${r.httpCode}) ${r.ms}ms`);
      } else {
        s.checkedDead += 1;
        log(r.status === "DEAD" ? "WARN" : "INFO", `CHECK ${url} → ${r.status}${r.httpCode ? ` (${r.httpCode})` : ""} ${r.ms}ms`);
      }
      return true;
    },
    6
  );
}

// ------------------------------------------------------- REPO MEMORY (manual-workflow emulation)
// PERSISTENT, PUSH-AWARE repo memory — the operator's manual GitHub routine,
// automated: open a recently-updated repo → check its last push → no new code
// since our last visit → SKIP it, move to the next repo. Only brand-new repos
// and repos with a NEWER pushed_at ever get re-opened. Lives in the DB, so it
// survives restarts and never re-floods the operator with old APIs.

async function repoHasNewCode(repo: RepoItem): Promise<boolean> {
  const pushedAt = new Date(repo.pushed_at);
  if (Number.isNaN(pushedAt.getTime())) return true; // unknown → scan to be safe
  const known = await db.repoState.findUnique({ where: { fullName: repo.full_name } });
  if (!known) return true; // never seen → brand-new target
  return pushedAt > known.pushedAt; // re-open ONLY when new code landed
}

async function markRepoScanned(repo: RepoItem, filesRead: number, endpointsNew: number): Promise<void> {
  try {
    await db.repoState.upsert({
      where: { fullName: repo.full_name },
      create: { fullName: repo.full_name, pushedAt: new Date(repo.pushed_at), filesRead, endpointsNew },
      update: { pushedAt: new Date(repo.pushed_at), filesRead, endpointsNew, lastScannedAt: new Date() },
    });
  } catch {
    /* memory write must never break a scan */
  }
}

function markRepoSkipped(repo: RepoItem): void {
  db.repoState
    .update({ where: { fullName: repo.full_name }, data: { skipCount: { increment: 1 }, lastSkipAt: new Date() } })
    .catch(() => undefined);
}

// ------------------------------------------------------- 24/7 CHAIN (never-stop)

const CHAIN_COOLDOWN_MS = 18_000; // breath between cycles
const RATE_LIMIT_COOLDOWN_MS = 12 * 60 * 1000; // GitHub hourly window — back off, never die
const CHAIN_PRESETS = ["wa-bots", "api-downloader", "ai-apis", "wa-multi", "scrapers"];

export function engageChain(on: boolean, restore = false): void {
  const s = state();
  s.chain247 = on;
  if (s.autoTimer) {
    clearTimeout(s.autoTimer);
    s.autoTimer = null;
  }
  if (on) {
    if (restore) {
      log("SYS", "CHAIN 24/7 RESTORED AFTER RESTART → THE HUNT CONTINUES");
    } else {
      log("SYS", "CHAIN 24/7 ENGAGED → THE HUNT NEVER STOPS");
    }
    s.chainCooldownUntil = Date.now() + 2000;
    scheduleNextChain(2000);
  } else {
    s.chainCooldownUntil = null;
    log("WARN", "CHAIN 24/7 DISENGAGED → SCANNER HALTS");
    if (s.runningScan) requestStop();
  }
}

function scheduleNextChain(delayMs: number): void {
  const s = state();
  if (!s.chain247) return;
  if (s.autoTimer) clearTimeout(s.autoTimer);
  s.autoTimer = setTimeout(() => {
    const st = state();
    if (!st.chain247 || st.runningScan) return;
    void startChainCycle();
  }, delayMs);
}

// SELF-HEALING WATCHDOG — if the chain timer ever dies (HMR quirk, edge case),
// the operator's polling loop re-arms it. The hunt must never stop silently.
export function ensureChainAlive(): void {
  const s = state();
  if (!s.chain247 || s.runningScan || s.autoTimer) return;
  const cd = s.chainCooldownUntil ?? 0;
  const delay = Math.max(1000, cd - Date.now());
  log("WARN", `WATCHDOG: CHAIN TIMER LOST → RE-ARMED (NEXT CYCLE IN ${Math.round(delay / 1000)}s)`);
  scheduleNextChain(delay);
}

// One automatic cycle of the chain — zero operator config, rotates targets.
export async function startChainCycle(): Promise<void> {
  const s = state();
  if (s.runningScan) return;
  const preset = CHAIN_PRESETS[s.chainRuns % CHAIN_PRESETS.length];
  const hoursBack = 48 + (s.chainRuns % 4) * 40; // 48h → 88h → 128h → 168h coverage windows
  const depth = s.chainRuns % 3 === 0 ? "ultra" : "deep"; // every 3rd cycle goes ULTRA
  s.chainRuns += 1;
  log("SYS", `CHAIN CYCLE #${s.chainRuns} AUTO-LAUNCH [${preset} | ${hoursBack}h window | ${depth.toUpperCase()}]`);
  // 40 repos/cycle → backfill sweeps catch up with ALL recent-updated code fast;
  // once covered, push-memory skips old repos in milliseconds (watch mode).
  await runScan({ preset, language: "any", hoursBack, maxRepos: 40, autoCheck: true, depth });
}

// ------------------------------------------------------- main scan loop

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runScan(cfg: ScanConfig) {
  const s = state();
  if (s.runningScan) {
    log("WARN", "SCAN ALREADY RUNNING - IGNORED");
    return;
  }
  s.runningScan = true;
  s.status = "running";
  s.stopRequested = false;
  s.config = cfg;
  s.startedAt = Date.now();
  s.finishedAt = null;
  resetProgress();
  s.scansStarted += 1;

  const depth = DEPTHS[cfg.depth] ? cfg.depth : "deep";
  const depthInfo = DEPTHS[depth];
  const since = new Date(Date.now() - cfg.hoursBack * 3600 * 1000).toISOString().slice(0, 10);
  const lang = langSuffix(cfg.language);
  const queries = PRESETS[cfg.preset]?.build(since, lang) ?? PRESETS["wa-bots"].build(since, lang);

  log("SYS", "════════ SCAN SESSION #".concat(String(s.scansStarted), " ════════"));
  log("SYS", `MODE: ${PRESETS[cfg.preset]?.label ?? cfg.preset} | DEPTH: ${depthInfo.label} (${depthInfo.files} files/repo) | LANG: ${cfg.language || "any"} | SINCE: ${since} | MAX REPOS: ${cfg.maxRepos}`);
  log("INFO", `GITHUB TOKEN: ${s.token ? "OPERATOR TOKEN ACTIVE (5000 req/hr)" : "ANONYMOUS MODE (60 req/hr) - set token for deep scan"}`);

  const scanRun = await db.scanRun.create({
    data: {
      preset: cfg.preset,
      query: queries.join(" | "),
      language: cfg.language || "any",
      depth,
      usedToken: !!s.token,
    },
  });

  let rateLimited = false;
  try {
    // 1. search repos across rotated queries
    const seen = new Map<string, RepoItem>();
    for (const q of queries) {
      if (s.stopRequested) break;
      log("INFO", `QUERY: ${q}`);
      const { repos, rateLimited: rl } = await searchRepos(q, s.token);
      if (rl) {
        rateLimited = true;
        log("ERR", "GITHUB RATE LIMIT HIT - wait or add token");
        break;
      }
      log("OK", `→ ${repos.length} REPOS FOUND`);
      for (const r of repos) if (!seen.has(r.full_name)) seen.set(r.full_name, r);
      await sleep(1200);
    }

    // REPO MEMORY WATCH — the operator's manual workflow, automated:
    // a repo is opened ONLY if it is brand-new OR pushed new code since our
    // last visit. Everything else is skipped — old APIs never resurface.
    const fresh: RepoItem[] = [];
    let skippedOld = 0;
    for (const r of seen.values()) {
      if (await repoHasNewCode(r)) fresh.push(r);
      else {
        skippedOld += 1;
        s.reposSkipped += 1;
        markRepoSkipped(r);
      }
    }
    log("SYS", `WATCH: ${fresh.length} REPO(S) WITH NEW/UNSEEN CODE | ${skippedOld} ALREADY COVERED → SKIPPED (NO NEW PUSH)`);

    const repoList = fresh.slice(0, cfg.maxRepos);
    s.reposQueued = repoList.length;
    log("SYS", `QUEUE: ${repoList.length} UNIQUE REPOS TO RECON [DEPTH ${depthInfo.label}]`);

    let urlsFound = 0;
    let newEndpoints = 0;

    // 2. recon each repo — FULL TREE DEEP SCAN
    for (const repo of repoList) {
      if (s.stopRequested) break;
      s.currentRepo = repo.full_name;
      s.reposDone += 1;
      const repoTag = `[${s.reposDone}/${s.reposQueued}]`;

      let treeInfo = await getRepoTree(repo.full_name, repo.default_branch, s.token);
      let files: TreeFile[];
      if (treeInfo) {
        files = pickFiles(treeInfo.files, depth);
        log("INFO", `${repoTag} RECON → ${repo.full_name} (★${repo.stargazers_count}) | TREE: ${treeInfo.files.length} FILES ${treeInfo.truncated ? "(truncated)" : ""} | QUEUED: ${files.length}`);
      } else {
        log("WARN", `${repoTag} TREE API BLOCKED → RAW-CDN PROBE MODE for ${repo.full_name}`);
        files = await fallbackFiles(repo.full_name, repo.default_branch);
        if (files.length === 0) continue;
      }
      if (files.length === 0) {
        log("INFO", `  NO SCANNABLE FILES IN TREE - skip`);
        await markRepoScanned(repo, 0, 0); // nothing to read here — remember it until next push
        continue;
      }

      s.filesQueued += files.length;

      // per-repo deep scan state
      const repoBases = new Map<string, number>(); // candidate base URLs seen in this repo
      const repoPaths = new Map<string, number>(); // harvested endpoint paths
      const touchedHosts = new Set<string>(); // hosts that gained endpoints this repo
      let repoUrls = 0;
      const newInRepo: string[] = [];
      let filesDone = 0;

      // DEEP PASS — read every queued file in parallel pools (raw CDN)
      await checkPool(
        files,
        async (file) => {
          if (s.stopRequested) return null;
          const text = await fetchRaw(repo.full_name, repo.default_branch, file.path);
          filesDone += 1;
          s.filesRead += 1;
          s.currentFile = file.path;
          if (!text) return null;

          const { urls, paths } = deepExtract(text, file.path);
          for (const p of paths) repoPaths.set(p, (repoPaths.get(p) ?? 0) + 1);
          if (urls.length === 0) return null;

          log("OK", `  ├ ${file.path}:${urls[0].line ?? 0} → ${urls.length} API HIT(S)`);
          for (const u of urls) {
            urlsFound += 1;
            s.urlsFound += 1;
            repoUrls += 1;
            touchedHosts.add(u.host);
            if (hostLooksApi(u.host)) repoBases.set(u.url, Math.max(repoBases.get(u.url) ?? 0, u.score));
            const category = categorize(u.url, u.ctx);
            const evidence: EvidenceEntry[] = [{ r: repo.full_name, f: file.path, ln: u.line, s: u.snippet }];
            const isNew = await saveEndpoint(u.url, u.host, category, repo.full_name, evidence);
            if (isNew) {
              newEndpoints += 1;
              s.newEndpoints = newEndpoints;
              newInRepo.push(u.url);
            }
          }
          return null;
        },
        RAW_POOL
      );

      // CROSS-FILE JOIN — bare bases from configs + endpoint paths from commands/events
      // Only BARE bases (host + optional /v1) join paths — bases that already carry
      // a real path (twilio.com/2010-04-01/Accounts) would fabricate garbage URLs.
      if (!s.stopRequested && repoBases.size > 0 && repoPaths.size > 0) {
        const bareBase = (u: string) => {
          try {
            const path = new URL(u).pathname.replace(/\/+$/, "");
            return path === "" || /^\/v\d{1,2}$/i.test(path);
          } catch {
            return false;
          }
        };
        const bases = [...repoBases.entries()].filter(([u]) => bareBase(u)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u]) => u);
        const paths = [...repoPaths.entries()]
          .filter(([p]) => p.length >= 6 && p.split("/").length >= 3) // real endpoints like /api/ytdl, not /api alone
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40)
          .map(([p]) => p);
        const joins = new Set<string>();
        for (const b of bases)
          for (const p of paths) {
            const candidate = (b + p).replace(/\/+$/, "");
            if (candidate.length <= 200) joins.add(candidate);
            if (joins.size >= 12) break;
          }
        if (bases.length > 0 && joins.size > 0) {
          for (const j of joins) {
            const host = filterCandidateUrl(j);
            if (!host || !hostLooksApi(host)) continue;
            if (await db.apiEndpoint.findUnique({ where: { url: j } })) continue; // only store unseen joins
            const category = categorize(j, "cross-file join");
            const evidence: EvidenceEntry[] = [
              { r: repo.full_name, f: "(cross-file join)", ln: 0, s: `resolved by joining repo config base ${new URL(j).origin} + command path ${new URL(j).pathname}` },
            ];
            const isNew = await saveEndpoint(j, host, category, repo.full_name, evidence);
            if (isNew) {
              urlsFound += 1;
              s.urlsFound += 1;
              newEndpoints += 1;
              s.newEndpoints = newEndpoints;
              newInRepo.push(j);
            }
            touchedHosts.add(host);
          }
          log("INFO", `  └ CROSS-FILE JOIN: ${bases.length} bare base(s) × ${paths.length} path(s) → ${joins.size} candidate(s)`);
        }
      }

      // REPO MEMORY COMMIT — stamp this repo's push time so it is never
      // re-opened until NEW code lands (unless the operator stopped us mid-scan)
      if (!s.stopRequested) await markRepoScanned(repo, filesDone, newInRepo.length);
      log("SYS", `■ ${repo.full_name} → files ${filesDone}/${files.length} | api hits: ${repoUrls} | new: ${newInRepo.length}`);
      await checkNewEndpoints(newInRepo);
      // HUB SYNC — recount every host this repo touched (tier/quality update)
      if (touchedHosts.size > 0) {
        for (const h of touchedHosts) await rescoreHub(h, repo.full_name);
        log("INFO", `  └ HUB SYNC: ${touchedHosts.size} HOST(S) RE-SCORED`);
      }
      await sleep(400);
    }

    // 3. hub landing probes (best hubs first) + finalize
    await probeHubs(6);
    const alive = await db.apiEndpoint.count({ where: { status: "ALIVE" } });
    const dead = await db.apiEndpoint.count({ where: { status: "DEAD" } });
    await db.scanRun.update({
      where: { id: scanRun.id },
      data: {
        status: s.stopRequested ? "stopped" : "done",
        finishedAt: new Date(),
        reposScanned: s.reposDone,
        filesRead: s.filesRead,
        urlsFound,
        newEndpoints,
        aliveCount: alive,
        deadCount: dead,
      },
    });

    if (s.stopRequested) {
      log("SYS", "■ SCAN STOPPED BY OPERATOR");
    } else {
      log("SYS", `■ SCAN COMPLETE [${depthInfo.label}] | repos: ${s.reposDone} | skipped-old: ${s.reposSkipped} | files: ${s.filesRead} | urls: ${urlsFound} | NEW: ${newEndpoints}`);
      log("SYS", `■ DATABASE TOTALS → ALIVE: ${alive} | DEAD: ${dead}`);
    }
    s.status = "idle";
    s.finishedAt = Date.now();
    s.currentRepo = null;
    s.currentFile = null;
  } catch (e) {
    log("ERR", `SCAN FAULT: ${e instanceof Error ? e.message : String(e)}`);
    s.status = "idle";
    s.finishedAt = Date.now();
    try {
      await db.scanRun.update({ where: { id: scanRun.id }, data: { status: "error", finishedAt: new Date() } });
    } catch {
      /* noop */
    }
  } finally {
    s.runningScan = false;
    // 24/7 CHAIN — the hunt never stops unless disengaged
    if (s.chain247) {
      const cooldown = rateLimited ? RATE_LIMIT_COOLDOWN_MS : CHAIN_COOLDOWN_MS;
      s.chainCooldownUntil = Date.now() + cooldown;
      log(
        "SYS",
        rateLimited
          ? `CHAIN: GITHUB WINDOW RESET PENDING → NEXT CYCLE IN ${Math.round(cooldown / 60000)} MIN (NEVER STOPPING)`
          : `CHAIN: NEXT CYCLE IN ${Math.round(cooldown / 1000)}s → THE HUNT CONTINUES`
      );
      scheduleNextChain(cooldown);
    }
    if (rateLimited && !s.token) {
      log("WARN", "TIP: paste a GitHub token in OPERATOR panel for 5000 req/hr deep scanning");
    }
  }
}

export function requestStop() {
  const s = state();
  if (s.runningScan) {
    s.stopRequested = true;
    log("WARN", "STOP SIGNAL RECEIVED - finishing current step...");
  }
}
