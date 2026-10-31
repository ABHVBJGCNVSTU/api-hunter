import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET → export hubs + endpoints as JSON or CSV (operator intel pack)
export async function GET(req: NextRequest) {
  const format = req.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const rows = await db.apiEndpoint.findMany({
    where: { ignored: false },
    orderBy: [{ category: "asc" }, { lastSeen: "desc" }],
  });
  const hubs = await db.apiHub.findMany({
    where: { hidden: false },
    orderBy: [{ tier: "asc" }, { quality: "desc" }],
  });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

  if (format === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["url", "host", "category", "status", "http_code", "response_ms", "repos", "found_count", "first_seen", "last_checked"].map(esc).join(",");
    const lines = rows.map((r) =>
      [
        r.url,
        r.host,
        r.category,
        r.status,
        r.httpCode ?? "",
        r.responseMs ?? "",
        JSON.parse(r.sourceRepos || "[]").join(" ; "),
        r.foundCount,
        r.firstSeen?.toISOString() ?? "",
        r.lastChecked?.toISOString() ?? "",
      ]
        .map(esc)
        .join(",")
    );
    const csv = "\uFEFF" + [header, ...lines].join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="api-hunter-export-${stamp}.csv"`,
      },
    });
  }

  const safeArr = (s: string): string[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };

  const json = {
    generator: "API HUNTER // GitHub Recon Terminal",
    exportedAt: new Date().toISOString(),
    count: rows.length,
    hubs: hubs.map((h) => ({
      host: h.host,
      baseUrl: h.baseUrl,
      title: h.title,
      tier: h.tier,
      quality: h.quality,
      status: h.status,
      endpointCount: h.endpointCount,
      categories: safeArr(h.categories),
      repos: safeArr(h.reposSeen),
    })),
    endpoints: rows.map((r) => ({
      url: r.url,
      host: r.host,
      category: r.category,
      status: r.status,
      httpCode: r.httpCode,
      responseMs: r.responseMs,
      sourceRepos: safeArr(r.sourceRepos),
      foundCount: r.foundCount,
      firstSeen: r.firstSeen,
      lastChecked: r.lastChecked,
    })),
  };
  return new NextResponse(JSON.stringify(json, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="api-hunter-export-${stamp}.json"`,
    },
  });
}
