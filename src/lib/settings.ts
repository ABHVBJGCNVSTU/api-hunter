// API HUNTER - Persistent settings + boot restore
// Token & 24/7 flag are SAVED in the DB (operator asked for persistence:
// "Mai GitHub token Rakh kr save krdon wahan pr ek bar scanning start krdon
//  to ye kabi b nahi rukna chahiye") so scanning survives server restarts.

import { db } from "@/lib/db";
import { log, state } from "@/lib/scan-state";

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

// ---------------------------------------------------------------- seed hubs

// Operator's reference targets — multi-API hubs like the ones he pasted.
// jerrycoder endpoints verified live from its dashboard listing.
const SEED_HUBS: { host: string; baseUrl: string; title: string; endpoints?: string[] }[] = [
  {
    host: "jerrycoder.oggyapi.workers.dev",
    baseUrl: "https://jerrycoder.oggyapi.workers.dev",
    title: "JerryCoder V2 — API Ecosystem",
    endpoints: [
      "/down/tiktok",
      "/down/twitter",
      "/down/subtitle",
      "/search/pin",
      "/search/subtitle",
      "/ai/soraimg",
      "/ai/soravid",
      "/ephoto",
      "/anime/brat",
      "/anime/kiss",
      "/stalk/github",
      "/stalk/npm",
      "/stalk/insta",
      "/stalk/tiktok",
      "/stalk/pin",
      "/stalk/roblox",
      "/tool/rembg",
    ],
  },
  {
    host: "anabot.my.id",
    baseUrl: "https://anabot.my.id",
    title: "AnaBot API — REST Platform",
  },
  {
    host: "api.delirius.online",
    baseUrl: "https://api.delirius.online",
    title: "Delirius API — Free Access",
  },
];

async function seedHubs(): Promise<void> {
  for (const hub of SEED_HUBS) {
    const existing = await db.apiHub.findUnique({ where: { host: hub.host } });
    if (existing) continue;
    await db.apiHub.create({
      data: {
        host: hub.host,
        baseUrl: hub.baseUrl,
        title: hub.title,
        tier: hub.endpoints && hub.endpoints.length >= 6 ? "ELITE" : "HUB",
        quality: hub.endpoints ? Math.min(100, 40 + hub.endpoints.length * 3) : 45,
        endpointCount: hub.endpoints?.length ?? 0,
        categories: JSON.stringify(hub.endpoints ? ["multi"] : []),
        seeded: true,
      },
    });
    if (hub.endpoints) {
      for (const p of hub.endpoints) {
        const url = hub.baseUrl + p;
        const cat = categorizeSeed(p);
        await db.apiEndpoint.upsert({
          where: { url },
          create: { url, host: hub.host, category: cat, sourceRepos: JSON.stringify(["(operator target)"]), sourceFile: "(hub dashboard)", evidence: JSON.stringify([{ r: "(operator target)", f: "hub dashboard listing", ln: 0, s: url }]) },
          update: {},
        });
      }
    }
    log("OK", `SEED TARGET HUB → ${hub.host}`);
  }
}

function categorizeSeed(path: string): string {
  const s = path.toLowerCase();
  if (/ai|sora|gpt/.test(s)) return "ai-image";
  if (/down|tiktok|twitter/.test(s)) return "social-dl";
  if (/search/.test(s)) return "other";
  if (/stalk/.test(s)) return "other";
  if (/anime|ephoto|rembg|tool/.test(s)) return "ai-image";
  return "other";
}

// ---------------------------------------------------------------- boot init

const globalRef = globalThis as unknown as { __apiHunterInit?: Promise<void> };

async function doInit(): Promise<void> {
  const s = state();

  // 1. token: env fallback once, then DB is the source of truth
  const savedToken = await getSetting("github_token");
  if (savedToken) {
    s.token = savedToken;
    log("SYS", `TOKEN RESTORED FROM VAULT → DEEP SCAN MODE [••••${savedToken.slice(-4)}]`);
  } else if (process.env.GITHUB_TOKEN) {
    s.token = process.env.GITHUB_TOKEN;
    await setSetting("github_token", process.env.GITHUB_TOKEN);
    log("SYS", "TOKEN IMPORTED FROM ENV → SAVED TO VAULT");
  }

  // 2. seed the operator's example hubs once
  const hubCount = await db.apiHub.count();
  if (hubCount === 0) {
    log("SYS", "FIRST BOOT → SEEDING OPERATOR TARGET HUBS...");
    await seedHubs();
  }

  // 3. restore 24/7 chain after restart
  const chain = await getSetting("chain247");
  if (chain === "1") {
    const { engageChain } = await import("@/lib/scanner-engine");
    engageChain(true, true);
  }
}

export function ensureInit(): Promise<void> {
  if (!globalRef.__apiHunterInit) {
    globalRef.__apiHunterInit = doInit().catch((e) => {
      log("ERR", `INIT FAULT: ${e instanceof Error ? e.message : String(e)}`);
      globalRef.__apiHunterInit = undefined;
    });
  }
  return globalRef.__apiHunterInit;
}
