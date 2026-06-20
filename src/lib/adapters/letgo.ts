import { BaseAdapter, type SearchFilters, type AdapterResult, type ListingRaw } from './base';
import { getRateLimiter } from '@/lib/utils/rate-limiter';
import * as cheerio from 'cheerio';

/**
 * Letgo Adapter — Gerçek scraping ile çalışan adapter.
 * Letgo, cheerio ile parse edilebilen SSR HTML döndürür.
 *
 * Tek URL tüm Türkiye için aynı 26 ilanı döndürür, bu yüzden
 * kategori bazlı (sedan, hatchback, suv, arazi, mpv, klasik) scrape
 * yapar ve her kategoriden farklı ilanlar toplar.
 */
export class LetgoAdapter extends BaseAdapter {
  sourceName = 'letgo';
  baseUrl = 'https://www.letgo.com';
  defaultDelay = 2000;
  maxConcurrency = 3;

  private rateLimiter = getRateLimiter({
    maxRequests: 20,
    perSeconds: 60,
    key: 'letgo',
  });

  /**
   * Letgo alt kategorileri — her biri farklı ilan seti döndürür.
   * Ana sayfa + 6 alt kategori = ~150+ unique ilan.
   */
  private readonly CATEGORY_PATHS = [
    '/arabalar_c15706',           // Ana kategori
    '/otomobil-suv_c15711',       // SUV
    '/sedan-araba_c15712',        // Sedan
    '/hatchback-araba_c15713',    // Hatchback
    '/arazi-araci_c15714',        // Arazi
    '/mpv-minivan_c15717',        // MPV/Minivan
    '/klasik-araba_c15718',       // Klasik
  ];

  async search(filters: SearchFilters): Promise<AdapterResult> {
    const startTime = Date.now();
    const result: AdapterResult = {
      success: false,
      listings: [],
      totalFound: 0,
      durationMs: 0,
    };

    const allListings: ListingRaw[] = [];
    const seenUrls = new Set<string>();

    try {
      for (const path of this.CATEGORY_PATHS) {
        await this.rateLimiter.wait();

        const url = `${this.baseUrl}${path}`;
        this.log(`Scraping ${path}`);

        try {
          const html = await this.fetchWithPoliteness(url);
          const pageListings = this.parseListingsHtml(html);

          // Dedup by sourceUrl
          let added = 0;
          for (const l of pageListings) {
            if (l.sourceUrl && !seenUrls.has(l.sourceUrl)) {
              seenUrls.add(l.sourceUrl);
              allListings.push(l);
              added++;
            }
          }

          this.log(`  ${path}: ${pageListings.length} parsed, ${added} new (total: ${allListings.length})`);

          // Respect filters.limit
          if (filters.limit && allListings.length >= filters.limit) {
            break;
          }

          // Be polite — wait between categories
          await new Promise((r) => setTimeout(r, this.defaultDelay));
        } catch (error: any) {
          this.log(`  ${path} failed: ${error.message}`, 'warn');
          // Continue to next category even if one fails
        }
      }

      result.success = allListings.length > 0;
      result.listings = allListings;
      result.totalFound = allListings.length;
    } catch (error: any) {
      this.log(`Search failed: ${error.message}`, 'error');
      result.error = error.message;
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /** Parse listings from a single page HTML */
  private parseListingsHtml(html: string): ListingRaw[] {
    const $ = cheerio.load(html);
    const listings: ListingRaw[] = [];
    const items = $('[data-testid*="item"]');

    items.each((_, el) => {
      try {
        const $el = $(el);
        const allText = $el.text().trim();

        // Link
        const link = $el.find('a[href*="/item/"]').first().attr('href') || '';

        // Image
        const img = $el.find('img').first();
        const imgSrc = img.attr('src') || '';
        const alt = img.attr('alt') || '';

        // Title from alt text (format: "Renault MEGANE")
        const titleStr = alt || '';
        const parts = titleStr.split(' ');
        const rawMake = parts[0] || '';
        const rawModel = parts.slice(1).join(' ') || '';

        // Skip non-listing items (logos, badges, icons)
        if (
          !rawMake ||
          rawMake === 'Letgo' ||
          titleStr.includes('Logo') ||
          titleStr.includes('Icon') ||
          titleStr.includes('Damgası') ||
          titleStr === 'chevron-down'
        ) {
          return;
        }

        // Price — pattern: "485.000 TL" or "1.250.000 TL"
        const priceMatch = allText.match(/([0-9]{1,3}(\.[0-9]{3})+)\s*TL/);
        let price = 0;
        if (priceMatch) {
          price = parseInt(priceMatch[1].replace(/\./g, '')) || 0;
        }

        // Year and KM — pattern: "2008 - 311.000 KM" or "2016 - 170.000 KM"
        const yearKmMatch = allText.match(/(\d{4})\s*-\s*([0-9.]+)\s*KM/);
        let year = 0;
        let mileageKm: number | undefined;
        if (yearKmMatch) {
          year = parseInt(yearKmMatch[1]) || 0;
          mileageKm = parseInt(yearKmMatch[2].replace(/\./g, '')) || undefined;
        }

        // City
        const cityMatch = allText.match(
          /(İstanbul|Ankara|İzmir|Bursa|Antalya|Adana|Konya|Gaziantep|Mersin|Kayseri|Eskişehir|Samsun|Denizli|Trabzon|Muğla|Aydın|Balıkesir|Malatya|Erzurum|Diyarbakır|Sakarya|Tekirdağ|Hatay|Manisa|Kocaeli)/,
        );
        const city = cityMatch ? cityMatch[1] : undefined;

        // District (after city, after comma)
        const districtMatch = allText.match(
          /(?:İstanbul|Ankara|İzmir|Bursa|Antalya|Adana|Konya),\s*([A-Za-zçğıöşüÇĞİÖŞÜ]+)/,
        );
        const district = districtMatch ? districtMatch[1] : undefined;

        // Seller type
        const isPlus = allText.includes('Plus Satıcı');
        const sellerType = isPlus ? 'Galeri' : 'Sahibinden';

        // Only add if we have meaningful data — must have a price AND a year (filter out parts/accessories)
        if (rawMake && price > 0 && year > 0) {
          listings.push({
            sourceName: this.sourceName,
            sourceUrl: link ? `${this.baseUrl}${link}` : '',
            make: this.normalizeMake(rawMake),
            model: this.normalizeModel(rawModel),
            year,
            price,
            currency: 'TRY',
            mileageKm,
            fuelType: undefined,
            transmission: undefined,
            bodyType: undefined,
            color: undefined,
            city,
            district,
            sellerType,
            imageUrl: imgSrc || undefined,
            imageUrls: imgSrc ? [imgSrc] : [],
            description: undefined,
          });
        }
      } catch {
        // Skip individual parse errors
      }
    });

    return listings;
  }

  async getDetail(listingId: string): Promise<ListingRaw | null> {
    try {
      await this.rateLimiter.wait();
      const url = `${this.baseUrl}/item/${listingId}`;
      const html = await this.fetchWithPoliteness(url);
      const $ = cheerio.load(html);

      const title = $('title').text().trim();
      const allText = $('body').text();

      const priceMatch = allText.match(/([0-9]{1,3}(\.[0-9]{3})+)\s*TL/);
      const price = priceMatch ? parseInt(priceMatch[1].replace(/\./g, '')) : 0;

      const yearKmMatch = allText.match(/(\d{4})\s*-\s*([0-9.]+)\s*KM/);
      const year = yearKmMatch ? parseInt(yearKmMatch[1]) : 0;
      const mileageKm = yearKmMatch ? parseInt(yearKmMatch[2].replace(/\./g, '')) : undefined;

      const titleParts = title.split(' ').slice(0, 5);
      const make = titleParts[0] || '';
      const model = titleParts.slice(1).join(' ') || '';

      const imageUrls: string[] = [];
      $('img[src*="img.letgo"]').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src) imageUrls.push(src);
      });

      const descMatch = allText.match(/Açıklama\s*([\s\S]*?)(?:\s*Satıcı|$)/);
      const description = descMatch ? descMatch[1].trim().substring(0, 500) : undefined;

      return {
        sourceName: this.sourceName,
        sourceUrl: url,
        make: this.normalizeMake(make),
        model: this.normalizeModel(model),
        year,
        price,
        currency: 'TRY',
        mileageKm,
        imageUrl: imageUrls[0] || undefined,
        imageUrls,
        description,
      };
    } catch (error) {
      this.log(`Detail fetch failed for ${listingId}: ${error}`, 'error');
      return null;
    }
  }

  parseListing(raw: any): ListingRaw {
    return {
      sourceName: this.sourceName,
      sourceUrl: raw.sourceUrl || raw.url || '',
      make: this.normalizeMake(raw.make || ''),
      model: this.normalizeModel(raw.model || ''),
      year: raw.year || 0,
      price: raw.price || 0,
      currency: 'TRY',
      mileageKm: raw.mileageKm || raw.mileage || undefined,
      fuelType: raw.fuelType ? this.normalizeFuel(raw.fuelType) : undefined,
      transmission: raw.transmission ? this.normalizeTransmission(raw.transmission) : undefined,
      bodyType: raw.bodyType ? this.normalizeBodyType(raw.bodyType) : undefined,
      color: raw.color || undefined,
      city: raw.city || undefined,
      district: raw.district || undefined,
      sellerType: raw.sellerType ? this.normalizeSellerType(raw.sellerType) : undefined,
      imageUrl: raw.imageUrl || undefined,
      imageUrls: raw.imageUrls || [],
      description: raw.description || undefined,
    };
  }

  /** No mock fallback — only real data */
  async scrapeFallback(): Promise<ListingRaw[]> {
    return [];
  }
}
