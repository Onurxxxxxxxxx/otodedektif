import { PrismaClient } from '@prisma/client'

// ── Prisma Singleton (production-safe) ──────────────────────────────────
//
// Previous behavior only cached the client in development, which caused
// connection storms on serverless cold starts (Vercel). We now always
// reuse a single client per process via globalThis, regardless of
// NODE_ENV. This is the Prisma-recommended pattern for Next.js.
//
// Ref: https://www.prisma.io/docs/guides/nextjs

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: ['error', 'warn'],
  })
}

export const db = globalForPrisma.prisma ?? createPrismaClient()

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = db
}
