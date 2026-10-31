import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { probeHubLanding, rescoreHub, computeTier, computeQuality } from "@/lib/scanner-engine";
import { log } from "@/lib/scan-state";
import { ensureInit } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TIERS = ["ELITE", "HUB", "LOW"];

export interface HubEndpointDto {
  url: string;
  path: string;
  category: string;
  status: string;
  httpCode: number | null;
  responseMs: number | null;
  foundCount: number;
}

// GET → list multi-API hubs, best first (ELITE > HUB > LOW, then quality)
export async function GET(req: NextRequest) {
  await ensureInit();
  const sp = req.nextUrl.searchParams;
  const tier = sp.get("tier") ?? "all";
  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  const limit = Math.min(Number(sp.get("limit")) || 60, 120);
  const withEndpoints = sp.get("endpoints") !== "0";

  const where: Record<string, unknown> = { hidden: false };
  if (TIERS.includes(tier)) where.tier = tier;
  if (q) where.host = { contains: q };

  const hubs = await db.apiHub.findMany({
    where,
    orderBy: [{ quality: "desc" }, { endpointCount: "desc" }, { lastSeen: "desc" }],
    take: limit,
  });

  // rank ELITE above HUB above LOW regardless of quality number
  const tierRank: Record<string, number> = { ELITE: 0, HUB: 1, LOW: 2 };
  hubs.sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.quality - a.quality);

  const hosts = hubs.map((h) => h.host);
  const eps = withEndpoints && hosts.length
    ? await db.apiEndpoint.findMany({
        where: { host: { in: hosts }, ignored: false },
        orderBy: [{ foundCount: "desc" }, { lastSeen: "desc" }],
        take: hosts.length * 15,
      })
    : [];

  const byHost = new Map<string, HubEndpointDto[]>();
  for (const e of eps) {
    const list = byHost.get(e.host) ?? [];
    if (list.length >= 14) continue; // cap endpoints shown per hub
    try {
      const u = new URL(e.url);
      list.push({
        url: e.url,
        path: u.pathname + (u.search || ""),
        category: e.category,
        status: e.status,
        httpCode: e.httpCode,
        responseMs: e.responseMs,
        foundCount: e.foundCount,
      });
    } catch {
      continue;
    }
    byHost.set(e.host, list);
  }

  const total = await db.apiHub.count({ where: { hidden: false } });

  return NextResponse.json({
    total,
    items: hubs.map((h) => ({
      id: h.id,
      host: h.host,
      baseUrl: h.baseUrl,
      title: h.title,
      status: h.status,
      quality: h.quality,
      tier: h.tier,
      endpointCount: h.endpointCount,
      aliveEndpoints: h.aliveEndpoints,
      categories: safeParse(h.categories),
      repos: safeParse(h.reposSeen),
      repoCount: h.repoCount,
      httpCode: h.httpCode,
      responseMs: h.responseMs,
      seeded: h.seeded,
      lastChecked: h.lastChecked,
      lastSeen: h.lastSeen,
      endpoints: byHost.get(h.host) ?? [],
    })),
  });
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// POST → recheck a hub landing (optionally + its endpoints) or hide it
export async function POST(req: NextRequest) {
  await ensureInit();
  const body = await req.json().catch(() => ({}));
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const action = body.action as string;
  if (!host) return NextResponse.json({ ok: false, error: "host required" }, { status: 400 });

  const hub = await db.apiHub.findUnique({ where: { host } });
  if (!hub) return NextResponse.json({ ok: false, error: "HUB NOT FOUND" }, { status: 404 });

  if (action === "hide") {
    await db.apiHub.update({ where: { id: hub.id }, data: { hidden: true } });
    log("WARN", `HUB ${host} → MARKED JUNK / HIDDEN BY OPERATOR`);
    return NextResponse.json({ ok: true, hidden: true });
  }

  if (action === "recheck") {
    log("SYS", `OPERATOR PROBE → ${host}`);
    const probe = await probeHubLanding(host);
    const eps = await db.apiEndpoint.findMany({ where: { host, ignored: false }, select: { status: true } });
    const endpointCount = eps.length;
    const aliveEndpoints = eps.filter((e) => e.status === "ALIVE").length;
    const tier = computeTier(endpointCount);
    const quality = computeQuality(probe.status, endpointCount, hub.repoCount, aliveEndpoints, tier);
    await db.apiHub.update({
      where: { id: hub.id },
      data: {
        status: probe.status,
        httpCode: probe.httpCode,
        responseMs: probe.ms,
        title: probe.title ?? hub.title,
        tier,
        quality,
        lastChecked: new Date(),
      },
    });
    log(probe.status === "ALIVE" ? "OK" : "INFO", `HUB ${host} → ${probe.status}${probe.httpCode ? ` (${probe.httpCode})` : ""} ${probe.ms}ms`);
    return NextResponse.json({
      ok: true,
      result: { status: probe.status, httpCode: probe.httpCode, ms: probe.ms, title: probe.title, quality, tier },
    });
  }

  if (action === "rescore") {
    await rescoreHub(host);
    const fresh = await db.apiHub.findUnique({ where: { host } });
    return NextResponse.json({ ok: true, hub: fresh });
  }

  return NextResponse.json({ ok: false, error: "UNKNOWN ACTION" }, { status: 400 });
}
