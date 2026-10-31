import { NextResponse } from "next/server";
import { categorize, deepExtract, extractUrls, healthCheck } from "@/lib/scanner-engine";

export const dynamic = "force-dynamic";

// Sample of a typical WhatsApp bot config file (what the scanner meets in the wild)
const SAMPLE_CONFIG = `
// ==========================================================
// NEXUS-MD WhatsApp Bot — API Configuration
// ==========================================================
module.exports = {
  apiKeys: {
    lolhuman: "free-tier",
    zenz: "premium"
  },
  apis: {
    youtube: "https://api.nexray.eu.cc/api/ytdl?url=",
    tiktok: "https://api.tiklydown.eu.org/api/download?url=",
    instagram: "https://mkzstyleee.vercel.app/api/igdl?url=",
    fbdown: "https://api.theresav.biz.id/api/fbdown?url=",
    pinterest: "https://pinterdl.vercel.app/api/pin?url=",
    aio: "https://jerrycoder.oggyapi.workers.dev/?url=",
    chatgpt: "https://api.gpttalk.us.kg/v1/chat/completions",
    gemini: "https://api.zenzxz.my.id/api/gemini?text=",
    imgedit: "https://eliteprotech-apis.zone.id/api/nano-banana?prompt=",
    remini: "https://api.reminix.zone.id/api/enhance",
    tts: "https://apis.xteam.xyz/tts?lang=hi&text=",
  },
  // docs: https://github.com/example/nexus-md/wiki
  // deploy:
};

// credit: https://whatsapp.com channels - do not remove
`;

// Typical bot COMMAND file the deep scanner must crack:
// base URL hidden in a variable, endpoint built by template/concat
const SAMPLE_COMMAND = `
const handler = async (m) => {
  const API_BASE = "https://api.nexray.eu.cc";
  const AI_HUB = 'https://eliteprotech-apis.zone.id';
  // youtube download command
  let res = await fetch(API_BASE + "/api/ytdl?url=" + m.query);
  // ai image edit command
  let img = await got(\`\${AI_HUB}/api/nano-banana?prompt=\${m.text}\`);
  // direct call-site with full URL
  let tts = await axios.get("https://apis.xteam.xyz/tts?lang=hi&text=hello");
};
`;

const SAMPLE_README = `
## NEXUS-MD
Free WhatsApp bot with 65+ commands.

### Powered by these API providers
- https://api.nexray.eu.cc — downloaders (YT, FB, IG)
- https://eliteprotech-apis.zone.id — AI image edit, nano banana
- visit https://t.me/nexusmd for support
`;

// GET → run extraction self-test (diagnostic)
export async function GET() {
  const fromConfig = extractUrls(SAMPLE_CONFIG, "config.js");
  const fromReadme = extractUrls(SAMPLE_README, "README.md");

  // v3 deep extraction: variable tracking + call-sites on a command file
  const deep = deepExtract(SAMPLE_COMMAND, "commands/download.js");

  const categorized = [...fromConfig, ...fromReadme, ...deep.urls].map((u) => ({
    url: u.url,
    score: u.score,
    line: u.line,
    category: categorize(u.url, u.ctx),
  }));

  // spot-check a known-good and a known-bad target
  const live = await healthCheck("https://api.nexray.eu.cc");
  const dead = await healthCheck("https://definitely-not-a-real-api-999.example.com");

  return NextResponse.json({
    found: categorized,
    deep: {
      urls: deep.urls.map((u) => ({ url: u.url, score: u.score, line: u.line })),
      harvestedPaths: deep.paths,
    },
    excluded: {
      whatsapp: !categorized.some((c) => c.url.includes("whatsapp.com")),
      telegram: !categorized.some((c) => c.url.includes("t.me")),
      github: !categorized.some((c) => c.url.includes("github.com")),
    },
    checks: { live, dead },
  });
}
