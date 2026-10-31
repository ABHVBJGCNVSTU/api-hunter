import { NextRequest, NextResponse } from "next/server";
import { getLogs, getProgress, log, state } from "@/lib/scan-state";
import { engageChain, ensureChainAlive, requestStop, runScan } from "@/lib/scanner-engine";
import { db } from "@/lib/db";
import { ensureInit, setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

// GET → scan status + live logs + database stats (hubs + endpoints)
export async function GET(req: NextRequest) {
  await ensureInit();
  const s = state();
  // watchdog: UI polls this route every few seconds → chain can never die silently
  ensureChainAlive();
  const since = Number(req.nextUrl.searchParams.get("since") ?? 0);

  const [total, alive, reachable, error, dead, hubsTotal, hubsAlive, hubsElite, reposScanned, reposWatched, new24h] = await Promise.all([
    db.apiEndpoint.count({ where: { ignored: false } }),
    db.apiEndpoint.count({ where: { ignored: false, status: "ALIVE" } }),
    db.apiEndpoint.count({ where: { ignored: false, status: "REACHABLE" } }),
    db.apiEndpoint.count({ where: { ignored: false, status: "ERROR" } }),
    db.apiEndpoint.count({ where: { ignored: false, status: "DEAD" } }),
    db.apiHub.count({ where: { hidden: false } }),
    db.apiHub.count({ where: { hidden: false, status: "ALIVE" } }),
    db.apiHub.count({ where: { hidden: false, tier: "ELITE" } }),
    db.scanRun.aggregate({ _sum: { reposScanned: true, filesRead: true } }),
    db.repoState.count(),
    db.apiEndpoint.count({ where: { ignored: false, firstSeen: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
  ]);

  return NextResponse.json({
    progress: getProgress(),
    logs: getLogs(Number.isFinite(since) ? since : 0),
    chain247: s.chain247,
    chainCooldownUntil: s.chainCooldownUntil,
    chainRuns: s.chainRuns,
    tokenSet: !!s.token,
    bootAt: s.bootAt,
    uptimeSec: Math.floor((Date.now() - s.bootAt) / 1000),
    scansStarted: s.scansStarted,
    stats: {
      total,
      alive,
      reachable,
      error,
      dead,
      hubsTotal,
      hubsAlive,
      hubsElite,
      reposScanned: reposScanned._sum.reposScanned ?? 0,
      filesRead: reposScanned._sum.filesRead ?? 0,
      reposWatched, // repos in persistent push-memory (watched for new code)
      new24h, // APIs discovered in the last 24h
    },
  });
}

// POST → one-tap 24/7 hunt control: start = engage never-stop chain, stop = halt
export async function POST(req: NextRequest) {
  await ensureInit();
  const body = await req.json().catch(() => ({}));
  const action = body.action as string;
  const s = state();

  if (action === "stop") {
    engageChain(false);
    await setSetting("chain247", "0");
    return NextResponse.json({ ok: true, chain247: false });
  }

  if (action === "start") {
    if (s.chain247) {
      return NextResponse.json({ ok: false, error: "CHAIN ALREADY ENGAGED" }, { status: 409 });
    }
    log("SYS", "OPERATOR COMMAND ACCEPTED → ENGAGING 24/7 CHAIN");
    engageChain(true);
    await setSetting("chain247", "1");
    return NextResponse.json({ ok: true, chain247: true });
  }

  if (action === "run-once") {
    if (s.runningScan) {
      return NextResponse.json({ ok: false, error: "SCAN ALREADY RUNNING" }, { status: 409 });
    }
    log("SYS", "OPERATOR COMMAND → ONE-SHOT SCAN");
    const { startChainCycle } = await import("@/lib/scanner-engine");
    void startChainCycle();
    return NextResponse.json({ ok: true, started: true });
  }

  if (action === "request-stop") {
    requestStop();
    return NextResponse.json({ ok: true, stopping: true });
  }

  return NextResponse.json({ ok: false, error: "UNKNOWN ACTION" }, { status: 400 });
}
