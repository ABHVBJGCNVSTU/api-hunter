import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkPool, healthCheck } from "@/lib/scanner-engine";
import { log } from "@/lib/scan-state";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST → recheck one endpoint, or a batch of stale ones ({ all: true })
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  if (body.id) {
    const ep = await db.apiEndpoint.findUnique({ where: { id: body.id } });
    if (!ep) return NextResponse.json({ ok: false, error: "NOT FOUND" }, { status: 404 });
    const r = await healthCheck(ep.url);
    const updated = await db.apiEndpoint.update({
      where: { id: ep.id },
      data: {
        status: r.status,
        httpCode: r.httpCode,
        responseMs: r.ms,
        lastChecked: new Date(),
        lastAlive: r.status === "ALIVE" ? new Date() : undefined,
        checkCount: { increment: 1 },
      },
    });
    log(r.status === "ALIVE" ? "OK" : r.status === "DEAD" ? "WARN" : "INFO", `MANUAL CHECK ${ep.url} → ${r.status}${r.httpCode ? ` (${r.httpCode})` : ""} ${r.ms}ms`);
    return NextResponse.json({ ok: true, result: { status: r.status, httpCode: r.httpCode, ms: r.ms }, endpoint: { id: updated.id, status: updated.status, httpCode: updated.httpCode, responseMs: updated.responseMs } });
  }

  if (body.all) {
    // recheck up to 40 oldest-checked non-ignored endpoints
    const batch = await db.apiEndpoint.findMany({
      where: { ignored: false },
      orderBy: [{ lastChecked: "asc" }],
      take: 40,
    });
    if (batch.length === 0) return NextResponse.json({ ok: true, checked: 0 });
    log("SYS", `BATCH RECHECK → ${batch.length} ENDPOINTS (POOL x6)`);
    let alive = 0;
    let dead = 0;
    await checkPool(
      batch,
      async (ep) => {
        const r = await healthCheck(ep.url);
        await db.apiEndpoint.update({
          where: { id: ep.id },
          data: {
            status: r.status,
            httpCode: r.httpCode,
            responseMs: r.ms,
            lastChecked: new Date(),
            lastAlive: r.status === "ALIVE" ? new Date() : undefined,
            checkCount: { increment: 1 },
          },
        });
        if (r.status === "ALIVE") alive++;
        if (r.status === "DEAD") dead++;
        log(r.status === "ALIVE" ? "OK" : r.status === "DEAD" ? "WARN" : "INFO", `RECHECK ${ep.host} → ${r.status}${r.httpCode ? ` (${r.httpCode})` : ""}`);
        return true;
      },
      6
    );
    log("SYS", `BATCH RECHECK DONE → ALIVE: ${alive} | DEAD: ${dead}`);
    return NextResponse.json({ ok: true, checked: batch.length, alive, dead });
  }

  return NextResponse.json({ ok: false, error: "id or all required" }, { status: 400 });
}
