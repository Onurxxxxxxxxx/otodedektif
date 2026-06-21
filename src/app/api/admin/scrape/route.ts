import { NextResponse } from 'next/server';
import { scrapeAll, scrapeSingle } from '@/lib/services/scraper';
import { valueAllListings } from '@/lib/services/valuator';
import { estimateAllCosts } from '@/lib/services/cost-estimator';
import { runDeduplication } from '@/lib/services/deduplicator';
import { cache } from '@/lib/services/cache';
import type { SearchFilters } from '@/lib/types';
import { scrapeBodySchema, safeParse } from '@/lib/validation/schemas';

// ── POST Handler ───────────────────────────────────────────────────────

/**
 * Trigger scraping pipeline.
 *
 * Body (optional, validated with Zod):
 *   sourceName?: string   — scrape a single source only
 *   filters?: SearchFilters — pass search filters to adapters
 *
 * Auth: protected by middleware (ADMIN_TOKEN bearer).
 */
export async function POST(request: Request) {
  try {
    const rawBody = await request.json().catch(() => ({}));
    const body = safeParse(scrapeBodySchema, rawBody, {}, 'scrapeBody');
    const sourceName: string | undefined = body.sourceName;
    const filters: SearchFilters | undefined = body.filters as SearchFilters | undefined;

    let scrapeResults;

    if (sourceName) {
      // Scrape a single source with optional filters
      const result = await scrapeSingle(sourceName, filters);
      scrapeResults = [result];
    } else {
      // Scrape all sources with optional filters
      scrapeResults = await scrapeAll(filters);
    }

    // After scraping, run valuation engine on all unvalued listings
    const valuationResults = await valueAllListings();

    // Run cost estimator on all listings without cost data
    const costResults = await estimateAllCosts();

    // Run deduplication across all active listings
    const dedupResults = await runDeduplication();

    // Clear cache to ensure fresh results
    await cache.clear();

    return NextResponse.json({
      success: true,
      scrape: scrapeResults,
      valuation: valuationResults,
      costs: costResults,
      deduplication: dedupResults,
    });
  } catch (error) {
    console.error('[API /admin/scrape] Error:', error);
    return NextResponse.json(
      { error: 'Scraping failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
