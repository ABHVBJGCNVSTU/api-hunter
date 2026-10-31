import { NextRequest, NextResponse } from "next/server";
import { log, state } from "@/lib/scan-state";
import { fetchRateLimit } from "@/lib/scanner-engine";
import { ensureInit, setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

// GET → operator vault status + GitHub rate limit (token never returned)
export async function GET() {
  await ensureInit();
  const s = state();
  const rate = await fetchRateLimit(s.token);
  return NextResponse.json({
    tokenSet: !!s.token,
    tokenHint: s.token ? `••••••••${s.token.slice(-4)}` : null,
    chain247: s.chain247,
    chainRuns: s.chainRuns,
    rateLimit: rate,
  });
}

// POST → save GitHub token to the DB VAULT (survives restarts) or toggle chain
export async function POST(req: NextRequest) {
  await ensureInit();
  const body = await req.json().catch(() => ({}));
  const s = state();

  if (typeof body.token === "string") {
    const token = body.token.trim();
    if (token === "") {
      s.token = null;
      await setSetting("github_token", "");
      log("SYS", "VAULT WIPED → ANONYMOUS MODE (60 req/hr)");
      return NextResponse.json({ ok: true, tokenSet: false });
    }
    if (!/^gh[pousr]_[A-Za-z0-9_]{20,}$/.test(token) && token.length < 30) {
      return NextResponse.json({ ok: false, error: "TOKEN FORMAT INVALID (expected ghp_...)" }, { status: 400 });
    }
    s.token = token;
    await setSetting("github_token", token); // PERSIST — never lost on restart
    log("SYS", `TOKEN SAVED TO VAULT → DEEP SCAN MODE UNLOCKED (5000 req/hr) [••••${token.slice(-4)}]`);
    return NextResponse.json({ ok: true, tokenSet: true, tokenHint: `••••••••${token.slice(-4)}` });
  }

  if (typeof body.chain247 === "boolean") {
    const { engageChain } = await import("@/lib/scanner-engine");
    engageChain(body.chain247);
    await setSetting("chain247", body.chain247 ? "1" : "0");
    return NextResponse.json({ ok: true, chain247: s.chain247 });
  }

  return NextResponse.json({ ok: false, error: "NOTHING TO UPDATE" }, { status: 400 });
}

// DELETE → wipe saved token from vault
export async function DELETE() {
  const s = state();
  s.token = null;
  await setSetting("github_token", "");
  log("SYS", "VAULT WIPED → ANONYMOUS MODE");
  return NextResponse.json({ ok: true, tokenSet: false });
}
