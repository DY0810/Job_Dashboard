import { z } from 'zod';

import { MAX_BATCH, sendAll, sendConfigured, sendGate } from '@/lib/send';

/**
 * Send the drafts the compose panel built.
 *
 * The body is composed in the browser and posted here as finished text — this route does no
 * templating. That keeps one property worth keeping: what the preview showed is byte-for-byte
 * what leaves, because nothing rewrites it in between.
 *
 * Runs on Node, not Edge: SMTP is a TCP protocol and the Edge runtime has no sockets.
 */
export const runtime = 'nodejs';

const Message = z.object({
  // Deliberately loose. Full RFC 5322 validation rejects addresses that work, and the real
  // check is the SMTP server's — a bad address comes back in `failed` with its reason.
  to: z.string().trim().min(3).max(320).includes('@'),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
});

const Payload = z.object({ messages: z.array(Message).min(1).max(MAX_BATCH) });

/** Whether the button should offer to send at all, so the UI can say why rather than fail. */
export async function GET() {
  return Response.json({ configured: sendConfigured(), maxBatch: MAX_BATCH });
}

export async function POST(request: Request) {
  const denied = sendGate(request);
  if (denied) return denied;

  const input = Payload.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return Response.json({ error: 'invalid messages' }, { status: 400 });
  }

  try {
    const result = await sendAll(input.data.messages);
    // 207: some sent, some did not. A flat 200 would let a partial failure read as success,
    // and the whole point of sending one envelope per recipient is knowing which one missed.
    return Response.json(result, { status: result.failed.length > 0 ? 207 : 200 });
  } catch (error) {
    console.error('POST /api/send', error);
    return Response.json({ error: 'could not send' }, { status: 500 });
  }
}
