import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'], // query logging floods dev.log during 24/7 scans
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db