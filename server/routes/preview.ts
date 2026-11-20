import { Router } from 'express';
import { z } from 'zod';
import { rateLimitMiddleware } from '../security/auth.ts';
import { getCommerceSiteHtml, submitPublicClientInquiry } from '../commerce/commerceEngine.ts';
import { getReadyPhase7DeliverableHtml } from '../commerce/phase7Engine.ts';

export function createPreviewRouter(): Router {
  const preview = Router();
  const inquiryRateLimit = rateLimitMiddleware(6, 10 * 60 * 1000);

  preview.get('/p7/:id', (req, res) => {
    const rawId = String(req.params.id || '').trim();
    if (!rawId) {
      res.status(404).send('Deliverable preview not found');
      return;
    }
    const html = getReadyPhase7DeliverableHtml(rawId);
    if (!html) {
      res.status(404).send('Validated READY deliverable preview not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "sandbox allow-forms; default-src 'none'; style-src 'unsafe-inline';");
    res.send(html);
  });

  preview.get(['/fisioterapia-atlante', '/:id'], (req, res) => {
    const rawId = req.path === '/fisioterapia-atlante' ? 'site_2e58dc5f-d' : String(req.params.id || '').trim();
    if (!rawId || rawId === 'inquiry') {
      res.status(404).send('Preview not found');
      return;
    }
    const html = getCommerceSiteHtml(rawId);
    if (!html) {
      res.status(404).send('Preview demo not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(html);
  });

  preview.post('/inquiry', inquiryRateLimit, (req, res) => {
    try {
      const schema = z.object({
        name: z.string().min(2).max(80),
        email: z.string().email().max(120),
        phone: z.string().max(40).optional(),
        company: z.string().max(80).optional(),
        notes: z.string().max(400).optional(),
        siteId: z.string().max(60).optional(),
        honeypot: z.string().max(80).optional(),
        consent: z.literal(true),
      });
      const result = submitPublicClientInquiry(schema.parse(req.body));
      res.status(201).json({ received: result.received, message: result.message });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid inquiry submission';
      res.status(400).json({ error: message });
    }
  });

  return preview;
}
