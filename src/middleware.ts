import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// ── Admin Auth Middleware ──────────────────────────────────────────────
//
// Protects all /api/admin/* endpoints with a bearer token check.
// The token is read from ADMIN_TOKEN env var. If ADMIN_TOKEN is not set,
// all admin endpoints return 503 Service Unavailable (fail-closed).
//
// Public endpoints (NOT affected):
//   - GET /api/listings
//   - GET /api/listings/[id]
//   - GET /api/listings/suggestions
//   - GET /api (health check)
//   - All non-API routes (pages, static assets)
//
// Usage from client:
//   curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://.../api/admin/stats

const ADMIN_PATH_PREFIX = '/api/admin';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect admin endpoints
  if (!pathname.startsWith(ADMIN_PATH_PREFIX)) {
    return NextResponse.next();
  }

  const expectedToken = process.env.ADMIN_TOKEN;

  // Fail-closed: if no token configured, admin endpoints are unavailable
  if (!expectedToken || expectedToken.length < 16) {
    return NextResponse.json(
      {
        error: 'Admin endpoints disabled',
        details:
          'ADMIN_TOKEN environment variable is not configured. Set a strong token (>= 16 chars) to enable admin endpoints.',
      },
      { status: 503 },
    );
  }

  // Extract bearer token from Authorization header
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken = match?.[1]?.trim();

  // Constant-time comparison to prevent timing attacks
  if (!providedToken || providedToken.length !== expectedToken.length) {
    return NextResponse.json(
      { error: 'Unauthorized', details: 'Missing or malformed Authorization header. Expected: Bearer <token>' },
      { status: 401 },
    );
  }

  let diff = 0;
  for (let i = 0; i < expectedToken.length; i++) {
    diff |= expectedToken.charCodeAt(i) ^ providedToken.charCodeAt(i);
  }
  if (diff !== 0) {
    return NextResponse.json(
      { error: 'Unauthorized', details: 'Invalid token' },
      { status: 401 },
    );
  }

  return NextResponse.next();
}

export const config = {
  // Only run middleware on /api/admin/* paths (cheap matcher)
  matcher: ['/api/admin/:path*'],
};
