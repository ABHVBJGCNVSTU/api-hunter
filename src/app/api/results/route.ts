import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const CATEGORIES = ["yt-dl", "social-dl", "aio-dl", "ai-chat", "ai-image", "ai-voice", "other"];
const STATUSES = ["ALIVE", "REACHABLE", "ERROR", "DEAD", "UNKNOWN"];

// GET → list discovered endpoints with filters
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const category = sp.get("category") ?? "all";
  const status = sp.get("status") ?? "all";
  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  const limit = Math.min(Number(sp.get("limit")) || 60, 200);
  const sort = sp.get("sort") ?? "new"; // new | alive | checks

  const where: Record<string, unknown> = { ignored: false };
  if (status === "good") where.status = { notIn: ["DEAD", "ERROR"] }; // operator's falto-filter: hide dead junk by default
  else if (STATUSES.includes(status)) where.status = status;
  if (category === "core")
    // operator's use-case: multi-API hub endpoints (downloaders + AI) — admin-panel junk stays out
    where.category = { in: ["yt-dl", "social-dl", "aio-dl", "ai-chat", "ai-image", "ai-voice"] };
  else if (CATEGORIES.includes(category)) where.category = category;
  if (q) where.url = { contains: q };
  const host = (sp.get("host") ?? "").trim().slice(0, 120);
  if (host) where.host = host;

  const orderBy =
    sort === "alive"
      ? [{ status: "asc" as const }, { firstSeen: "desc" as const }] // ALIVE first, then discovery order
      : sort === "checks"
        ? [{ foundCount: "desc" as const }]
        : [{ firstSeen: "desc" as const }]; // "new" = DISCOVERY order (firstSeen never changes → old APIs never resurface on top)

  const sinceMs = Number(sp.get("since") ?? 0);
  if (Number.isFinite(sinceMs) && sinceMs > 0) where.firstSeen = { gt: new Date(sinceMs) };

  const items = await db.apiEndpoint.findMany({ where, orderBy, take: limit });

  const total = await db.apiEndpoint.count({ where });

  return NextResponse.json({
    total,
    items: items.map((e) => ({
      id: e.id,
      url: e.url,
      host: e.host,
      category: e.category,
      status: e.status,
      httpCode: e.httpCode,
      responseMs: e.responseMs,
      repos: JSON.parse(e.sourceRepos || "[]"),
      sourceFile: e.sourceFile,
      evidence: JSON.parse(e.evidence || "[]") as { r: string; f: string; ln: number; s: string }[],
      foundCount: e.foundCount,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      lastChecked: e.lastChecked,
      checkCount: e.checkCount,
      isNew: Date.now() - new Date(e.firstSeen).getTime() < 24 * 3600 * 1000,
    })),
  });
}

// DELETE → ignore (hide) an endpoint
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  await db.apiEndpoint.update({ where: { id }, data: { ignored: true } });
  return NextResponse.json({ ok: true });
}
