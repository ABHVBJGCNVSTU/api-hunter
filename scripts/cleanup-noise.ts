// One-off cleanup: remove noisy endpoints captured during engine tuning
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const NOISE = ["api.tudominio.com", "jarvis-md.vercel.app", "lokixer.koyeb.app"];

async function main() {
  let total = 0;
  for (const n of NOISE) {
    const r = await db.apiEndpoint.deleteMany({ where: { url: { contains: n } } });
    total += r.count;
    if (r.count) console.log(`deleted ${r.count} x ${n}`);
  }
  const left = await db.apiEndpoint.count();
  console.log(`TOTAL DELETED: ${total} | REMAINING: ${left}`);
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
