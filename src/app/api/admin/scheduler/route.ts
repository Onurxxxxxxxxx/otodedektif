import { NextResponse } from 'next/server';
import { Scheduler, getSchedulerStatus } from '@/lib/services/scheduler';
import { schedulerBodySchema, safeParse } from '@/lib/validation/schemas';

// ── GET Handler: Get scheduler status ──────────────────────────────────

export async function GET() {
  try {
    const status = getSchedulerStatus();
    return NextResponse.json(status);
  } catch (error) {
    console.error('[API /admin/scheduler] GET Error:', error);
    return NextResponse.json(
      // Sanitize error — don't leak internal message
      { error: 'Failed to get scheduler status' },
      { status: 500 },
    );
  }
}

// ── POST Handler: Start/stop scheduler or trigger manual pipeline ──────

export async function POST(request: Request) {
  try {
    const rawBody = await request.json().catch(() => ({}));
    const body = safeParse(
      schedulerBodySchema,
      rawBody,
      { action: 'trigger' as const },
      'schedulerBody',
    );
    const action = body.action;

    switch (action) {
      case 'start': {
        const intervalMs = body.intervalMs;
        const scheduler = Scheduler.getInstance(undefined, intervalMs);
        scheduler.start();
        return NextResponse.json({ success: true, message: 'Scheduler started' });
      }

      case 'stop': {
        const scheduler = Scheduler.getInstance();
        scheduler.stop();
        return NextResponse.json({ success: true, message: 'Scheduler stopped' });
      }

      case 'trigger': {
        const scheduler = Scheduler.getInstance();
        const result = await scheduler.runPipeline();
        return NextResponse.json({ success: true, result });
      }

      default: {
        // Unreachable due to Zod enum, but TS exhaustiveness check
        const exhaustive: never = action;
        return NextResponse.json(
          { error: `Unknown action: ${exhaustive}` },
          { status: 400 },
        );
      }
    }
  } catch (error) {
    console.error('[API /admin/scheduler] POST Error:', error);
    return NextResponse.json(
      { error: 'Scheduler operation failed' },
      { status: 500 },
    );
  }
}
