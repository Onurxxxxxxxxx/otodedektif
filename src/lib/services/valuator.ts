// apps/scraper/src/valuator.ts

import { db } from '@/lib/db';

interface ValueEstimate {
  value: number;
  confidence: 'high' | 'medium' | 'low' | 'insufficient';
  sampleSize: number;
  minPrice: number;
  maxPrice: number;
  medianPrice: number;
  matchLevel?: 'strict' | 'relaxed_fuel' | 'relaxed_year' | 'none';
}

// ── Tunable constants ───────────────────────────────────────────────────

const MIN_SAMPLE_SIZE = 5;
const HIGH_CONFIDENCE_SIZE = 20;
const MEDIUM_CONFIDENCE_SIZE = 10;

// Mileage adjustment guardrails — prevents single outlier from blowing up
// the estimate. Adjustment is clamped to ±20% of median price.
const MILEAGE_ADJ_MAX_PCT = 0.20;
// Slope is also clamped to a sane range (TL per km).
// A reasonable upper bound: a car loses ~50% over 200k km => slope ~ -0.0025
// Lower bound: ~-0.01 TL/km (heavy depreciation). Clamp to [-0.02, 0.0].
const MILEAGE_SLOPE_MIN = -0.02;
const MILEAGE_SLOPE_MAX = 0.0;
// Require at least 3 comparables with non-null mileage to compute adjustment
const MILEAGE_ADJ_MIN_SAMPLES = 3;

export class Valuator {
  /**
   * Run valuation on all active listings.
   * Idempotent — re-running on valued listings updates their estimates.
   */
  static async updateAllListings(): Promise<void> {
    const listings = await db.listing.findMany({
      where: { isActive: true },
      orderBy: { lastSeenAt: 'desc' }
    });

    let updatedCount = 0;
    for (const listing of listings) {
      try {
        const estimate = await this.estimateValue(listing);
        const dealScore = this.calculateDealScore(listing.price, estimate.value);
        const dealTag = this.getDealTag(dealScore, estimate.confidence);

        await db.listing.update({
          where: { id: listing.id },
          data: {
            estimatedValue: estimate.value,
            confidence: estimate.confidence,
            comparableCount: estimate.sampleSize,
            dealScore: dealScore,
            dealTag: dealTag
          }
        });

        updatedCount++;
      } catch (error) {
        console.error(`Error updating listing ${listing.id}:`, error);
      }
    }

    console.log(`Updated ${updatedCount} listings with valuations`);
  }

  /**
   * Estimate market value of a listing using progressive relaxation.
   *
   * Stages (each only applied if previous yielded < MIN_SAMPLE_SIZE):
   *   1. strict:    make+model, year ±1, fuelType + transmission (if both set)
   *   2. relaxed_fuel: drop fuelType + transmission filter entirely
   *   3. relaxed_year: widen year range to ±2
   *
   * Confidence degrades as we relax: high → medium → low.
   */
  private static async estimateValue(listing: any): Promise<ValueEstimate> {
    // ── Stage 1: strict (only filter by fuel/transmission if BOTH are set) ──
    const hasFuel = !!listing.fuelType;
    const hasTransmission = !!listing.transmission;

    const strictWhere: Record<string, unknown> = {
      make: listing.make,
      model: listing.model,
      year: { gte: listing.year - 1, lte: listing.year + 1 },
      isActive: true,
      id: { not: listing.id },
    };
    if (hasFuel && hasTransmission) {
      strictWhere.fuelType = listing.fuelType;
      strictWhere.transmission = listing.transmission;
    }

    let comparables = await db.listing.findMany({
      where: strictWhere as any,
      select: { price: true, mileageKm: true },
    });
    let matchLevel: ValueEstimate['matchLevel'] = 'strict';

    // ── Stage 2: relax fuel + transmission ──
    if (comparables.length < MIN_SAMPLE_SIZE) {
      const relaxedWhere: Record<string, unknown> = {
        make: listing.make,
        model: listing.model,
        year: { gte: listing.year - 1, lte: listing.year + 1 },
        isActive: true,
        id: { not: listing.id },
      };
      comparables = await db.listing.findMany({
        where: relaxedWhere as any,
        select: { price: true, mileageKm: true },
      });
      matchLevel = 'relaxed_fuel';
    }

    // ── Stage 3: relax year range to ±2 ──
    if (comparables.length < MIN_SAMPLE_SIZE) {
      const widerWhere: Record<string, unknown> = {
        make: listing.make,
        model: listing.model,
        year: { gte: listing.year - 2, lte: listing.year + 2 },
        isActive: true,
        id: { not: listing.id },
      };
      comparables = await db.listing.findMany({
        where: widerWhere as any,
        select: { price: true, mileageKm: true },
      });
      matchLevel = 'relaxed_year';
    }

    const sampleSize = comparables.length;

    // ── Insufficient sample → return listing price as-is, low confidence ──
    if (sampleSize < MIN_SAMPLE_SIZE) {
      return {
        value: listing.price,
        confidence: 'insufficient',
        sampleSize,
        minPrice: listing.price,
        maxPrice: listing.price,
        medianPrice: listing.price,
        matchLevel: 'none',
      };
    }

    // ── Compute median price ──
    const prices = comparables.map(c => c.price).sort((a, b) => a - b);
    const medianPrice = this.calculateMedian(prices);

    // ── Mileage adjustment (bounded) ──
    const mileageAdjustment = this.calculateMileageAdjustment(
      comparables,
      listing.mileageKm,
      medianPrice,
    );

    let estimatedValue = Math.round(medianPrice + mileageAdjustment);

    // Guardrail: never go below 1 TL (avoids weird deal scores)
    if (!Number.isFinite(estimatedValue) || estimatedValue <= 0) {
      estimatedValue = Math.max(1, Math.round(medianPrice));
    }

    // ── Confidence (degrades with relaxation) ──
    let confidence: 'high' | 'medium' | 'low' | 'insufficient';
    if (sampleSize >= HIGH_CONFIDENCE_SIZE && matchLevel === 'strict') {
      confidence = 'high';
    } else if (sampleSize >= MEDIUM_CONFIDENCE_SIZE && matchLevel !== 'relaxed_year') {
      confidence = 'medium';
    } else {
      confidence = 'low';
    }

    return {
      value: estimatedValue,
      confidence,
      sampleSize,
      minPrice: prices[0],
      maxPrice: prices[prices.length - 1],
      medianPrice,
      matchLevel,
    };
  }

  /**
   * Bounded linear-regression mileage adjustment.
   *
   * Guards against pathological inputs:
   *   - require >= MILEAGE_ADJ_MIN_SAMPLES comparables with non-null mileage
   *   - clamp slope to [MILEAGE_SLOPE_MIN, MILEAGE_SLOPE_MAX] (always <= 0:
   *     more km never increases value)
   *   - clamp final adjustment to ±MILEAGE_ADJ_MAX_PCT of median price
   */
  private static calculateMileageAdjustment(
    comparables: Array<{ price: number; mileageKm: number | null }>,
    targetMileage: number | null,
    medianPrice: number,
  ): number {
    if (targetMileage == null || targetMileage <= 0) return 0;

    // Only use comparables that HAVE a non-null mileage
    const withMileage = comparables.filter(c => c.mileageKm != null && c.mileageKm > 0);
    if (withMileage.length < MILEAGE_ADJ_MIN_SAMPLES) return 0;

    const prices = withMileage.map(c => c.price);
    const mileages = withMileage.map(c => c.mileageKm as number);

    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const avgMileage = mileages.reduce((a, b) => a + b, 0) / mileages.length;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < withMileage.length; i++) {
      const priceDiff = prices[i] - avgPrice;
      const mileageDiff = mileages[i] - avgMileage;
      numerator += priceDiff * mileageDiff;
      denominator += mileageDiff * mileageDiff;
    }

    if (denominator === 0) return 0;

    let slope = numerator / denominator;
    // Clamp slope — more km should never INCREASE value
    if (slope > MILEAGE_SLOPE_MAX) slope = MILEAGE_SLOPE_MAX;
    if (slope < MILEAGE_SLOPE_MIN) slope = MILEAGE_SLOPE_MIN;

    const mileageDiff = targetMileage - avgMileage;
    let adjustment = slope * mileageDiff;

    // Clamp adjustment to ±MILEAGE_ADJ_MAX_PCT of median price
    const maxAbs = medianPrice * MILEAGE_ADJ_MAX_PCT;
    if (adjustment > maxAbs) adjustment = maxAbs;
    if (adjustment < -maxAbs) adjustment = -maxAbs;

    return adjustment;
  }

  private static calculateMedian(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private static calculateDealScore(price: number, estimatedValue: number): number {
    if (!estimatedValue || estimatedValue <= 0) return 0;
    return (price - estimatedValue) / estimatedValue;
  }

  private static getDealTag(score: number, confidence: string): string {
    if (confidence === 'insufficient') {
      return 'Değerlendirilemedi';
    }

    if (score < -0.15) return 'Harika Fırsat';
    if (score < -0.05) return 'İyi Fiyat';
    if (score < 0.05) return 'Piyasa Fiyatı';
    if (score < 0.15) return 'Piyasa Üstü';
    return 'Pahalı';
  }

  // Belirli bir ilan için manuel değerleme
  static async estimateSingleListing(listingId: string): Promise<ValueEstimate | null> {
    const listing = await db.listing.findUnique({
      where: { id: listingId }
    });

    if (!listing) return null;
    return this.estimateValue(listing);
  }
}

/**
 * Convenience wrapper: run valuation for all active listings.
 * Called by the admin/scrape pipeline.
 *
 * @returns Object with updated count
 */
export async function valueAllListings(): Promise<{
  updated: number;
  skipped: number;
}> {
  try {
    await Valuator.updateAllListings();
    const totalActive = await db.listing.count({
      where: { isActive: true, isDeleted: false, estimatedValue: { not: null } },
    });
    return { updated: totalActive, skipped: 0 };
  } catch {
    return { updated: 0, skipped: 0 };
  }
}
