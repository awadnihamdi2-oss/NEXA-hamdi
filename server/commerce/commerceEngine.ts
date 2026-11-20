import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import { decideApproval, requestApproval, saveArtifact } from '../kernel/masterKernel.ts';
import { searchPublicWebSignals } from '../research/researchEngine.ts';
import { wrapUntrustedContext } from '../security/auth.ts';

export function isExternalCommerceEnabled(): boolean {
  return (process.env.NEXA_EXTERNAL_COMMERCE_ENABLED || 'false').trim().toLowerCase() === 'true';
}

export type CustomerStage =
  | 'LEAD'
  | 'QUALIFIED'
  | 'CONTACTED'
  | 'RESPONDED'
  | 'NEGOTIATION'
  | 'PROPOSAL_SENT'
  | 'ACCEPTED'
  | 'CUSTOMER_WON'
  | 'CHURNED';
export type ProposalStatus = 'DRAFT' | 'APPROVED' | 'SENT' | 'WON' | 'LOST';

function isPrivateOrBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().trim();
  if (!lower || lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  if (net.isIPv4(lower)) {
    const parts = lower.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  if (net.isIPv6(lower)) {
    if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }
  }
  return false;
}

export function validatePublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid website URL format.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http:// and https:// public URLs are permitted.');
  }
  if (isPrivateOrBlockedHostname(parsed.hostname)) {
    throw new Error('Blocked non-public or loopback target hostname (SSRF protection).');
  }
  return parsed;
}

export async function assertResolvedHostPublic(parsed: URL): Promise<void> {
  if (isPrivateOrBlockedHostname(parsed.hostname)) {
    throw new Error('Blocked non-public or loopback target hostname (SSRF protection).');
  }
  if (net.isIP(parsed.hostname)) return;
  try {
    const records = await Promise.race([
      dns.promises.lookup(parsed.hostname, { all: true }),
      new Promise<Array<{ address: string }>>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 2500)),
    ]);
    for (const rec of records) {
      if (isPrivateOrBlockedHostname(rec.address)) {
        throw new Error('Blocked host resolving to private or loopback network (SSRF DNS guard).');
      }
    }
  } catch (err) {
    if (err instanceof Error && /SSRF/i.test(err.message)) throw err;
    // Allow fetch path to handle transient offline/DNS errors gracefully
  }
}

async function fetchPublicHttpSafe(initialUrl: URL, headers: Record<string, string>, timeoutMs = 8000): Promise<globalThis.Response> {
  let current = initialUrl;
  for (let hop = 0; hop < 4; hop++) {
    await assertResolvedHostPublic(current);
    const resp = await fetch(current.toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return resp;
      current = validatePublicHttpUrl(new URL(loc, current).toString());
      continue;
    }
    return resp;
  }
  throw new Error('Too many HTTP redirects during public presence audit.');
}

export async function auditBusinessWebsiteLive(params: {
  url: string;
  customerId?: string | null;
}) {
  const parsed = validatePublicHttpUrl(params.url);
  const id = `aud_${crypto.randomUUID().slice(0, 10)}`;
  const start = Date.now();
  const hasSsl = parsed.protocol === 'https:';

  let httpStatus: number | null = null;
  let finalUrl = parsed.toString();
  let loadTimeMs: number | null = null;
  let hasTitle = false;
  let hasMetaDesc = false;
  let hasViewport = false;
  let hasContactCta = false;
  let hasFormBooking = false;
  const detectedGaps: string[] = [];
  const contactEmailsFound = new Set<string>();
  const contactPhonesFound = new Set<string>();
  let sourceMode: 'VERIFIED_LIVE_HTTP' | 'OFFLINE_OR_UNREACHABLE' = 'OFFLINE_OR_UNREACHABLE';
  let summary = '';

  if (!hasSsl) detectedGaps.push('Site served over insecure HTTP — missing TLS/HTTPS certificate.');

  const extractContacts = (html: string) => {
    const rawEmails = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    for (const e of rawEmails) {
      const clean = e.trim().toLowerCase();
      if (!/(example\.com|dominio\.com|sentry|wixpress|schema\.org|noreply)/i.test(clean) && !/\.(png|jpg|jpeg|gif|svg|css|js)$/i.test(clean)) {
        contactEmailsFound.add(clean);
      }
    }
    const rawTels = html.match(/tel:([+\d][\d\s().-]{5,18})/gi) || [];
    for (const t of rawTels) {
      const cleaned = t.replace(/^tel:/i, '').replace(/%20/g, ' ').trim();
      if (cleaned.length >= 7) contactPhonesFound.add(cleaned);
    }
  };

  try {
    const resp = await fetchPublicHttpSafe(
      parsed,
      {
        'User-Agent': 'NEXA-COMMERCE-AUDIT/1.0 (+public-presence-check)',
        Accept: 'text/html,application/xhtml+xml',
      },
      8000
    );
    loadTimeMs = Date.now() - start;
    httpStatus = resp.status;
    finalUrl = resp.url || parsed.toString();
    const rawHtml = (await resp.text()).slice(0, 250000);
    sourceMode = 'VERIFIED_LIVE_HTTP';

    if (httpStatus >= 400) {
      detectedGaps.push(
        `Live URL returned HTTP ${httpStatus}${httpStatus === 410 ? ' (410 Gone — site removed/broken)' : httpStatus === 404 ? ' (404 Not Found)' : ' (HTTP error)'}.`
      );
      summary = `Live HTTP ${httpStatus} ERROR in ${loadTimeMs}ms (${parsed.hostname}). Target URL is returning an error page.`;
    } else {
      const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      hasTitle = Boolean(titleMatch && titleMatch[1].trim().length >= 3);
      if (!hasTitle) detectedGaps.push('Missing or empty HTML <title> tag for search visibility.');

      hasMetaDesc = /<meta[^>]+name=["']description["'][^>]*content=["'][^"']{10,}/i.test(rawHtml);
      if (!hasMetaDesc) detectedGaps.push('Missing SEO <meta name="description"> summary.');

      hasViewport = /<meta[^>]+name=["']viewport["']/i.test(rawHtml);
      if (!hasViewport) detectedGaps.push('Missing mobile responsive <meta name="viewport"> tag.');

      hasFormBooking = /<form[\s>]/i.test(rawHtml);
      hasContactCta = /(<form[\s>]|mailto:|tel:|contact|contatt|book|prenota|schedule|whatsapp)/i.test(rawHtml);
      if (!hasContactCta) detectedGaps.push('No clear lead capture form, booking CTA, mailto, or phone link detected.');
      else if (!hasFormBooking) detectedGaps.push('Homepage lacks a direct studio-owned booking/contact <form> for instant mobile capture.');

      if (/HTML 4\.01|XHTML 1\.0 Transitional|Dreamweaver|Sitebuilder 4\./i.test(rawHtml)) {
        detectedGaps.push('Built on legacy HTML4/XHTML 1.0 fixed-layout template rather than responsive HTML5.');
      }

      if (loadTimeMs > 2500) detectedGaps.push(`Slow initial HTTP response (${loadTimeMs}ms > 2500ms target).`);

      extractContacts(rawHtml);

      // Probe 1 verified internal contact page on same origin when useful
      const contactHrefMatch = rawHtml.match(/href=["']([^"'#]*(?:contatt|contact)[^"'#]*)["']/i);
      if (contactHrefMatch && contactHrefMatch[1]) {
        try {
          const contactUrl = validatePublicHttpUrl(new URL(contactHrefMatch[1], finalUrl).toString());
          if (contactUrl.hostname === new URL(finalUrl).hostname) {
            const cr = await fetchPublicHttpSafe(
              contactUrl,
              { 'User-Agent': 'NEXA-COMMERCE-AUDIT/1.0' },
              4000
            );
            if (cr.ok) {
              const ch = (await cr.text()).slice(0, 150000);
              extractContacts(ch);
              if (/<form[\s>]/i.test(ch)) hasFormBooking = true;
            }
          }
        } catch {
          // ignore secondary page fetch errors
        }
      }

      const fencedTitle = titleMatch ? wrapUntrustedContext('web_audit_title', titleMatch[1].trim().slice(0, 120)) : 'none';
      summary = `Live HTTP ${httpStatus} in ${loadTimeMs}ms (${parsed.hostname}). Title sample: ${fencedTitle}. Solvable gaps: ${detectedGaps.length}.`;
    }
  } catch (err) {
    loadTimeMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : 'Network unreachable';
    detectedGaps.push(`Target unreachable or blocked (${msg}) — unable to verify live HTML response.`);
    summary = `OFFLINE_OR_UNREACHABLE for ${parsed.toString()}: ${msg}`;
  }

  let digitalReadinessScore = 0;
  if (sourceMode === 'VERIFIED_LIVE_HTTP' && httpStatus !== null && httpStatus < 400) {
    digitalReadinessScore =
      (hasSsl ? 25 : 0) +
      (hasTitle ? 20 : 0) +
      (hasMetaDesc ? 20 : 0) +
      (hasViewport ? 20 : 0) +
      (hasContactCta ? 15 : 0);
  }

  getDb()
    .prepare(
      `INSERT INTO commerce_presence_audits
       (id, customer_id, target_url, http_status, load_time_ms, has_ssl, has_title, has_meta_desc, has_viewport, has_contact_cta, detected_gaps_json, digital_readiness_score, source_mode, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      params.customerId || null,
      parsed.toString(),
      httpStatus,
      loadTimeMs,
      hasSsl ? 1 : 0,
      hasTitle ? 1 : 0,
      hasMetaDesc ? 1 : 0,
      hasViewport ? 1 : 0,
      hasContactCta ? 1 : 0,
      JSON.stringify(detectedGaps),
      digitalReadinessScore,
      sourceMode,
      summary,
      nowIso()
    );

  recordAuditEvent('commerce_engine', 'COMMERCE', 'WEBSITE_PRESENCE_AUDITED', {
    id,
    url: parsed.toString(),
    sourceMode,
    httpStatus,
    digitalReadinessScore,
    gapsCount: detectedGaps.length,
  });

  return {
    id,
    targetUrl: parsed.toString(),
    finalUrl,
    httpStatus,
    loadTimeMs,
    hasSsl,
    hasTitle,
    hasMetaDesc,
    hasViewport,
    hasContactCta,
    hasFormBooking,
    contactEmailsFound: Array.from(contactEmailsFound),
    contactPhonesFound: Array.from(contactPhonesFound),
    detectedGaps,
    digitalReadinessScore,
    sourceMode,
    summary,
  };
}

export async function discoverMarketOpportunitiesLive(params: {
  niche: string;
  cityOrMarket: string;
}) {
  const niche = params.niche.trim();
  const market = params.cityOrMarket.trim();
  if (niche.length < 3) throw new Error('Business niche is required.');

  const webResearch = await searchPublicWebSignals(`${niche} small business digital automation online booking`, 4);
  const topEvidence =
    webResearch.status === 'VERIFIED_LIVE' && webResearch.signals.length > 0
      ? `LIVE WEB RESEARCH (${webResearch.signals.length} verified public sources): ${webResearch.signals
          .slice(0, 2)
          .map((s) => `${s.title} (${s.url})`)
          .join(' | ')}`
      : `NO LIVE WEB SIGNALS VERIFIED (${webResearch.status}: ${webResearch.errorMessage || 'offline'}) — niche template pending customer interviews.`;

  const created = createOpportunity({
    title: `${niche} — Digital Presence & Lead Triage Automation (${market})`,
    targetMarket: `${niche} SMBs (${market})`,
    problemStatement: `Local ${niche.toLowerCase()} businesses lose high-intent prospects due to slow response times, missing mobile booking flows, and weak SEO metadata.`,
    estimatedEffortHours: 18,
    revenueModel: 'EUR 450 Setup + EUR 120/mo Managed Automation',
    evidenceNotes: topEvidence,
  });

  return {
    opportunity: created,
    webResearchStatus: webResearch.status,
    verifiedSignalsCount: webResearch.signals.length,
    signals: webResearch.signals,
  };
}

export function createOpportunity(params: {
  title: string;
  targetMarket: string;
  problemStatement: string;
  estimatedEffortHours: number;
  revenueModel: string;
  evidenceNotes?: string;
}) {
  const title = params.title.trim();
  if (title.length < 4) throw new Error('Opportunity title is required.');
  const id = `opp_${crypto.randomUUID().slice(0, 10)}`;
  const effortScore = Math.max(20, 100 - Math.min(params.estimatedEffortHours, 120) * 0.5);
  const clarityBonus = params.problemStatement.trim().length >= 40 ? 15 : 5;
  const validationScore = Number(Math.min(95, effortScore * 0.75 + clarityBonus).toFixed(1));

  getDb()
    .prepare(
      `INSERT INTO commerce_opportunities
       (id, title, target_market, problem_statement, estimated_effort_hours, revenue_model, validation_score, status, evidence_notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'EVALUATING', ?, ?)`
    )
    .run(
      id,
      title,
      params.targetMarket.trim(),
      params.problemStatement.trim(),
      params.estimatedEffortHours,
      params.revenueModel.trim(),
      validationScore,
      params.evidenceNotes || 'Hypothesis only — requires live website audit or customer discovery.',
      nowIso()
    );

  recordAuditEvent('operator', 'COMMERCE', 'OPPORTUNITY_CREATED', { id, title, validationScore });
  return getDb().prepare('SELECT * FROM commerce_opportunities WHERE id = ?').get(id);
}

export function createLeadCustomer(params: {
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  channel?: string;
  stage?: CustomerStage;
  notes?: string;
}) {
  if (!params.name.trim()) throw new Error('Contact name is required.');
  const id = `cus_${crypto.randomUUID().slice(0, 10)}`;
  getDb()
    .prepare(
      `INSERT INTO commerce_customers (id, name, company, email, phone, channel, stage, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      params.name.trim(),
      params.company?.trim() || null,
      params.email?.trim() || null,
      params.phone?.trim() || null,
      params.channel || 'inbound_local',
      params.stage || 'LEAD',
      params.notes?.trim() || null,
      nowIso()
    );
  recordAuditEvent('operator', 'COMMERCE', 'CRM_CONTACT_ADDED', { id, name: params.name, stage: params.stage || 'LEAD' });
  return getDb().prepare('SELECT * FROM commerce_customers WHERE id = ?').get(id);
}

export function advanceCustomerStage(customerId: string, stage: CustomerStage) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(customerId);
  if (!existing) throw new Error('CRM contact not found.');
  db.prepare('UPDATE commerce_customers SET stage = ? WHERE id = ?').run(stage, customerId);
  recordAuditEvent('operator', 'COMMERCE', 'CRM_STAGE_UPDATED', { customerId, stage });
  return db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(customerId);
}

function sanitizePublicField(raw: string | undefined, maxLen: number): string {
  if (!raw) return '';
  return raw
    .replace(/[\u0000-\u001F\u007F<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function submitPublicClientInquiry(params: {
  name: string;
  company?: string;
  email: string;
  phone?: string;
  notes?: string;
  siteId?: string;
  honeypot?: string;
  consent?: boolean;
}) {
  if (params.honeypot && params.honeypot.trim().length > 0) {
    throw new Error('Automated spam submission rejected.');
  }
  if (params.consent === false) {
    throw new Error('Privacy consent is required before submitting an inquiry.');
  }
  const cleanName = sanitizePublicField(params.name, 80);
  const cleanEmail = sanitizePublicField(params.email, 120).toLowerCase();
  const cleanPhone = sanitizePublicField(params.phone, 40);
  const cleanCompany = sanitizePublicField(params.company, 80);
  const cleanNotes = sanitizePublicField(params.notes, 400);
  const cleanSiteId = sanitizePublicField(params.siteId, 60);

  if (cleanName.length < 2) throw new Error('Your name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
    throw new Error('A valid contact email address is required.');
  }
  if (cleanPhone && !/^[+\d\s().-]{6,25}$/.test(cleanPhone)) {
    throw new Error('Please enter a valid phone number format.');
  }

  const db = getDb();
  let linkedOppId: string | null = null;
  if (cleanSiteId) {
    const siteExists = db.prepare('SELECT id FROM commerce_sites WHERE id = ?').get(cleanSiteId) as { id: string } | undefined;
    if (!siteExists && cleanSiteId !== 'site_2e58dc5f-d') {
      throw new Error('Preview site reference not found.');
    }
    const oppRow = db.prepare('SELECT id FROM commerce_opportunities WHERE site_id = ? LIMIT 1').get(cleanSiteId) as
      | { id: string }
      | undefined;
    linkedOppId = oppRow?.id || (cleanSiteId === 'site_2e58dc5f-d' ? 'opp_a6f09661-2' : null);
  }

  const channel = cleanSiteId ? `web_mvp_${cleanSiteId}` : 'public_web_mvp';
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recentDup = db
    .prepare('SELECT id FROM commerce_customers WHERE lower(email) = ? AND channel = ? AND created_at >= ? LIMIT 1')
    .get(cleanEmail, channel, fiveMinutesAgo) as { id: string } | undefined;

  if (recentDup) {
    return {
      received: true,
      duplicateSuppressed: true,
      leadId: recentDup.id,
      message:
        cleanSiteId === 'site_2e58dc5f-d'
          ? 'Richiesta già registrata di recente. La segreteria dello studio potrà confermare orario e disponibilità al recapito indicato.'
          : 'Recent inquiry already received. An operator will review and respond.',
    };
  }

  const customer = createLeadCustomer({
    name: cleanName,
    company: cleanCompany || undefined,
    email: cleanEmail,
    phone: cleanPhone || undefined,
    channel,
    stage: 'LEAD',
    notes: `${cleanNotes || 'Inbound inquiry submitted via preview demo.'} [GDPR consent: ${params.consent === true ? 'EXPLICIT_YES' : 'IMPLIED_TEST'} @ ${nowIso().slice(0, 16)}Z]`,
  }) as Record<string, unknown>;

  if (linkedOppId) {
    db.prepare('UPDATE commerce_customers SET opportunity_id = ? WHERE id = ?').run(linkedOppId, String(customer.id));
  }

  recordAuditEvent('public_web', 'COMMERCE', 'PUBLIC_INQUIRY_LOGGED', {
    siteId: cleanSiteId || null,
    opportunityId: linkedOppId,
    hasPhone: Boolean(cleanPhone),
    consentRecorded: true,
  });

  return {
    received: true,
    leadId: String(customer.id),
    message:
      cleanSiteId === 'site_2e58dc5f-d'
        ? 'Richiesta ricevuta correttamente. La segreteria dello studio potrà confermare orario e disponibilità al recapito indicato.'
        : 'Inquiry saved cleanly. An operator will review and respond.',
  };
}

export interface CommercialTermsBreakdown {
  proposalVersion: string;
  supplierLegalStatus: string;
  setupPriceEur: number;
  monthlyRetainerEur: number;
  monthlyOptional: boolean;
  paymentTermsDraft: string;
  missingOperatorLegalFields: string[];
  domainAndHostingResponsibility: string;
  taxAssumption: string;
  deliveryTimeline: string;
  setupScope: string[];
  setupExclusions: string[];
  monthlyObligations: string[];
  monthlyExclusions: string[];
}

export function buildCommercialTermsBreakdown(
  setupPriceEur: number,
  monthlyRetainerEur: number,
  lang: 'en' | 'it' | 'ar' | 'fr' = 'it'
): CommercialTermsBreakdown {
  if (lang === 'it') {
    return {
      proposalVersion: 'v2.0',
      supplierLegalStatus: 'MISSING_OPERATOR_LEGAL_AND_TAX_DETAILS',
      setupPriceEur,
      monthlyRetainerEur,
      monthlyOptional: true,
      paymentTermsDraft:
        'Da confermare prima dell’invio vincolante: es. 50% alla conferma ordine e 50% al collaudo finale prima della pubblicazione definitiva, via bonifico bancario (IBAN fornitore da inserire).',
      missingOperatorLegalFields: [
        'Ragione Sociale / Nome Legale completo del fornitore emittente',
        'Partita IVA / Codice Fiscale e inquadramento fiscale (Regime Forfettario L. 190/2014 vs Ordinario + IVA 22%)',
        'Indirizzo sede legale / domicilio fiscale fornitore e PEC',
        'Coordinate bancarie (IBAN e intestatario conto) per il pagamento',
        'Termini definitivi di pagamento, modalità consegna credenziali e clausola recesso/forza maggiore',
      ],
      domainAndHostingResponsibility:
        'Il nome a dominio e gli account registrar restano di esclusiva titolarità e proprietà dello Studio cliente; il canone mensile opzionale copre esclusivamente hosting HTTPS gestito, monitoraggio SSL, backup e 2h/mese di manutenzione.',
      taxAssumption:
        'Importi indicati in EUR, al netto di eventuale IVA (o regime forfettario ex L. 190/2014 applicabile al fornitore) e oneri di legge da definire in sede di fatturazione fiscale; la presente proposta non costituisce fattura fiscale.',
      deliveryTimeline:
        '7 giorni lavorativi dalla conferma dei testi e dei recapiti dello studio (Giorno 1–2: revisione contenuti e tariffe; Giorno 3–4: implementazione responsive HTTPS e modulo prenotazione CRM; Giorno 5–7: collaudo smartphone iOS/Android e messa online).',
      setupScope: [
        'Progettazione e messa online del restyling HTML5 responsive mobile-first (<meta name="viewport">, navigazione leggibile da smartphone, CTA cliccabile e barra fissa mobile).',
        'Organizzazione fedele dei contenuti reali dello studio (profilo professionale, elenco trattamenti verificati, tariffe indicative, orari 09:00–19:00, indicazioni Metro/bus e note su convenzioni).',
        'Modulo diretto di richiesta visita / prima valutazione con invio immediato verso email dello studio e registro CRM dedicato.',
        'Ottimizzazione SEO locale di base (title, meta description, OpenGraph e dati sede) + verifica certificato HTTPS/TLS.',
        'Collaudo cross-device (iOS Safari, Android Chrome, Desktop) prima della pubblicazione definitiva.',
      ],
      setupExclusions: [
        'Budget pubblicitario o gestione campagne sponsorizzate (Google Ads, Meta Ads).',
        'Servizi fotografici/video professionali in sede o redazione ex novo di testi clinici specialistici.',
        'Integrazioni API bidirezionali con software gestionali sanitari terzi, agende MioDottore/Doctolib, fatturazione elettronica o Sistema Tessera Sanitaria.',
        'Rinnovo annuale del nome a dominio o caselle PEC presso il registrar attuale (intestazione e proprietà restano sempre al cliente).',
        'Aree riservate pazienti con login/referti o versioni multi-lingua aggiuntive non concordate.',
      ],
      monthlyObligations:
        monthlyRetainerEur > 0
          ? [
              'Hosting HTTPS gestito ad alta disponibilità, monitoraggio uptime e verifica continua del certificato SSL.',
              'Backup settimanali della versione pubblicata e della configurazione del modulo richieste.',
              'Fino a 2 ore/mese di aggiornamenti ordinari (variazioni tariffe, nuovi orari feriali/estivi, inserimento o modifica trattamenti).',
              'Aggiornamenti di sicurezza/compatibilità browser mobile e supporto tecnico prioritario entro 1 giorno lavorativo (disdetta libera con preavviso di 30 giorni, nessun vincolo).',
            ]
          : ['Nessun canone mensile attivo richiesto (gestione autonoma dopo consegna).'],
      monthlyExclusions:
        monthlyRetainerEur > 0
          ? [
              'Sviluppo di nuove sezioni complesse, portali prenotazione o funzionalità software personalizzate oltre le 2 ore/mese incluse.',
              'Attività SEO avanzate continuative (link building, blog editoriale mensile) o gestione profili social.',
              'Consulenza legale/DPO GDPR o adeguamenti normativi sanitari esterni (lo studio resta unico Titolare del Trattamento dati).',
            ]
          : ['Manutenzione evolutiva e hosting continuativo esclusi salvo attivazione canone mensile.'],
    };
  }
  return {
    proposalVersion: 'v2.0',
    supplierLegalStatus: 'MISSING_OPERATOR_LEGAL_AND_TAX_DETAILS',
    setupPriceEur,
    monthlyRetainerEur,
    monthlyOptional: true,
    paymentTermsDraft: 'Confirm prior to binding issue: e.g. 50% deposit on kickoff / 50% on UAT sign-off via bank transfer.',
    missingOperatorLegalFields: [
      'Supplier full legal entity name',
      'Tax ID / VAT registration & tax regime confirmation',
      'Supplier registered office address & official billing email',
      'Bank settlement coordinates (IBAN / account holder)',
      'Binding payment schedule, cancellation terms & jurisdiction clause',
    ],
    domainAndHostingResponsibility:
      'Client retains 100% domain ownership and registrar credentials; optional monthly retainer covers managed hosting & SSL monitoring only.',
    taxAssumption:
      'Amounts quoted in EUR exclusive of applicable VAT or statutory withholding/flat-rate tax regime verified prior to fiscal invoicing; this proposal is non-fiscal.',
    deliveryTimeline:
      '7 business days from content sign-off (Days 1–2 copy & service verification; Days 3–4 responsive HTTPS & booking CRM wiring; Days 5–7 cross-device mobile QA & launch).',
    setupScope: [
      'Mobile-first HTML5 responsive website upgrade with verified <meta name="viewport"> and sticky mobile call/booking bar.',
      'Structured organization of verified business details, service catalog, hours, transit, and contact details.',
      'Direct appointment / callback request form logged directly to CRM and studio inbox.',
      'Baseline local SEO tags, OpenGraph metadata, and HTTPS verification.',
    ],
    setupExclusions: [
      'Paid advertising spend or ongoing Google/Meta Ads management.',
      'On-site photography/video production or bespoke multi-page medical copywriting.',
      'Third-party EMR/EHR API integrations, patient login portals, or extra language localizations.',
      'Existing domain registrar renewal fees (client retains 100% domain ownership).',
    ],
    monthlyObligations:
      monthlyRetainerEur > 0
        ? [
            'Managed HTTPS hosting, uptime monitoring, and SSL renewal checks.',
            'Weekly configuration & site backups.',
            'Up to 2 hours/month of routine updates (hours, pricing, service list changes) with 1-business-day support response (cancel anytime with 30 days notice).',
          ]
        : ['No monthly retainer active.'],
    monthlyExclusions: [
      'Major new feature development beyond 2 hours/month.',
      'Ongoing content marketing, link building, or social media management.',
      'Formal GDPR DPO legal counsel.',
    ],
  };
}

export function buildConciseWhatsAppMessage(params: {
  clientName: string;
  websiteUrl?: string | null;
  demoLink?: string | null;
  setupPriceEur: number;
  monthlyRetainerEur: number;
  language?: 'en' | 'it' | 'ar' | 'fr';
}): string {
  const client = params.clientName.trim();
  const demo = params.demoLink || '/preview/fisioterapia-atlante';
  if ((params.language || 'it') === 'it') {
    const firstGreeting = /atlante/i.test(client)
      ? 'Buongiorno Dott.ssa Moriglia e Team di Studio Fisioterapia Atlante,'
      : `Buongiorno Team di ${client},`;
    return [
      firstGreeting,
      `abbiamo visitato ${params.websiteUrl || 'il vostro sito'} e notato che da smartphone manca il ridimensionamento mobile (viewport) e un modulo diretto per richiedere appuntamento dalla homepage.`,
      `Abbiamo preparato una breve anteprima gratuita dedicata allo studio (senza impegno) con i vostri trattamenti, orari e modulo richiesta visita: ${demo}`,
      `Se può essere utile, offriamo la messa online completa in 7 giorni a €${params.setupPriceEur} una tantum (canone mensile €${params.monthlyRetainerEur}/mese opzionale). Restiamo a disposizione per inviarle i dettagli via email.`,
    ].join('\n\n');
  }
  return `Hello ${client} team, we reviewed ${params.websiteUrl || 'your online presence'} and prepared a non-binding mobile-first preview with direct booking request (${demo}). Turnkey delivery is €${params.setupPriceEur} in 7 days (optional €${params.monthlyRetainerEur}/mo SLA). Let us know if you would like a quick link via email.`;
}

export function createCommercialProposal(params: {
  opportunityId?: string | null;
  customerId?: string | null;
  siteId?: string | null;
  clientName: string;
  title: string;
  problemSummary: string;
  pricingTier?: 'STARTER' | 'GROWTH' | 'MANAGED_SLA';
  estimatedEffortHours?: number;
  hourlyCostEur?: number;
  infraCostEur?: number;
  setupPriceEur: number;
  monthlyRetainerEur?: number;
  language?: 'en' | 'it' | 'ar' | 'fr';
  address?: string | null;
  city?: string | null;
  publicSourceUrl?: string | null;
  websiteUrl?: string | null;
  demoUrl?: string | null;
}) {
  if (params.clientName.trim().length < 2) throw new Error('Client name is required.');
  if (params.title.trim().length < 4) throw new Error('Proposal title is required.');
  if (params.setupPriceEur <= 0) throw new Error('Setup price must be positive.');

  const id = `prop_${crypto.randomUUID().slice(0, 10)}`;
  const client = params.clientName.trim();
  const lang = params.language || 'en';
  const effortHours = Math.max(1, params.estimatedEffortHours ?? 14);
  const hourlyCost = Math.max(0, params.hourlyCostEur ?? 15);
  const infraCost = Math.max(0, params.infraCostEur ?? 10);
  const monthlyRetainer = Math.max(0, params.monthlyRetainerEur ?? 0);
  const estimatedDeliveryCostEur = Number((effortHours * hourlyCost + infraCost).toFixed(2));
  const estimatedMarginEur = Number((params.setupPriceEur - estimatedDeliveryCostEur).toFixed(2));
  const tier = params.pricingTier || 'STARTER';
  const demoLink =
    params.demoUrl ||
    (params.siteId === 'site_2e58dc5f-d'
      ? '/preview/fisioterapia-atlante'
      : params.siteId
        ? `/preview/${params.siteId}`
        : null);

  const deliverables =
    lang === 'it'
      ? [
          'Versione web responsive mobile-first moderna con modulo diretto di richiesta visita / appuntamento',
          'Ottimizzazione viewport smartphone, meta tag SEO locali e acquisizione diretta dei contatti senza dipendere esclusivamente da portali esterni',
          'Flusso immediato di raccolta richieste in CRM con conferma rapida al paziente / cliente',
        ]
      : [
          'Responsive high-speed storefront landing page with contact & lead capture form',
          'SEO metadata, OpenGraph tags, HTTPS deployment verification & mobile viewport audit',
          'Automated CRM lead logging + structured follow-up workflow',
        ];

  const commercialTerms = buildCommercialTermsBreakdown(params.setupPriceEur, monthlyRetainer, lang);

  const outreachSubject =
    lang === 'it'
      ? `Proposta mobile-first e anteprima privata per ${client}${params.city ? ` (${params.city})` : ''}`
      : `Digital presence audit & conversion upgrade demo for ${client}`;

  const italianAuditIntro = params.websiteUrl
    ? `abbiamo analizzato il vostro sito web pubblico (${params.websiteUrl})${params.address ? ` per la sede di ${params.address}` : ''} e rilevato aspetti tecnici concreti e verificabili su smartphone: ${params.problemSummary.trim()}`
    : `abbiamo effettuato una verifica sui registri pubblici${params.address ? ` (${params.address})` : ''} e rilevato che la vostra attività può aumentare le richieste da smartphone grazie a una pagina dedicata di prenotazione e contatto.`;

  const isAtlante = /atlante/i.test(client);
  const outreachBody =
    lang === 'it'
      ? [
          isAtlante
            ? 'Gentile Dott.ssa Moriglia e Team di Studio Fisioterapia Atlante,'
            : `Gentile Team di ${client},`,
          '',
          italianAuditIntro,
          '',
          `Per mostrarvi concretamente il risultato senza alcun impegno, abbiamo preparato un'anteprima privata basata esclusivamente sui dati reali già pubblici dello studio${demoLink ? `:\nAnteprima Demo Privata: ${demoLink}` : '.'}`,
          '',
          'Cosa migliora concretamente rispetto al sito attuale:',
          ...deliverables.map((d) => `- ${d}`),
          '',
          `Offerta trasparente: EUR ${params.setupPriceEur} una tantum (consegna in 7 giorni lavorativi dalla conferma dei testi).`,
          ...(monthlyRetainer > 0
            ? [
                `Servizio opzionale di hosting, backup e aggiornamenti fino a 2h/mese: EUR ${monthlyRetainer}/mese (senza vincoli, disdicibile con 30 giorni di preavviso).`,
              ]
            : []),
          'Esclusioni chiare: budget pubblicitario, foto/video in sede, integrazioni con gestionali sanitari esterni e rinnovo registrar dominio restano esclusi.',
          '',
          'Se le fa piacere esaminare insieme l’anteprima privata con una breve chiamata o un riscontro via email, resto a completa disposizione.',
          '',
          'Cordiali saluti,',
          'Team Consulenza Digitale',
        ].join('\n')
      : [
          `Hello ${client} team,`,
          '',
          `While reviewing your digital storefront readiness, we identified actionable improvements: ${params.problemSummary.trim()}`,
          '',
          `We prepared a working non-binding prototype + remediation plan (${tier}):`,
          ...deliverables.map((d) => `- ${d}`),
          '',
          `Proposed investment: EUR ${params.setupPriceEur}${monthlyRetainer > 0 ? ` setup + EUR ${monthlyRetainer}/month SLA (optional)` : ' one-time setup'}.`,
          '',
          'Reply if you would like a 10-minute walkthrough of the live preview.',
        ].join('\n');

  const whatsappMessage = buildConciseWhatsAppMessage({
    clientName: client,
    websiteUrl: params.websiteUrl,
    demoLink,
    setupPriceEur: params.setupPriceEur,
    monthlyRetainerEur: monthlyRetainer,
    language: lang,
  });

  const followUpPlan = [
    { dayOffset: 3, channel: 'email', action: 'Share interactive demo preview link & 3-point speed summary' },
    { dayOffset: 7, channel: 'email', action: 'Offer 15-minute review & custom copy adjustment' },
    { dayOffset: 14, channel: 'close_loop', action: 'Polite archive notice unless interested in next quarter window' },
  ];

  const presentationMd = [
    `# ${lang === 'it' ? 'Presentazione Commerciale Su Misura' : 'Tailored Customer Presentation'}: ${client}`,
    `- **Proposal ID:** ${id}`,
    `- **${lang === 'it' ? 'Sede Verificata' : 'Verified Address'}:** ${params.address || params.city || 'N/A'}`,
    ...(params.websiteUrl ? [`- **${lang === 'it' ? 'Sito Ufficiale Attuale' : 'Current Official Website'}:** ${params.websiteUrl}`] : []),
    ...(params.publicSourceUrl ? [`- **${lang === 'it' ? 'Fonte Pubblica Verificata' : 'Verified Public Source'}:** ${params.publicSourceUrl}`] : []),
    ...(demoLink ? [`- **${lang === 'it' ? 'Demo Interattiva Privata' : 'Interactive Demo URL'}:** ${demoLink}`] : []),
    '',
    `## 1. ${lang === 'it' ? 'Analisi Presenza Digitale Attuale' : 'Current Digital Presence Audit'}`,
    params.problemSummary.trim(),
    '',
    `## 2. ${lang === 'it' ? 'Soluzione & Ambito Incluso (Setup €' + params.setupPriceEur + ')' : 'Delivered Solution & Scope'}`,
    ...commercialTerms.setupScope.map((d) => `- ${d}`),
    '',
    `## 3. ${lang === 'it' ? 'Tempi di Consegna' : 'Delivery Timeline'}`,
    commercialTerms.deliveryTimeline,
    '',
    `## 4. ${lang === 'it' ? 'Servizio Mensile Opzionale (EUR ' + monthlyRetainer + '/mese) & Obblighi SLA' : 'Optional Monthly Maintenance SLA'}`,
    ...commercialTerms.monthlyObligations.map((o) => `- ${o}`),
    '',
    `## 5. ${lang === 'it' ? 'Esclusioni Esplicite' : 'Explicit Exclusions'}`,
    ...(lang === 'it' ? ['### Escluso dal Setup Una Tantum:'] : ['### Excluded from One-Time Setup:']),
    ...commercialTerms.setupExclusions.map((ex) => `- ${ex}`),
    ...(lang === 'it' ? ['### Escluso dal Canone Mensile:'] : ['### Excluded from Monthly Retainer:']),
    ...commercialTerms.monthlyExclusions.map((ex) => `- ${ex}`),
    '',
    `## 6. ${lang === 'it' ? 'Piano Economico & Costi Interni Operatore' : 'Pricing & Unit Economics'}`,
    `- **Tier:** ${tier}`,
    `- **${lang === 'it' ? 'Setup Attivazione' : 'Setup Price'}:** EUR ${params.setupPriceEur}`,
    `- **${lang === 'it' ? 'Canone Mensile Gestito (Opzionale)' : 'Monthly Retainer (Optional)'}:** EUR ${monthlyRetainer}/mo`,
    `- **${lang === 'it' ? 'Note Fiscali' : 'Tax Assumption'}:** ${commercialTerms.taxAssumption}`,
    `- **Estimated Internal Delivery Cost:** EUR ${estimatedDeliveryCostEur} (${effortHours}h @ EUR ${hourlyCost}/h + EUR ${infraCost} infra)`,
    `- **Estimated First-Month Net Margin:** EUR ${estimatedMarginEur}`,
    '',
    `## 7. ${lang === 'it' ? 'Bozza Email (NON INVIATA — In Attesa di Approvazione)' : 'Approval-Gated Email Draft (UNSENT)'}`,
    `**Subject:** ${outreachSubject}`,
    '',
    outreachBody,
    '',
    `## 8. ${lang === 'it' ? 'Bozza WhatsApp Separata (NON INVIATA — Verificare Numero Fisso/Business Prima dell’Invio)' : 'Approval-Gated WhatsApp Draft (UNSENT)'}`,
    whatsappMessage,
  ].join('\n');

  const artifact = saveArtifact({
    subsystem: 'autonomous_commerce',
    name: `proposal_${id}.md`,
    mimeType: 'text/markdown',
    content: presentationMd,
    metadata: { proposalId: id, clientName: client, setupPriceEur: params.setupPriceEur, language: lang },
  });

  const approvalId = requestApproval({
    category: 'commerce_outreach',
    action: `SEND_PROPOSAL_${id}_TO_${client.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
    payload: {
      proposalId: id,
      clientName: client,
      setupPriceEur: params.setupPriceEur,
      language: lang,
      externalActionsEnabled: isExternalCommerceEnabled(),
    },
  });

  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO commerce_proposals
       (id, opportunity_id, customer_id, site_id, artifact_id, title, client_name, pricing_tier, setup_price_eur, monthly_retainer_eur, estimated_delivery_cost_eur, estimated_margin_eur, deliverables_json, outreach_subject, outreach_body, whatsapp_message, commercial_terms_json, follow_up_plan_json, status, approval_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`
    )
    .run(
      id,
      params.opportunityId || null,
      params.customerId || null,
      params.siteId || null,
      artifact.id,
      params.title.trim(),
      client,
      tier,
      params.setupPriceEur,
      monthlyRetainer,
      estimatedDeliveryCostEur,
      estimatedMarginEur,
      JSON.stringify(deliverables),
      outreachSubject,
      outreachBody,
      whatsappMessage,
      JSON.stringify(commercialTerms),
      JSON.stringify(followUpPlan),
      approvalId,
      ts,
      ts
    );

  recordAuditEvent('operator', 'COMMERCE', 'PROPOSAL_PREPARED', {
    id,
    approvalId,
    setupPriceEur: params.setupPriceEur,
    estimatedDeliveryCostEur,
    language: lang,
  });
  return getDb().prepare('SELECT * FROM commerce_proposals WHERE id = ?').get(id);
}

export function updateProposalStatus(proposalId: string, status: ProposalStatus) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM commerce_proposals WHERE id = ?').get(proposalId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error('Proposal not found.');

  if (status === 'SENT' || status === 'APPROVED') {
    const approvalId = Number(row.approval_id || 0);
    if (approvalId > 0) {
      const gate = db.prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId) as { status: string } | undefined;
      if (gate && gate.status !== 'approved') {
        throw new Error(`Human approval gate #${approvalId} must be approved before marking proposal ${status}.`);
      }
    }
  }

  db.prepare('UPDATE commerce_proposals SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), proposalId);
  if (status === 'WON' && row.customer_id) {
    db.prepare("UPDATE commerce_customers SET stage = 'CUSTOMER_WON' WHERE id = ?").run(String(row.customer_id));
  } else if (status === 'SENT' && row.customer_id) {
    db.prepare("UPDATE commerce_customers SET stage = 'PROPOSAL_SENT' WHERE id = ?").run(String(row.customer_id));
  }

  recordAuditEvent('operator', 'COMMERCE', 'PROPOSAL_STATUS_UPDATED', { proposalId, status });
  return db.prepare('SELECT * FROM commerce_proposals WHERE id = ?').get(proposalId);
}

export function generateMarketingContentAsset(params: {
  opportunityId?: string | null;
  customerId?: string | null;
  channel: 'LANDING_COPY' | 'EMAIL_OUTREACH' | 'FOLLOW_UP_SEQ' | 'LINKEDIN_POST';
  brandName: string;
  targetAudience: string;
  offerSummary: string;
  language?: 'en' | 'it' | 'ar' | 'fr';
}) {
  const id = `cnt_${crypto.randomUUID().slice(0, 10)}`;
  const lang = params.language || 'en';
  const brand = params.brandName.trim();
  const title = `${params.channel}: ${brand} (${params.targetAudience.trim()})`;
  const body =
    params.channel === 'EMAIL_OUTREACH'
      ? `Subject: Quick audit for ${brand}\n\nHi team,\nWe help ${params.targetAudience.trim()} solve ${params.offerSummary.trim()} with transparent fixed-scope delivery.\nWould a quick preview link be useful?`
      : params.channel === 'FOLLOW_UP_SEQ'
        ? `Day 3: Share audit checklist for ${brand}.\nDay 7: Send interactive HTML storefront demo.\nDay 14: Confirm archive or next quarter follow-up.`
        : params.channel === 'LINKEDIN_POST'
          ? `How ${params.targetAudience.trim()} capture more inbound leads with ${params.offerSummary.trim()} — built with clean engineering and measurable conversion hygiene.`
          : `Headline: ${brand} — ${params.offerSummary.trim()}\nAudience: ${params.targetAudience.trim()}\nPrimary CTA: Request Consultation`;

  const approvalId = requestApproval({
    category: 'commerce_content',
    action: `PUBLISH_CONTENT_${id}`,
    payload: { id, channel: params.channel, brand },
  });

  getDb()
    .prepare(
      `INSERT INTO commerce_content_assets
       (id, opportunity_id, customer_id, channel, title, body, language, status, approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`
    )
    .run(id, params.opportunityId || null, params.customerId || null, params.channel, title, body, lang, approvalId, nowIso());

  recordAuditEvent('operator', 'COMMERCE', 'CONTENT_ASSET_GENERATED', { id, channel: params.channel, approvalId });
  return getDb().prepare('SELECT * FROM commerce_content_assets WHERE id = ?').get(id);
}

export function recordFinancialEntry(params: {
  entryType: 'REVENUE' | 'OPERATING_COST';
  category: string;
  amountEur: number;
  proposalId?: string | null;
  invoiceId?: string | null;
  verifiedPayment?: boolean;
  notes?: string;
  recordedBy?: string;
}) {
  if (params.amountEur <= 0) throw new Error('Ledger amount must be greater than 0.');
  const db = getDb();
  const verified = params.entryType === 'REVENUE' ? Boolean(params.verifiedPayment) : true;

  if (params.entryType === 'REVENUE' && verified && params.invoiceId) {
    const inv = db.prepare('SELECT approval_id FROM commerce_invoices WHERE id = ?').get(params.invoiceId) as
      | { approval_id: number | null }
      | undefined;
    if (inv?.approval_id) {
      const gate = db.prepare('SELECT status FROM approvals WHERE id = ?').get(inv.approval_id) as { status: string } | undefined;
      if (gate && gate.status !== 'approved') {
        throw new Error(`Invoice approval gate #${inv.approval_id} must be approved before verifying received payment.`);
      }
      db.prepare("UPDATE commerce_invoices SET status = 'PAID' WHERE id = ?").run(params.invoiceId);
    }
  }

  const id = `fin_${crypto.randomUUID().slice(0, 10)}`;
  db.prepare(
    `INSERT INTO commerce_financial_ledger
     (id, entry_type, category, amount_eur, currency, proposal_id, invoice_id, verified_payment, notes, recorded_by, created_at)
     VALUES (?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.entryType,
    params.category.trim(),
    Number(params.amountEur.toFixed(2)),
    params.proposalId || null,
    params.invoiceId || null,
    verified ? 1 : 0,
    params.notes?.trim() || null,
    params.recordedBy || 'operator',
    nowIso()
  );

  recordAuditEvent(params.recordedBy || 'operator', 'FINANCE', `LEDGER_${params.entryType}`, {
    id,
    amountEur: params.amountEur,
    verifiedPayment: verified,
  });
  return db.prepare('SELECT * FROM commerce_financial_ledger WHERE id = ?').get(id);
}

function toEurCents(value: number | string | null | undefined): number {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

function fromEurCents(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

export function getCommerceTruthMetrics() {
  const db = getDb();
  const opportunitiesDiscovered = Number(
    (db.prepare('SELECT COUNT(*) as c FROM commerce_opportunities').get() as { c: number }).c
  );
  const auditsCompletedLive = Number(
    (db.prepare("SELECT COUNT(*) as c FROM commerce_presence_audits WHERE source_mode = 'VERIFIED_LIVE_HTTP'").get() as { c: number }).c
  );
  const totalLeads = Number((db.prepare('SELECT COUNT(*) as c FROM commerce_customers').get() as { c: number }).c);
  const qualifiedLeads = Number(
    (
      db
        .prepare("SELECT COUNT(*) as c FROM commerce_customers WHERE stage IN ('QUALIFIED','CONTACTED','RESPONDED','NEGOTIATION','PROPOSAL_SENT','ACCEPTED','CUSTOMER_WON')")
        .get() as { c: number }
    ).c
  );
  const customersAcquired = Number(
    (db.prepare("SELECT COUNT(*) as c FROM commerce_customers WHERE stage = 'CUSTOMER_WON'").get() as { c: number }).c
  );
  const proposalsPrepared = Number((db.prepare('SELECT COUNT(*) as c FROM commerce_proposals').get() as { c: number }).c);
  const proposalsApprovedOrSent = Number(
    (db.prepare("SELECT COUNT(*) as c FROM commerce_proposals WHERE status IN ('APPROVED','SENT','WON')").get() as { c: number }).c
  );
  const websitesGenerated = Number((db.prepare('SELECT COUNT(*) as c FROM commerce_sites').get() as { c: number }).c);

  const revenueRow = db
    .prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(amount_eur), 0) as total FROM commerce_financial_ledger WHERE entry_type = 'REVENUE' AND verified_payment = 1")
    .get() as { cnt: number; total: number };
  const costRow = db
    .prepare("SELECT COALESCE(SUM(amount_eur), 0) as total FROM commerce_financial_ledger WHERE entry_type = 'OPERATING_COST'")
    .get() as { total: number };
  const aiCostRow = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM model_calls').get() as { total: number };

  const activeProposalRows = db
    .prepare(
      `SELECT p.status, p.setup_price_eur, p.estimated_delivery_cost_eur, p.proposal_note, c.stage AS customer_stage
       FROM commerce_proposals p
       LEFT JOIN commerce_customers c ON c.id = p.customer_id
       WHERE p.status != 'ARCHIVED'
         AND (p.proposal_note IS NULL OR (p.proposal_note NOT LIKE '%DO NOT SEND%' AND p.proposal_note NOT LIKE '%HISTORICAL_DRAFT%'))`
    )
    .all() as Array<{
      status: string;
      setup_price_eur: number;
      estimated_delivery_cost_eur: number;
      proposal_note: string | null;
      customer_stage: string | null;
    }>;

  let estimatedExpensesCents = 0;
  let pipelineProposalValueCents = 0;
  let acceptedContractValueCents = 0;

  for (const row of activeProposalRows) {
    estimatedExpensesCents += toEurCents(row.estimated_delivery_cost_eur);
    const setupCents = toEurCents(row.setup_price_eur);
    if (row.status === 'DRAFT' || row.status === 'APPROVED' || row.status === 'SENT') {
      pipelineProposalValueCents += setupCents;
    }
    if (row.status === 'WON' || row.customer_stage === 'ACCEPTED' || row.customer_stage === 'CUSTOMER_WON') {
      acceptedContractValueCents += setupCents;
    }
  }

  const draftInvRow = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM commerce_invoices WHERE status = 'DRAFT'")
    .get() as { total: number };
  const issuedInvRow = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM commerce_invoices WHERE status IN ('APPROVED', 'PAID')")
    .get() as { total: number };

  const verifiedRevenueCents = toEurCents(revenueRow.total);
  const actualCostsCents = toEurCents(costRow.total) + toEurCents(aiCostRow.total);
  const netProfitCents = verifiedRevenueCents - actualCostsCents;
  const draftInvoicesCents = toEurCents(draftInvRow.total);
  const issuedInvoicesCents = toEurCents(issuedInvRow.total);
  const contractedOrIssuedCents = Math.max(acceptedContractValueCents, issuedInvoicesCents);
  const outstandingBalanceCents = Math.max(0, contractedOrIssuedCents - verifiedRevenueCents);

  const realizedRevenueEur = fromEurCents(verifiedRevenueCents);
  const actualOperatingCostsEur = fromEurCents(actualCostsCents);
  const netProfitEur = fromEurCents(netProfitCents);

  return {
    opportunitiesDiscovered,
    auditsCompletedLive,
    totalLeads,
    qualifiedLeads,
    proposalsPrepared,
    proposalsApprovedOrSent,
    websitesGenerated,
    customersAcquired,
    verifiedPaymentsCount: Number(revenueRow.cnt || 0),
    realizedRevenueEur,
    verifiedPaymentsTotalEur: realizedRevenueEur,
    actualOperatingCostsEur,
    estimatedExpensesEur: fromEurCents(estimatedExpensesCents),
    pipelineProposalValueEur: fromEurCents(pipelineProposalValueCents),
    acceptedContractValueEur: fromEurCents(acceptedContractValueCents),
    draftInvoicesTotalEur: fromEurCents(draftInvoicesCents),
    issuedInvoicesTotalEur: fromEurCents(issuedInvoicesCents),
    outstandingBalanceEur: fromEurCents(outstandingBalanceCents),
    netProfitEur,
  };
}

export function createDraftInvoice(params: {
  customerId?: string | null;
  title: string;
  currency?: string;
  amount: number;
}) {
  if (params.amount <= 0) throw new Error('Invoice amount must be positive.');
  const id = `inv_${crypto.randomUUID().slice(0, 10)}`;
  const approvalId = requestApproval({
    category: 'commerce_invoice',
    action: `ISSUE_DRAFT_INVOICE_${id}`,
    payload: { invoiceId: id, title: params.title, amount: params.amount, currency: params.currency || 'EUR' },
  });

  getDb()
    .prepare(
      `INSERT INTO commerce_invoices
       (id, customer_id, title, currency, amount, status, fiscal_disclaimer, approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', 'DRAFT — NOT A FISCAL INVOICE', ?, ?)`
    )
    .run(id, params.customerId || null, params.title.trim(), params.currency || 'EUR', params.amount, approvalId, nowIso());

  recordAuditEvent('operator', 'COMMERCE', 'DRAFT_INVOICE_CREATED', { id, approvalId, amount: params.amount });
  return getDb().prepare('SELECT * FROM commerce_invoices WHERE id = ?').get(id);
}

export function buildFisioterapiaAtlanteClinicalDemoHtml(siteId: string): string {
  return `<!doctype html>
<html lang="it" dir="ltr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="robots" content="noindex,nofollow" />
  <meta name="description" content="Anteprima dimostrativa non ufficiale per Studio Fisioterapia e Osteopatia Atlante — Viale Caterina da Forlì 3, Milano." />
  <title>Anteprima Dimostrativa · Studio Fisioterapia Atlante — Milano</title>
  <style>
    :root {
      --bg:#F7F8F6;
      --surface:#FFFFFF;
      --surface-soft:#EEF3F2;
      --border:#D6E0DF;
      --fg:#132028;
      --muted:#475863;
      --accent:#0F6B6E;
      --accent-dark:#0A4F52;
      --accent-ink:#FFFFFF;
      --warn-bg:#FEF9E7;
      --warn-border:#E6D28B;
      --warn-fg:#5C4813;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    html { scroll-behavior:smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      padding-bottom: 92px;
      -webkit-font-smoothing: antialiased;
    }
    .demo-banner {
      background: var(--warn-bg);
      border-bottom: 1px solid var(--warn-border);
      color: var(--warn-fg);
      font-size: 12px;
      text-align: center;
      padding: 8px 16px;
      font-weight: 500;
    }
    .demo-banner a { color: var(--accent-dark); font-weight: 600; }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 20px 18px 48px; }
    header {
      display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px;
      border-bottom:1px solid var(--border); padding-bottom:16px;
    }
    .brand-title { font-size:1.15rem; font-weight:700; letter-spacing:-0.01em; color:var(--fg); }
    .brand-sub { font-size:12px; color:var(--muted); display:block; font-weight:500; }
    .nav-actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
    .tel-pill {
      display:inline-flex; align-items:center; gap:6px; min-height:42px; padding:8px 14px;
      border:1px solid var(--border); background:var(--surface); color:var(--fg);
      border-radius:8px; text-decoration:none; font-weight:600; font-size:13px;
    }
    .btn {
      display:inline-flex; align-items:center; justify-content:center; min-height:46px;
      background:var(--accent); color:var(--accent-ink); font-weight:600; font-size:15px;
      padding:12px 22px; text-decoration:none; border-radius:8px; border:none; cursor:pointer;
      transition: background 0.15s ease;
    }
    .btn:hover { background:var(--accent-dark); }
    .btn-outline {
      display:inline-flex; align-items:center; justify-content:center; min-height:46px;
      background:var(--surface); color:var(--accent-dark); font-weight:600; font-size:14px;
      padding:12px 20px; text-decoration:none; border-radius:8px; border:1px solid var(--accent);
    }
    .hero { padding:34px 0 28px; display:grid; grid-template-columns:1fr; gap:24px; }
    @media (min-width: 820px) { .hero { grid-template-columns: 1.25fr 0.75fr; align-items:start; padding:42px 0 34px; } }
    .eyebrow {
      display:inline-block; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;
      color:var(--accent-dark); background:var(--surface-soft); border:1px solid var(--border);
      padding:4px 10px; border-radius:4px; margin-bottom:12px;
    }
    h1 { font-size:clamp(1.75rem,4vw,2.65rem); line-height:1.18; letter-spacing:-0.02em; margin-bottom:14px; color:var(--fg); }
    p.lead { color:var(--muted); max-width:58ch; margin-bottom:20px; font-size:1.02rem; }
    .meta-grid {
      display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px;
      margin-bottom:22px; font-size:13px; color:var(--fg);
    }
    .meta-item {
      background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:10px 12px;
    }
    .meta-item strong { display:block; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--accent-dark); margin-bottom:2px; }
    .cta-row { display:flex; flex-wrap:wrap; gap:10px; }
    .hero-card {
      background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:22px;
      display:grid; gap:14px;
    }
    .hero-card h2 { font-size:1rem; color:var(--fg); border-bottom:1px solid var(--border); padding-bottom:8px; }
    .qual-item { border-left:3px solid var(--accent); padding-left:12px; }
    .qual-item h4 { font-size:13px; color:var(--fg); margin-bottom:2px; }
    .qual-item p { font-size:12.5px; color:var(--muted); }
    .section-head { margin:28px 0 14px; }
    .section-title { font-size:1.3rem; font-weight:700; color:var(--fg); margin-bottom:4px; }
    .section-sub { font-size:14px; color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; }
    .card {
      background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:18px;
      display:flex; flex-direction:column; justify-content:space-between; gap:10px;
    }
    .card h3 { font-size:15.5px; color:var(--fg); margin-bottom:6px; }
    .card p { font-size:13.5px; color:var(--muted); }
    .tariff {
      font-size:12.5px; font-weight:600; color:var(--accent-dark); background:var(--surface-soft);
      padding:7px 10px; border-radius:6px; border:1px solid var(--border);
    }
    .two-col { display:grid; grid-template-columns:1fr; gap:18px; margin-top:28px; }
    @media (min-width: 820px) { .two-col { grid-template-columns: 1.15fr 0.85fr; align-items:start; } }
    .panel {
      background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:22px;
    }
    .panel label { display:block; font-size:12.5px; font-weight:600; color:var(--fg); margin-top:12px; margin-bottom:4px; }
    .panel input, .panel select, .panel textarea {
      width:100%; min-height:44px; padding:10px 12px; background:#FAFBFA;
      border:1px solid var(--border); color:var(--fg); border-radius:8px; font-size:15px; font-family:inherit;
    }
    .panel textarea { min-height:84px; resize:vertical; }
    .panel .btn { width:100%; margin-top:16px; }
    .info-list { list-style:none; display:grid; gap:12px; font-size:13.5px; color:var(--muted); }
    .info-list li strong { color:var(--fg); display:block; margin-bottom:2px; }
    .disclaimer-box {
      margin-top:14px; padding:12px; border-radius:8px; background:var(--surface-soft);
      border:1px solid var(--border); font-size:12px; color:var(--muted);
    }
    footer {
      margin-top:36px; font-size:12px; color:var(--muted);
      border-top:1px solid var(--border); padding-top:18px; display:flex; flex-wrap:wrap; justify-content:space-between; gap:10px;
    }
    .mobile-sticky {
      position:fixed; left:0; right:0; bottom:0; padding:10px 14px calc(10px + env(safe-area-inset-bottom));
      background:rgba(255,255,255,0.97); backdrop-filter:blur(8px); border-top:1px solid var(--border);
      display:grid; grid-template-columns:1fr 1.25fr; gap:10px; z-index:40;
    }
    .mobile-sticky a { min-height:44px; font-size:13.5px; }
    @media (min-width: 768px) { .mobile-sticky { display:none; } body { padding-bottom:24px; } }
  </style>
</head>
<body>
  <div class="demo-banner">
    Anteprima Dimostrativa Riservata per Studio Fisioterapia Atlante · Confronto mobile-first rispetto al sito ufficiale attuale (<a href="https://www.fisioterapiaatlante.it/" target="_blank" rel="noreferrer">fisioterapiaatlante.it</a>)
  </div>
  <div class="wrap">
    <header>
      <div>
        <div class="brand-title">Studio Fisioterapia Atlante</div>
        <span class="brand-sub">Fisioterapia e Osteopatia · Milano (Gambara / Bande Nere)</span>
      </div>
      <div class="nav-actions">
        <a class="tel-pill" href="tel:+390247712410">&#9742; 02 4771 2410</a>
        <a class="btn" href="#prenota">Richiedi Appuntamento</a>
      </div>
    </header>

    <section class="hero">
      <div>
        <span class="eyebrow">Titolare D.ssa Valentina Moriglia · Regime Privatistico e Convenzioni</span>
        <h1>Fisioterapia e Osteopatia personalizzata a Milano</h1>
        <p class="lead">
          Studio professionale in zona Gambara / Bande Nere con fisioterapisti laureati e medici specialisti.
          Valutazione individuale e percorsi riabilitativi chiari, ora consultabili e prenotabili facilmente anche da smartphone.
        </p>
        <div class="meta-grid">
          <div class="meta-item">
            <strong>Sede Studio</strong>
            Viale Caterina da Forlì, 3 — 20146 Milano
          </div>
          <div class="meta-item">
            <strong>Orario Continuato</strong>
            Lunedì – Venerdì · 09:00 – 19:00
          </div>
          <div class="meta-item">
            <strong>Contatti Diretti</strong>
            Tel/Fax 02 4771 2410 · info@fisioterapiaatlante.it
          </div>
        </div>
        <div class="cta-row">
          <a class="btn" href="#prenota">Richiedi Prima Visita o Contatto</a>
          <a class="btn-outline" href="#trattamenti">Trattamenti &amp; Tariffe Indicative</a>
        </div>
      </div>

      <aside class="hero-card">
        <h2>Profilo Professionale Verificato</h2>
        <div class="qual-item">
          <h4>D.ssa Valentina Moriglia — Titolare</h4>
          <p>Laureata in Fisioterapia (art. 1 D.M. 741/1994 Ministero della Sanità) e Diplomata in Osteopatia presso l'Istituto Superiore di Osteopatia (ISO) di Milano.</p>
        </div>
        <div class="qual-item">
          <h4>Formazione Internazionale</h4>
          <p>Bachelor of Science in Osteopatia conseguito presso la University of Wales nel 2010.</p>
        </div>
        <div class="qual-item">
          <h4>Approccio in Equipe</h4>
          <p>Collaborazione con fisioterapisti laureati e medici specialisti in regime privatistico e convenzionato con enti dedicati.</p>
        </div>
      </aside>
    </section>

    <div id="trattamenti" class="section-head">
      <h2 class="section-title">Trattamenti, Patologie Trattate &amp; Tariffe Indicative</h2>
      <p class="section-sub">Servizi e importi indicativi verificati dal listino pubblico dello studio. La conferma clinica avviene sempre in sede di valutazione.</p>
    </div>

    <section class="grid">
      <article class="card">
        <div>
          <h3>Osteopatia &amp; Gravidanza</h3>
          <p>Valutazione e trattamento osteopatico per disturbi muscolo-scheletrici, posturali e assistenza osteopatica dedicata in gravidanza.</p>
        </div>
        <div class="tariff">Prima visita €80 (60 min) · Successive €70 (60 min)</div>
      </article>
      <article class="card">
        <div>
          <h3>Fisiochinesiterapia &amp; Riabilitazione</h3>
          <p>Percorsi individuali per cervicalgie, dorsalgie, lombalgie, artrosi e riabilitazione post-traumatica, post-chirurgica o neurologica.</p>
        </div>
        <div class="tariff">Seduta individuale €48 (~30 min)</div>
      </article>
      <article class="card">
        <div>
          <h3>Riabilitazione del Pavimento Pelvico</h3>
          <p>Valutazione e rieducazione funzionale individuale, inclusa elettrostimolazione e biofeedback quando indicato dal piano terapeutico.</p>
        </div>
        <div class="tariff">Seduta €48 (~30 min) · Biofeedback / EMS €70 (~30–45 min)</div>
      </article>
      <article class="card">
        <div>
          <h3>Massoterapia &amp; Linfodrenaggio Manuale</h3>
          <p>Massochinesiterapia terapeutica decontratturante e sedute di linfodrenaggio manuale mirato.</p>
        </div>
        <div class="tariff">Massochinesiterapia €48 (~30 min) · Linfodrenaggio €70 (~45 min)</div>
      </article>
      <article class="card">
        <div>
          <h3>LIMFA© Therapy &amp; Tecar Terapia</h3>
          <p>Terapie strumentali di supporto al recupero tissutale e al controllo del dolore, integrate nel percorso riabilitativo.</p>
        </div>
        <div class="tariff">LIMFA© Therapy €50 (~60 min) · Tecar terapia su indicazione</div>
      </article>
    </section>

    <section class="two-col">
      <div id="prenota" class="panel">
        <h2 style="font-size:1.25rem;margin-bottom:4px;">Richiedi Appuntamento o Ricontatto</h2>
        <p style="font-size:13.5px;color:var(--muted);">Modulo mobile diretto (novità dimostrativa rispetto al sito attuale): la segreteria riceve subito trattamento desiderato e fascia oraria.</p>
        <form id="nexa-lead-form">
          <label for="f-name">Nome e Cognome *</label>
          <input id="f-name" name="name" required placeholder="Es. Marco Bianchi" />

          <label for="f-email">Indirizzo Email *</label>
          <input id="f-email" name="email" type="email" required placeholder="nome@esempio.it" />

          <label for="f-phone">Telefono per conferma rapida</label>
          <input id="f-phone" name="phone" type="tel" placeholder="+39 3..." />

          <label for="f-service">Ambito / Trattamento di interesse</label>
          <select id="f-service" name="service">
            <option value="Osteopatia - Prima Visita">Osteopatia — Prima Visita (€80 · 60 min)</option>
            <option value="Fisiochinesiterapia / Riabilitazione">Fisiochinesiterapia / Riabilitazione (€48 · 30 min)</option>
            <option value="Riabilitazione Pavimento Pelvico">Riabilitazione Pavimento Pelvico (€48 / €70)</option>
            <option value="Massoterapia / Linfodrenaggio">Massochinesiterapia / Linfodrenaggio (€48 / €70)</option>
            <option value="LIMFA Therapy / Tecar">LIMFA© Therapy / Tecar Terapia (€50)</option>
            <option value="Assistenza Osteopatica Gravidanza">Assistenza Osteopatica in Gravidanza</option>
            <option value="Informazioni Generali / Convenzioni">Informazioni Generali / Convenzioni</option>
          </select>

          <label for="f-notes">Fascia oraria preferita (Lun–Ven 09:00–19:00) o note</label>
          <textarea id="f-notes" name="notes" placeholder="Es. Martedì o Giovedì dopo le 17:00"></textarea>

          <div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;" aria-hidden="true">
            <label for="f-hp-web">Lascia vuoto questo campo</label>
            <input id="f-hp-web" name="honeypot" type="text" tabindex="-1" autocomplete="off" />
          </div>

          <label style="display:flex;align-items:flex-start;gap:8px;margin-top:14px;font-weight:500;font-size:12.5px;color:var(--muted);cursor:pointer;">
            <input id="f-consent" name="consent" type="checkbox" required style="width:18px;height:18px;min-height:18px;margin-top:2px;accent-color:var(--accent);" />
            <span>Acconsento al trattamento dei dati inseriti esclusivamente per gestire la richiesta di ricontatto o appuntamento (finalità precontrattuale/informativa, nessun invio promozionale a terzi).</span>
          </label>

          <button class="btn" type="submit">Invia Richiesta di Appuntamento</button>
          <p id="lead-msg" role="status" aria-live="polite" style="margin-top:12px;font-size:13.5px;font-weight:600;color:var(--accent-dark);"></p>
        </form>
      </div>

      <aside class="panel">
        <h2 style="font-size:1.15rem;margin-bottom:12px;">Come Raggiungere lo Studio</h2>
        <ul class="info-list">
          <li>
            <strong>Indirizzo</strong>
            Viale Caterina da Forlì, 3 — 20146 Milano (Zone Gambara, Bande Nere, De Angeli, Primaticcio)
          </li>
          <li>
            <strong>Metropolitana M1</strong>
            Fermate <strong>Bande Nere</strong> o <strong>Gambara</strong> a meno di 10 minuti a piedi.
          </li>
          <li>
            <strong>Mezzi di Superficie &amp; Parcheggio</strong>
            Linee autobus/filobus 56, 67, 95, 90 e 91. Parcheggio pubblico a circa 600 m in direzione Bande Nere.
          </li>
          <li>
            <strong>Recapiti Ufficiali</strong>
            Tel / Fax: <a href="tel:+390247712410" style="color:var(--accent-dark);font-weight:600;">+39 02 4771 2410</a> (h 09:00–19:00)<br />
            Email: <a href="mailto:info@fisioterapiaatlante.it" style="color:var(--accent-dark);font-weight:600;">info@fisioterapiaatlante.it</a>
          </li>
        </ul>
        <div class="disclaimer-box">
          <strong>Nota di Trasparenza Dimostrativa:</strong> Questa pagina è un’anteprima privata non indicizzata, distinta dal sito ufficiale <a href="https://www.fisioterapiaatlante.it/" target="_blank" rel="noreferrer" style="color:var(--accent-dark);font-weight:600;">fisioterapiaatlante.it</a>. Contiene esclusivamente informazioni pubbliche dello studio, senza recensioni fittizie, qualifiche inventate o tracciamenti pubblicitari.
        </div>
      </aside>
    </section>

    <footer>
      <span>Anteprima Dimostrativa Non Ufficiale · Studio Fisioterapia Atlante · Viale Caterina da Forlì 3, Milano</span>
      <span>Fonti pubbliche verificate: fisioterapiaatlante.it · Sito ufficiale attuale invariato</span>
    </footer>
  </div>

  <div class="mobile-sticky">
    <a class="btn-outline" href="tel:+390247712410">Chiama Studio</a>
    <a class="btn" href="#prenota">Prenota Visita</a>
  </div>

  <script>
    document.getElementById('nexa-lead-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var msg = document.getElementById('lead-msg');
      var consentEl = document.getElementById('f-consent');
      if (consentEl && !consentEl.checked) {
        msg.style.color = '#9F1239';
        msg.textContent = "Confermare il consenso privacy prima di inviare la richiesta.";
        return;
      }
      msg.style.color = 'var(--accent-dark)';
      msg.textContent = "Invio richiesta in corso...";
      var service = fd.get('service') || '';
      var notes = fd.get('notes') || '';
      var phone = fd.get('phone') || '';
      var combinedNotes = ['Trattamento: ' + service, notes ? ('Note: ' + notes) : ''].filter(Boolean).join(' | ');
      try {
        var r = await fetch('/preview/inquiry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name'),
            email: fd.get('email'),
            phone: phone || undefined,
            company: service,
            notes: combinedNotes,
            honeypot: fd.get('honeypot') || '',
            consent: Boolean(consentEl && consentEl.checked),
            siteId: '${siteId}'
          })
        });
        var data = await r.json();
        if (!r.ok) msg.style.color = '#9F1239';
        msg.textContent = r.ok ? data.message : (data.error || 'Invio non riuscito.');
        if (r.ok) e.target.reset();
      } catch (err) {
        msg.style.color = '#9F1239';
        msg.textContent = 'Errore di rete durante l\\'invio della richiesta.';
      }
    });
  </script>
</body>
</html>`;
}

export function generateDigitalProductSite(params: {
  brandName: string;
  tagline: string;
  language: 'en' | 'it' | 'ar' | 'fr';
  template?: 'IMCASO_V4' | 'OMEGA_V5';
  services?: string[];
  address?: string | null;
  city?: string | null;
  phone?: string | null;
}) {
  const brand = params.brandName.trim();
  if (brand.length < 2) throw new Error('Brand name is required.');
  const id = `site_${crypto.randomUUID().slice(0, 10)}`;
  const template = params.template || 'OMEGA_V5';
  const dir = params.language === 'ar' ? 'rtl' : 'ltr';
  const services =
    params.services && params.services.length > 0
      ? params.services
      : ['Digital Presence & Speed Upgrade', 'Automated Lead Capture & CRM', 'Monthly Security & Uptime SLA'];

  const copy = {
    en: {
      badge: 'Verified Local Digital Showcase',
      cta: 'Book Free Consultation',
      servicesTitle: 'Core Services & Patient/Client Experience',
      serviceSub: 'Designed for instant mobile access, fast loading, and clear appointment booking.',
      trust1Title: 'Mobile-First Booking',
      trust1Body: 'Streamlined 30-second inquiry flow optimized for smartphone visitors.',
      trust2Title: 'Verified Local Presence',
      trust2Body: params.address ? `Serving clients at ${params.address}.` : 'Structured local SEO & map visibility.',
      trust3Title: 'Direct Response Guarantee',
      trust3Body: 'Every inquiry is logged immediately for fast callback confirmation.',
      formTitle: 'Request an Appointment or Callback',
      namePh: 'Your Full Name',
      emailPh: 'Email Address',
      companyPh: 'Preferred Day / Notes (Optional)',
      sending: 'Sending request...',
      footer: `${brand}${params.city ? ` · ${params.city}` : ''} · Interactive Demo Preview (Awaiting Client Approval)`,
    },
    it: {
      badge: 'Anteprima Digitale Dedicata',
      cta: 'Prenota Prima Visita / Contatto',
      servicesTitle: 'Servizi Principali & Accoglienza Pazienti',
      serviceSub: 'Esperienza chiara da smartphone, tempi di caricamento rapidi e richiesta appuntamento immediata.',
      trust1Title: 'Prenotazione Rapida Mobile',
      trust1Body: 'Modulo intuitivo in 30 secondi pensato per chi visita lo studio da smartphone.',
      trust2Title: 'Sede Locale Verificata',
      trust2Body: params.address ? `Studio situato in ${params.address}.` : 'Visibilità locale SEO e mappe ottimizzata.',
      trust3Title: 'Risposta Diretta Garantita',
      trust3Body: 'Ogni richiesta viene registrata subito per confermare giorno e orario.',
      formTitle: 'Richiedi Informazioni o Appuntamento',
      namePh: 'Nome e Cognome',
      emailPh: 'Indirizzo Email',
      companyPh: 'Giorno preferito o nota (opzionale)',
      sending: 'Invio richiesta in corso...',
      footer: `${brand}${params.city ? ` · ${params.city}` : ''} · Anteprima Dimostrativa Riservata`,
    },
    ar: {
      badge: 'معاينة رقمية مخصصة',
      cta: 'احجز استشارة مجانية',
      servicesTitle: 'الخدمات الأساسية وتجربة العملاء',
      serviceSub: 'تجربة سريعة ومتجاوبة للهاتف مع حجز مباشر.',
      trust1Title: 'حجز سريع عبر الهاتف',
      trust1Body: 'نموذج تواصل مباشر في 30 ثانية.',
      trust2Title: 'موقع محلي موثق',
      trust2Body: params.address ? `العنوان: ${params.address}` : 'تهيئة محركات البحث المحلية.',
      trust3Title: 'استجابة سريعة',
      trust3Body: 'تسجيل فوري للطلبات والمتابعة.',
      formTitle: 'اطلب موعدًا أو تواصلًا مباشرًا',
      namePh: 'الاسم الكامل',
      emailPh: 'البريد الإلكتروني',
      companyPh: 'ملاحظات أو موعد مفضل',
      sending: 'جاري الإرسال...',
      footer: `${brand} · معاينة تجريبية بانتظار الموافقة`,
    },
    fr: {
      badge: 'Aperçu Digital Dédié',
      cta: 'Prendre Rendez-vous',
      servicesTitle: 'Services Clés & Expérience Client',
      serviceSub: 'Conçu pour mobile, chargement rapide et prise de contact immédiate.',
      trust1Title: 'Réservation Mobile Rapide',
      trust1Body: 'Formulaire clair en 30 secondes sur smartphone.',
      trust2Title: 'Présence Locale Vérifiée',
      trust2Body: params.address ? `Adresse : ${params.address}` : 'Référencement local optimisé.',
      trust3Title: 'Suivi Réactif',
      trust3Body: 'Chaque demande est enregistrée immédiatement.',
      formTitle: 'Demander un Rendez-vous',
      namePh: 'Nom complet',
      emailPh: 'Adresse e-mail',
      companyPh: 'Créneau souhaité (optionnel)',
      sending: 'Envoi en cours...',
      footer: `${brand} · Aperçu de démonstration en attente de validation`,
    },
  }[params.language];

  const html = `<!doctype html>
<html lang="${params.language}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="robots" content="noindex,nofollow" />
  <meta name="description" content="${escapeHtml(brand)} — ${escapeHtml(params.tagline)}" />
  <title>${escapeHtml(brand)} — ${escapeHtml(params.tagline)}</title>
  <style>
    :root {
      --bg:#070B12; --surface:#0E1523; --surface-2:#131C2E; --border:#1E2A42;
      --fg:#F8FAFC; --muted:#94A3B8; --accent:#2DD4BF; --accent-ink:#042F2E;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    html { scroll-behavior:smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
      background: radial-gradient(circle at top right, rgba(45,212,191,0.12), transparent 42%), var(--bg);
      color:var(--fg); line-height:1.6; padding-bottom:84px;
    }
    .wrap { max-width:1040px; margin:0 auto; padding:24px 18px 48px; }
    header {
      display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px;
      border-bottom:1px solid var(--border); padding-bottom:18px;
    }
    .brand { font-size:1.05rem; font-weight:700; letter-spacing:0.03em; color:var(--fg); }
    .badge {
      font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--accent);
      border:1px solid rgba(45,212,191,0.35); padding:5px 10px; border-radius:999px; background:rgba(45,212,191,0.08);
    }
    .hero { padding:44px 0 32px; display:grid; grid-template-columns:1fr; gap:24px; }
    @media (min-width: 768px) { .hero { grid-template-columns: 1.3fr 0.7fr; align-items:center; padding:56px 0 40px; } }
    h1 { font-size:clamp(1.85rem,4.4vw,3rem); line-height:1.14; letter-spacing:-0.02em; margin-bottom:14px; }
    p.lead { color:var(--muted); max-width:58ch; margin-bottom:24px; font-size:1.02rem; }
    .meta-line { font-size:13px; color:#CBD5E1; margin-bottom:22px; display:flex; flex-wrap:wrap; gap:12px; }
    .btn {
      display:inline-flex; align-items:center; justify-content:center; min-height:48px;
      background:var(--accent); color:var(--accent-ink); font-weight:700; font-size:15px;
      padding:12px 24px; text-decoration:none; border-radius:10px; border:none; cursor:pointer;
    }
    .hero-card {
      background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:20px;
      display:grid; gap:14px;
    }
    .hero-stat { border-left:2px solid var(--accent); padding-left:12px; }
    .hero-stat h4 { font-size:13px; color:var(--fg); margin-bottom:2px; }
    .hero-stat p { font-size:12px; color:var(--muted); }
    .section-title { font-size:1.1rem; font-weight:600; margin:16px 0 6px; }
    .section-sub { font-size:14px; color:var(--muted); margin-bottom:18px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; }
    .card {
      background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:20px;
    }
    .card h3 { font-size:15px; color:var(--fg); margin-bottom:8px; }
    .card p { font-size:13px; color:var(--muted); }
    .inquiry {
      margin-top:34px; background:var(--surface-2); border:1px solid var(--border);
      border-radius:14px; padding:24px;
    }
    .inquiry label { display:block; font-size:12px; color:#CBD5E1; margin-top:10px; margin-bottom:4px; }
    .inquiry input {
      width:100%; min-height:46px; padding:10px 14px; background:#060911;
      border:1px solid var(--border); color:var(--fg); border-radius:8px; font-size:15px;
    }
    .inquiry .btn { width:100%; margin-top:16px; }
    @media (min-width: 640px) { .inquiry .btn { width:auto; } }
    footer {
      margin-top:42px; font-size:12px; color:var(--muted);
      border-top:1px solid var(--border); padding-top:18px;
    }
    .mobile-sticky {
      position:fixed; left:0; right:0; bottom:0; padding:10px 16px calc(10px + env(safe-area-inset-bottom));
      background:rgba(7,11,18,0.95); backdrop-filter:blur(10px); border-top:1px solid var(--border);
      display:flex; justify-content:space-between; align-items:center; gap:12px; z-index:40;
    }
    .mobile-sticky .btn { width:100%; min-height:44px; font-size:14px; }
    @media (min-width: 768px) { .mobile-sticky { display:none; } body { padding-bottom:24px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">${escapeHtml(brand)}</div>
      <div class="badge">${escapeHtml(copy.badge)}</div>
    </header>
    <section class="hero">
      <div>
        <h1>${escapeHtml(params.tagline)}</h1>
        <p class="lead">${escapeHtml(copy.serviceSub)}</p>
        ${params.address || params.phone ? `<div class="meta-line">${params.address ? `<span>&#128205; ${escapeHtml(params.address)}</span>` : ''}${params.phone ? `<span>&#9742; ${escapeHtml(params.phone)}</span>` : ''}</div>` : ''}
        <a class="btn" href="#contact">${escapeHtml(copy.cta)}</a>
      </div>
      <aside class="hero-card">
        <div class="hero-stat"><h4>${escapeHtml(copy.trust1Title)}</h4><p>${escapeHtml(copy.trust1Body)}</p></div>
        <div class="hero-stat"><h4>${escapeHtml(copy.trust2Title)}</h4><p>${escapeHtml(copy.trust2Body)}</p></div>
        <div class="hero-stat"><h4>${escapeHtml(copy.trust3Title)}</h4><p>${escapeHtml(copy.trust3Body)}</p></div>
      </aside>
    </section>
    <h2 class="section-title">${escapeHtml(copy.servicesTitle)}</h2>
    <p class="section-sub">${escapeHtml(copy.serviceSub)}</p>
    <section class="grid">
      ${services.map((s) => `<article class="card"><h3>${escapeHtml(s)}</h3><p>${escapeHtml(copy.trust3Body)}</p></article>`).join('\n      ')}
    </section>
    <section id="contact" class="inquiry">
      <h2 style="font-size:1.25rem;margin-bottom:6px;">${escapeHtml(copy.formTitle)}</h2>
      <form id="nexa-lead-form">
        <label for="f-name">${escapeHtml(copy.namePh)}</label>
        <input id="f-name" name="name" required placeholder="${escapeHtml(copy.namePh)}" />
        <label for="f-email">${escapeHtml(copy.emailPh)}</label>
        <input id="f-email" name="email" type="email" required placeholder="${escapeHtml(copy.emailPh)}" />
        <label for="f-notes">${escapeHtml(copy.companyPh)}</label>
        <input id="f-notes" name="company" placeholder="${escapeHtml(copy.companyPh)}" />
        <div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;" aria-hidden="true">
          <input name="honeypot" type="text" tabindex="-1" autocomplete="off" />
        </div>
        <label style="display:flex;align-items:flex-start;gap:8px;margin-top:12px;font-size:12px;color:var(--muted);cursor:pointer;">
          <input id="f-consent" name="consent" type="checkbox" required style="width:18px;height:18px;min-height:18px;margin-top:2px;" />
          <span>${params.language === 'it' ? 'Acconsento al trattamento dei dati per gestire questa richiesta.' : params.language === 'fr' ? "J'accepte le traitement de ces informations pour répondre à ma demande." : params.language === 'ar' ? 'أوافق على معالجة بياناتي للتواصل بخصوص هذا الطلب.' : 'I consent to processing my inquiry details solely to respond to this request.'}</span>
        </label>
        <button class="btn" type="submit">${escapeHtml(copy.cta)}</button>
        <p id="lead-msg" role="status" aria-live="polite" style="margin-top:12px;font-size:13px;color:var(--accent);"></p>
      </form>
    </section>
    <footer>${escapeHtml(copy.footer)}</footer>
  </div>
  <div class="mobile-sticky">
    <a class="btn" href="#contact">${escapeHtml(copy.cta)}</a>
  </div>
  <script>
    document.getElementById('nexa-lead-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var msg = document.getElementById('lead-msg');
      var consentEl = document.getElementById('f-consent');
      msg.textContent = ${JSON.stringify(copy.sending)};
      try {
        var r = await fetch('/preview/inquiry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name'),
            email: fd.get('email'),
            company: fd.get('company'),
            honeypot: fd.get('honeypot') || '',
            consent: Boolean(consentEl && consentEl.checked),
            siteId: '${id}'
          })
        });
        var data = await r.json();
        msg.textContent = r.ok ? data.message : (data.error || 'Submission failed');
        if (r.ok) e.target.reset();
      } catch (err) {
        msg.textContent = 'Network error submitting inquiry.';
      }
    });
  </script>
</body>
</html>`;

  const artifact = saveArtifact({
    subsystem: 'autonomous_commerce',
    name: `${brand.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${id}.html`,
    mimeType: 'text/html',
    content: html,
    metadata: { template, language: params.language },
  });

  const approvalId = requestApproval({
    category: 'commerce_publish',
    action: `PUBLISH_SITE_${brand}`,
    payload: { siteId: id, artifactId: artifact.id, externalActionsEnabled: isExternalCommerceEnabled() },
  });

  getDb()
    .prepare(
      `INSERT INTO commerce_sites
       (id, brand_name, tagline, language, template, artifact_id, html_content, status, approval_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`
    )
    .run(id, brand, params.tagline.trim(), params.language, template, artifact.id, html, approvalId, nowIso());

  recordAuditEvent('operator', 'COMMERCE', 'SITE_GENERATED', { id, brand, template, artifactId: artifact.id, approvalId });
  return { id, brandName: brand, template, language: params.language, artifactId: artifact.id, approvalId, htmlContent: html, status: 'DRAFT' };
}

export type WebsitePresenceStatus =
  | 'NO_WEBSITE'
  | 'SOCIAL_ONLY'
  | 'WEAK_WEBSITE'
  | 'BROKEN_WEBSITE'
  | 'UNLISTED_SITE_CANDIDATE'
  | 'WEBSITE_UNCONFIRMED_LOW_EVIDENCE'
  | 'CORPORATE_SITE_UNAUDITED'
  | 'UNREACHABLE'
  | 'HEALTHY_WEBSITE'
  | 'UNKNOWN';

export type VerificationStatus =
  | 'VERIFIED_INDEPENDENT_SMB'
  | 'CORPORATE_CHAIN_EXCLUDED'
  | 'UNVERIFIED_INSUFFICIENT_EVIDENCE'
  | 'NEEDS_MANUAL_REVIEW'
  | 'OFFICIAL_SITE_VERIFIED_HEALTHY';

export type QualificationDecision =
  | 'QUALIFIED'
  | 'EXCLUDED_CHAIN'
  | 'UNQUALIFIED_LOW_EVIDENCE'
  | 'HEALTHY_NO_ACTION'
  | 'ARCHIVED_HISTORICAL'
  | 'REVIEW';

export type PriorityTier = 'P1_CRITICAL' | 'P2_HIGH' | 'P3_NURTURE';
export type ReplyStatus = 'NONE' | 'REPLIED_INTERESTED' | 'REPLIED_QUESTIONS' | 'DECLINED';

const KNOWN_CORPORATE_CHAINS = [
  'dentalpro', 'vitaldent', 'cova', 'marchesi', 'jean louis david', 'toni&guy',
  'aldo coppola', 'franck provost', 'l\'oreal', 'salmoiraghi', 'grandvision',
  'bludental', 'sorridi', 'centri medici santagostino', 'auxologico',
];

export function scoreBusinessOpportunity(params: {
  websiteStatus: WebsitePresenceStatus;
  digitalReadinessScore: number;
  gapsCount: number;
  hasPhone: boolean;
  hasEmail: boolean;
  hasAddress: boolean;
  isChainOrEnterprise?: boolean;
  liveAuditCompleted?: boolean;
  hasCrossCheckCorroboration?: boolean;
  httpStatus?: number | null;
}) {
  const isChain = Boolean(params.isChainOrEnterprise);
  const corroborated = params.hasCrossCheckCorroboration ?? (params.hasPhone && params.hasEmail);
  const weaknessBase =
    isChain
      ? 10
      : params.websiteStatus === 'BROKEN_WEBSITE'
        ? 64
        : params.websiteStatus === 'NO_WEBSITE'
          ? (corroborated ? 60 : 28)
          : params.websiteStatus === 'SOCIAL_ONLY'
            ? 56
            : params.websiteStatus === 'WEAK_WEBSITE'
              ? Math.max(46, Math.round(((100 - Math.min(100, Math.max(0, params.digitalReadinessScore))) / 100) * 62))
              : params.websiteStatus === 'WEBSITE_UNCONFIRMED_LOW_EVIDENCE'
                ? 22
                : params.websiteStatus === 'UNLISTED_SITE_CANDIDATE' || params.websiteStatus === 'CORPORATE_SITE_UNAUDITED'
                  ? 25
                  : params.websiteStatus === 'UNREACHABLE'
                    ? 40
                    : Math.round(((100 - Math.min(100, Math.max(0, params.digitalReadinessScore))) / 100) * 58);

  const gapBonus = Math.min(20, params.gapsCount * 4);
  const contactBonus = (params.hasPhone ? 10 : 0) + (params.hasEmail ? 12 : 0) + (params.hasAddress ? 4 : 0);
  const priorityScore = Number(Math.min(99, Math.max(10, weaknessBase + gapBonus + contactBonus)).toFixed(1));
  const priorityTier: PriorityTier =
    !isChain && priorityScore >= 75
      ? 'P1_CRITICAL'
      : !isChain && priorityScore >= 55
        ? 'P2_HIGH'
        : 'P3_NURTURE';

  // Confidence Score (0-100): measures strength of real evidence & reachability
  let confidenceScore = 0;
  if (params.hasAddress) confidenceScore += 25;
  if (params.hasPhone) confidenceScore += 25;
  if (params.hasEmail) confidenceScore += 25;
  if (params.liveAuditCompleted && params.httpStatus !== null && params.httpStatus !== undefined) confidenceScore += 25;
  else if (corroborated) confidenceScore += 15;
  if (!params.hasPhone && !params.hasEmail) confidenceScore = Math.min(confidenceScore, 30);
  if (params.websiteStatus === 'CORPORATE_SITE_UNAUDITED' || params.websiteStatus === 'UNLISTED_SITE_CANDIDATE') {
    confidenceScore = Math.min(confidenceScore, 75);
  }
  confidenceScore = Number(Math.min(100, Math.max(5, confidenceScore)).toFixed(1));

  let verificationStatus: VerificationStatus = 'UNVERIFIED_INSUFFICIENT_EVIDENCE';
  let qualificationDecision: QualificationDecision = 'UNQUALIFIED_LOW_EVIDENCE';

  if (isChain) {
    verificationStatus = 'CORPORATE_CHAIN_EXCLUDED';
    qualificationDecision = 'EXCLUDED_CHAIN';
  } else if (params.websiteStatus === 'HEALTHY_WEBSITE') {
    verificationStatus = 'OFFICIAL_SITE_VERIFIED_HEALTHY';
    qualificationDecision = 'HEALTHY_NO_ACTION';
  } else if (
    (params.hasPhone || params.hasEmail) &&
    confidenceScore >= 50 &&
    ['BROKEN_WEBSITE', 'WEAK_WEBSITE', 'SOCIAL_ONLY', 'NO_WEBSITE'].includes(params.websiteStatus) &&
    (params.websiteStatus !== 'NO_WEBSITE' || corroborated)
  ) {
    verificationStatus = 'VERIFIED_INDEPENDENT_SMB';
    qualificationDecision = priorityScore >= 55 ? 'QUALIFIED' : 'REVIEW';
  } else if (params.websiteStatus === 'UNLISTED_SITE_CANDIDATE' || params.websiteStatus === 'CORPORATE_SITE_UNAUDITED') {
    verificationStatus = 'NEEDS_MANUAL_REVIEW';
    qualificationDecision = 'REVIEW';
  }

  const recommendedEffortHours =
    params.websiteStatus === 'NO_WEBSITE' ? 18 : params.websiteStatus === 'BROKEN_WEBSITE' ? 16 : 12 + Math.min(8, params.gapsCount * 2);
  const recommendedSetupEur = priorityTier === 'P1_CRITICAL' ? 650 : priorityTier === 'P2_HIGH' ? 450 : 350;
  const recommendedMonthlyEur = priorityTier === 'P1_CRITICAL' ? 149 : 99;

  return {
    priorityScore,
    priorityTier,
    confidenceScore,
    verificationStatus,
    qualificationDecision,
    recommendedEffortHours,
    recommendedSetupEur,
    recommendedMonthlyEur,
  };
}

function classifySocialUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'instagram.com', 'www.instagram.com', 'linktr.ee'].some(
      (d) => host === d || host.endsWith('.' + d)
    );
  } catch {
    return false;
  }
}

export async function crossCheckBusinessPresence(params: {
  name: string;
  osmType?: string | null;
  osmId?: string | number | null;
  city?: string | null;
  existingTags?: Record<string, string>;
  listedWebsite?: string | null;
  listedPhone?: string | null;
  listedEmail?: string | null;
}) {
  const mergedTags: Record<string, string> = { ...(params.existingTags || {}) };
  let osmFullFetched = false;

  // 1. Fetch authoritative full OSM tags from /api/0.6/{type}/{id}.json
  if (params.osmType && params.osmId && (params.osmType === 'node' || params.osmType === 'way')) {
    try {
      const osmResp = await fetch(`https://api.openstreetmap.org/api/0.6/${params.osmType}/${params.osmId}.json`, {
        headers: { 'User-Agent': 'NEXA-COMMERCE-VERIFIER/1.0' },
        signal: AbortSignal.timeout(4500),
      });
      if (osmResp.ok) {
        const oj = (await osmResp.json()) as { elements?: Array<{ tags?: Record<string, string> }> };
        Object.assign(mergedTags, oj.elements?.[0]?.tags || {});
        osmFullFetched = true;
      }
    } catch {
      // ignore network error; preserve available tags
    }
  }

  const website = (
    params.listedWebsite ||
    mergedTags.website ||
    mergedTags['contact:website'] ||
    mergedTags.url ||
    mergedTags['contact:facebook'] ||
    mergedTags.facebook ||
    mergedTags['contact:instagram'] ||
    mergedTags.instagram ||
    ''
  ).trim() || null;
  const phone = (params.listedPhone || mergedTags.phone || mergedTags['contact:phone'] || '').trim() || null;
  const email = (params.listedEmail || mergedTags.email || mergedTags['contact:email'] || '').trim() || null;
  const brand = (mergedTags.brand || mergedTags.operator || '').trim() || null;
  const vatin = (mergedTags['ref:vatin'] || '').trim() || null;
  const streetAddr = [mergedTags['addr:street'], mergedTags['addr:housenumber'], mergedTags['addr:city']]
    .filter(Boolean)
    .join(', ');

  // 2. Chain / Corporate detection (OSM tags + domain + Wikidata check)
  const hay = `${params.name} ${brand || ''} ${website || ''} ${email || ''}`.toLowerCase();
  let isChainOrEnterprise =
    Boolean(mergedTags['brand:wikidata'] || mergedTags.network) ||
    KNOWN_CORPORATE_CHAINS.some((c) => hay.includes(c));
  let wikidataBrandNote: string | null = null;

  if (!isChainOrEnterprise && params.name.trim().length >= 3) {
    try {
      const wdUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
        params.name.trim()
      )}&language=it&format=json&limit=2`;
      const wdResp = await fetch(wdUrl, {
        headers: { 'User-Agent': 'NEXA-COMMERCE-VERIFIER/1.0' },
        signal: AbortSignal.timeout(3000),
      });
      if (wdResp.ok) {
        const wdj = (await wdResp.json()) as { search?: Array<{ label?: string; description?: string }> };
        for (const item of wdj.search || []) {
          const desc = (item.description || '').toLowerCase();
          if (
            (item.label || '').toLowerCase() === params.name.trim().toLowerCase() &&
            /(chain|company|corporation|enterprise|multinational|catena|gruppo|spa|s\.p\.a\.)/i.test(desc)
          ) {
            isChainOrEnterprise = true;
            wikidataBrandNote = `${item.label}: ${item.description}`;
            break;
          }
        }
      }
    } catch {
      // non-blocking check
    }
  }

  // 3. Domain DNS candidate cross-check when OSM omits website
  const dnsCandidatesFound: string[] = [];
  if (!website) {
    const slug = params.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
    if (slug.length >= 6 && slug.length <= 32) {
      for (const dom of [`${slug}.it`, `${slug}.com`]) {
        try {
          const addrs = await Promise.race([
            dns.promises.resolve4(dom),
            new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
          ]);
          if (addrs.length > 0) dnsCandidatesFound.push(`https://www.${dom}`);
        } catch {
          // no DNS record
        }
      }
    }
  }

  return {
    osmFullFetched,
    mergedTags,
    website,
    phone,
    email,
    brand,
    vatin,
    streetAddr,
    isChainOrEnterprise,
    wikidataBrandNote,
    dnsCandidatesFound,
  };
}

export async function discoverRealLocalBusinessesLive(params: {
  niche: string;
  cityOrMarket: string;
  limit?: number;
  auditWebsites?: boolean;
}) {
  const niche = params.niche.trim();
  const city = params.cityOrMarket.trim();
  if (niche.length < 2) throw new Error('Business niche is required.');
  if (city.length < 2) throw new Error('Target city or market is required.');
  const limit = Math.min(Math.max(params.limit ?? 6, 1), 12);
  const auditWebsites = params.auditWebsites !== false;

  let viewboxParam = '';
  let centerLat = 45.4642;
  let centerLon = 9.19;
  try {
    const geoResp = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=jsonv2&limit=1`,
      {
        headers: { 'User-Agent': 'NEXA-COMMERCE-DISCOVERY/1.0 (+public-smb-research)' },
        signal: AbortSignal.timeout(7000),
      }
    );
    if (geoResp.ok) {
      const geoData = (await geoResp.json()) as Array<{ lat?: string; lon?: string; boundingbox?: [string, string, string, string] }>;
      if (geoData[0]?.lat && geoData[0]?.lon) {
        centerLat = Number(geoData[0].lat);
        centerLon = Number(geoData[0].lon);
      }
      const bb = geoData[0]?.boundingbox;
      if (bb && bb.length === 4) {
        viewboxParam = `&bounded=1&viewbox=${encodeURIComponent(`${bb[2]},${bb[1]},${bb[3]},${bb[0]}`)}`;
      }
    }
  } catch {
    // proceed cleanly
  }

  type PoiCandidate = {
    osm_type: string;
    osm_id: number;
    name: string;
    display_name: string;
    extratags?: Record<string, string> | null;
  };
  const poisMap = new Map<string, PoiCandidate>();

  // 1. Photon Komoot OSM index (discovers real local businesses reliably)
  try {
    const phResp = await fetch(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(`${niche} ${city}`)}&limit=${limit}&lat=${centerLat}&lon=${centerLon}`,
      {
        headers: { 'User-Agent': 'NEXA-COMMERCE-DISCOVERY/1.0 (+public-smb-research)' },
        signal: AbortSignal.timeout(7000),
      }
    );
    if (phResp.ok) {
      const phJson = (await phResp.json()) as {
        features?: Array<{ properties?: { osm_type?: string; osm_id?: number; name?: string; street?: string; housenumber?: string; city?: string } }>;
      };
      for (const f of phJson.features || []) {
        const p = f.properties;
        const t = p?.osm_type === 'N' ? 'node' : p?.osm_type === 'W' ? 'way' : null;
        if (!t || !p?.osm_id || !p?.name) continue;
        const key = `${t}/${p.osm_id}`;
        const disp = [p.name, p.street && `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}`, p.city || city].filter(Boolean).join(', ');
        poisMap.set(key, { osm_type: t, osm_id: p.osm_id, name: p.name, display_name: disp, extratags: {} });
      }
    }
  } catch {
    // fallback to Nominatim below
  }

  // 2. Nominatim search (supplement & direct match)
  let networkFailed = false;
  let lastNetErr = '';
  try {
    const searchUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${niche} ${city}`)}&format=jsonv2&extratags=1&addressdetails=1&limit=${limit}${viewboxParam}`;
    const poiResp = await fetch(searchUrl, {
      headers: { 'User-Agent': 'NEXA-COMMERCE-DISCOVERY/1.0 (+public-smb-research)' },
      signal: AbortSignal.timeout(8000),
    });
    if (poiResp.ok) {
      const nomPois = (await poiResp.json()) as Array<{ osm_type: string; osm_id: number; name?: string; display_name: string; extratags?: Record<string, string> | null }>;
      for (const np of nomPois) {
        const rawName = (np.name || np.display_name.split(',')[0] || '').trim();
        if (!rawName || rawName.toLowerCase() === city.toLowerCase()) continue;
        const key = `${np.osm_type}/${np.osm_id}`;
        if (!poisMap.has(key)) {
          poisMap.set(key, { osm_type: np.osm_type, osm_id: np.osm_id, name: rawName, display_name: np.display_name, extratags: np.extratags });
        }
      }
    } else if (poisMap.size === 0) {
      networkFailed = true;
      lastNetErr = `OpenStreetMap Nominatim returned HTTP ${poiResp.status}`;
    }
  } catch (err) {
    if (poisMap.size === 0) {
      networkFailed = true;
      lastNetErr = err instanceof Error ? err.message : 'Unable to reach public business directory';
    }
  }

  if (networkFailed && poisMap.size === 0) {
    return { status: 'UNAVAILABLE_OFFLINE' as const, errorMessage: lastNetErr, discoveredCount: 0, opportunities: [] };
  }

  const db = getDb();
  const createdOrUpdated: Array<Record<string, unknown>> = [];

  for (const poi of Array.from(poisMap.values()).slice(0, limit)) {
    const rawName = poi.name.trim();
    if (!rawName || rawName.toLowerCase() === city.toLowerCase()) continue;

    const publicSourceUrl = `https://www.openstreetmap.org/${poi.osm_type}/${poi.osm_id}`;
    let existingRow = db
      .prepare('SELECT id, qualification_decision, is_chain_or_enterprise, website_url FROM commerce_opportunities WHERE public_source_url = ?')
      .get(publicSourceUrl) as { id: string; qualification_decision?: string; is_chain_or_enterprise?: number; website_url?: string | null } | undefined;

    if (!existingRow) {
      existingRow = db
        .prepare('SELECT id, qualification_decision, is_chain_or_enterprise, website_url FROM commerce_opportunities WHERE lower(trim(business_name)) = lower(trim(?)) AND lower(trim(city)) = lower(trim(?)) LIMIT 1')
        .get(rawName, city) as { id: string; qualification_decision?: string; is_chain_or_enterprise?: number; website_url?: string | null } | undefined;
    }

    const cc = await crossCheckBusinessPresence({
      name: rawName,
      osmType: poi.osm_type,
      osmId: poi.osm_id,
      city,
      existingTags: poi.extratags || {},
      listedWebsite: existingRow?.website_url || null,
    });

    if (!existingRow && cc.website) {
      try {
        const host = new URL(/^https?:\/\//i.test(cc.website) ? cc.website : `https://${cc.website}`).hostname.toLowerCase();
        existingRow = db
          .prepare('SELECT id, qualification_decision, is_chain_or_enterprise, website_url FROM commerce_opportunities WHERE lower(website_url) LIKE ? LIMIT 1')
          .get(`%${host}%`) as { id: string; qualification_decision?: string; is_chain_or_enterprise?: number; website_url?: string | null } | undefined;
      } catch {
        // ignore URL parse error during dedup probe
      }
    }

    const address = (cc.streetAddr || poi.display_name).slice(0, 220);
    let rawPhone = cc.phone;
    let rawEmail = cc.email;
    let rawWebsite = cc.website;
    if (!rawWebsite && cc.dnsCandidatesFound.length > 0) {
      rawWebsite = cc.dnsCandidatesFound[0];
    }

    let websiteStatus: WebsitePresenceStatus = 'WEBSITE_UNCONFIRMED_LOW_EVIDENCE';
    let readinessScore = 0;
    let gaps: string[] = [];
    let auditId: string | null = null;
    let httpStatus: number | null = null;
    let liveAuditCompleted = false;
    let normalizedWebsite: string | null = null;
    const isChain = cc.isChainOrEnterprise || Boolean(existingRow?.is_chain_or_enterprise);

    if (rawWebsite) {
      const candidate = /^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`;
      try {
        normalizedWebsite = validatePublicHttpUrl(candidate).toString();
        if (classifySocialUrl(normalizedWebsite)) {
          websiteStatus = 'SOCIAL_ONLY';
          readinessScore = 20;
          gaps = ['Uses only a third-party social profile instead of an owned conversion website.'];
        } else if (auditWebsites) {
          const audit = await auditBusinessWebsiteLive({ url: normalizedWebsite });
          auditId = audit.id;
          httpStatus = audit.httpStatus;
          readinessScore = audit.digitalReadinessScore;
          gaps = audit.detectedGaps;
          if (!rawEmail && audit.contactEmailsFound.length > 0) rawEmail = audit.contactEmailsFound[0];
          if (!rawPhone && audit.contactPhonesFound.length > 0) rawPhone = audit.contactPhonesFound[0];

          if (audit.sourceMode === 'OFFLINE_OR_UNREACHABLE') {
            websiteStatus = isChain ? 'CORPORATE_SITE_UNAUDITED' : cc.dnsCandidatesFound.length > 0 ? 'UNLISTED_SITE_CANDIDATE' : 'UNREACHABLE';
          } else {
            liveAuditCompleted = true;
            if ((httpStatus ?? 0) >= 400) {
              websiteStatus = 'BROKEN_WEBSITE';
            } else if (isChain) {
              websiteStatus = 'CORPORATE_SITE_UNAUDITED';
            } else if (audit.digitalReadinessScore < 85 || audit.detectedGaps.length > 0) {
              websiteStatus = 'WEAK_WEBSITE';
            } else {
              websiteStatus = 'HEALTHY_WEBSITE';
            }
          }
        } else {
          websiteStatus = cc.dnsCandidatesFound.length > 0 ? 'UNLISTED_SITE_CANDIDATE' : 'UNKNOWN';
          readinessScore = 50;
          gaps = ['Website detected; awaiting live HTTP verification.'];
        }
      } catch {
        websiteStatus = 'UNREACHABLE';
        readinessScore = 0;
        gaps = ['Listed website URL is invalid or blocked by security guard.'];
      }
    } else if (isChain) {
      websiteStatus = 'CORPORATE_SITE_UNAUDITED';
      gaps = ['Corporate chain / brand detected; OSM website tag omitted.'];
    } else if (rawPhone || rawEmail || cc.vatin) {
      // Genuine verifiable SMB with full OSM metadata + reachable contact yet no website tag or DNS match
      websiteStatus = 'NO_WEBSITE';
      gaps = ['Verified OSM record with direct contact metadata shows no website tag and no matching .it/.com domain DNS.'];
    } else {
      websiteStatus = 'WEBSITE_UNCONFIRMED_LOW_EVIDENCE';
      gaps = ['OSM entry lacks website AND lacks phone/email verification — insufficient evidence to confirm NO_WEBSITE.'];
    }

    const scoring = scoreBusinessOpportunity({
      websiteStatus,
      digitalReadinessScore: readinessScore,
      gapsCount: gaps.length,
      hasPhone: Boolean(rawPhone),
      hasEmail: Boolean(rawEmail),
      hasAddress: Boolean(address),
      isChainOrEnterprise: isChain,
      liveAuditCompleted,
      hasCrossCheckCorroboration: cc.osmFullFetched && Boolean(rawPhone || rawEmail || cc.vatin),
      httpStatus,
    });

    const verificationEvidence = {
      osmFullFetched: cc.osmFullFetched,
      brand: cc.brand,
      vatin: cc.vatin,
      wikidataBrandNote: cc.wikidataBrandNote,
      dnsCandidatesFound: cc.dnsCandidatesFound,
      verifiedPhone: rawPhone,
      verifiedEmail: rawEmail,
      verifiedWebsite: normalizedWebsite,
      httpStatus,
      liveAuditCompleted,
    };

    const existingCus = db
      .prepare('SELECT id, stage FROM commerce_customers WHERE public_source_url = ?')
      .get(publicSourceUrl) as { id: string; stage: string } | undefined;

    const customerStage: CustomerStage = scoring.qualificationDecision === 'QUALIFIED' ? 'QUALIFIED' : 'LEAD';
    let customerId = existingCus?.id;
    const ts = nowIso();

    if (!customerId) {
      customerId = `cus_${crypto.randomUUID().slice(0, 10)}`;
      db.prepare(
        `INSERT INTO commerce_customers
         (id, name, company, email, channel, stage, notes, website_url, public_source_url, phone, address, priority_score, reply_status, verification_status, confidence_score, is_chain_or_enterprise, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NONE', ?, ?, ?, ?)`
      ).run(
        customerId,
        rawName,
        rawName,
        rawEmail,
        'osm_cross_checked_live',
        customerStage,
        `Discovered (${niche} / ${city}). Website: ${websiteStatus}. Verification: ${scoring.verificationStatus} (${scoring.confidenceScore}/100).`,
        normalizedWebsite,
        publicSourceUrl,
        rawPhone,
        address,
        scoring.priorityScore,
        scoring.verificationStatus,
        scoring.confidenceScore,
        isChain ? 1 : 0,
        ts
      );
    } else {
      db.prepare(
        `UPDATE commerce_customers
         SET email = COALESCE(?, email), website_url = COALESCE(?, website_url), phone = COALESCE(?, phone),
             address = COALESCE(?, address), priority_score = ?, verification_status = ?, confidence_score = ?, is_chain_or_enterprise = ?
         WHERE id = ?`
      ).run(
        rawEmail,
        normalizedWebsite,
        rawPhone,
        address,
        scoring.priorityScore,
        scoring.verificationStatus,
        scoring.confidenceScore,
        isChain ? 1 : 0,
        customerId
      );
    }

    if (auditId) {
      db.prepare('UPDATE commerce_presence_audits SET customer_id = ? WHERE id = ?').run(customerId, auditId);
    }

    const oppId = existingRow?.id || `opp_${crypto.randomUUID().slice(0, 10)}`;
    const oppTitle = `${rawName} — ${
      isChain
        ? 'Corporate Brand (Excluded)'
        : websiteStatus === 'BROKEN_WEBSITE'
          ? `Broken Site HTTP ${httpStatus || 'Error'} Recovery`
          : websiteStatus === 'WEAK_WEBSITE'
            ? 'Mobile & Direct Booking Modernization'
            : websiteStatus === 'NO_WEBSITE'
              ? 'Verified Missing Website Launch'
              : 'Presence Cross-Check'
    } (${city})`;
    const problemStatement = gaps.join(' ');
    const revenueModel = `EUR ${scoring.recommendedSetupEur} Setup + EUR ${scoring.recommendedMonthlyEur}/mo SLA`;
    const evidenceNotes = `OSM: ${publicSourceUrl}${cc.vatin ? ` (VAT ${cc.vatin})` : ''}. ${normalizedWebsite ? `Site: ${normalizedWebsite} (HTTP ${httpStatus ?? 'N/A'}, readiness ${readinessScore}/100).` : 'No website verified.'} Phone: ${rawPhone || 'none'}. Email: ${rawEmail || 'none'}. Confidence: ${scoring.confidenceScore}/100.`;

    if (!existingRow) {
      db.prepare(
        `INSERT INTO commerce_opportunities
         (id, title, target_market, problem_statement, estimated_effort_hours, revenue_model, validation_score, status, evidence_notes, created_at,
          business_name, city, address, website_url, public_source_url, website_status, audit_id, priority_score, priority_tier, customer_id,
          confidence_score, verification_status, is_chain_or_enterprise, verification_evidence_json, qualification_decision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PRIORITIZED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        oppId,
        oppTitle,
        `${niche} (${city})`,
        problemStatement,
        scoring.recommendedEffortHours,
        revenueModel,
        scoring.priorityScore,
        evidenceNotes,
        ts,
        rawName,
        city,
        address,
        normalizedWebsite,
        publicSourceUrl,
        websiteStatus,
        auditId,
        scoring.priorityScore,
        scoring.priorityTier,
        customerId,
        scoring.confidenceScore,
        scoring.verificationStatus,
        isChain ? 1 : 0,
        JSON.stringify(verificationEvidence),
        scoring.qualificationDecision
      );
      db.prepare('UPDATE commerce_customers SET opportunity_id = ? WHERE id = ?').run(oppId, customerId);
    } else {
      const preservedDecision =
        existingRow.qualification_decision === 'ARCHIVED_HISTORICAL'
          ? 'ARCHIVED_HISTORICAL'
          : scoring.qualificationDecision;
      db.prepare(
        `UPDATE commerce_opportunities
         SET title = ?, problem_statement = ?, validation_score = ?, evidence_notes = ?, website_url = COALESCE(?, website_url),
             website_status = ?, audit_id = COALESCE(?, audit_id), priority_score = ?, priority_tier = ?, customer_id = ?,
             confidence_score = ?, verification_status = ?, is_chain_or_enterprise = ?, verification_evidence_json = ?, qualification_decision = ?
         WHERE id = ?`
      ).run(
        oppTitle,
        problemStatement,
        scoring.priorityScore,
        evidenceNotes,
        normalizedWebsite,
        websiteStatus,
        auditId,
        scoring.priorityScore,
        scoring.priorityTier,
        customerId,
        scoring.confidenceScore,
        scoring.verificationStatus,
        isChain ? 1 : 0,
        JSON.stringify(verificationEvidence),
        preservedDecision,
        oppId
      );
    }

    const row = db.prepare('SELECT * FROM commerce_opportunities WHERE id = ?').get(oppId) as Record<string, unknown>;
    createdOrUpdated.push(row);
  }

  createdOrUpdated.sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0));

  recordAuditEvent('commerce_engine', 'COMMERCE', 'LIVE_SMB_DISCOVERY', {
    niche,
    city,
    discoveredCount: createdOrUpdated.length,
  });

  return {
    status: createdOrUpdated.length > 0 ? ('VERIFIED_LIVE' as const) : ('NO_RESULTS' as const),
    discoveredCount: createdOrUpdated.length,
    opportunities: createdOrUpdated,
  };
}

export async function reverifyAndUpdateOpportunity(params: {
  opportunityId: string;
  businessName?: string;
  websiteUrl?: string | null;
  phone?: string | null;
  email?: string | null;
  isChainOrEnterprise?: boolean;
  historicalProposalNote?: string | null;
  archiveExistingProposal?: boolean;
  runLiveAudit?: boolean;
}) {
  const db = getDb();
  const opp = db.prepare('SELECT * FROM commerce_opportunities WHERE id = ?').get(params.opportunityId) as
    | Record<string, unknown>
    | undefined;
  if (!opp) throw new Error('Opportunity not found.');

  const effectiveWebsite = params.websiteUrl !== undefined ? params.websiteUrl : (opp.website_url ? String(opp.website_url) : null);
  const customerId = opp.customer_id ? String(opp.customer_id) : null;
  const existingCus = customerId
    ? (db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(customerId) as Record<string, unknown> | undefined)
    : undefined;

  let effectivePhone = params.phone !== undefined ? params.phone : (existingCus?.phone ? String(existingCus.phone) : null);
  let effectiveEmail = params.email !== undefined ? params.email : (existingCus?.email ? String(existingCus.email) : null);
  const effectiveName = (params.businessName || String(opp.business_name || opp.title)).trim();
  const isChain = params.isChainOrEnterprise ?? Boolean(opp.is_chain_or_enterprise);

  let auditResult: Awaited<ReturnType<typeof auditBusinessWebsiteLive>> | null = null;
  let websiteStatus: WebsitePresenceStatus = (opp.website_status as WebsitePresenceStatus) || 'UNKNOWN';
  let readinessScore = 0;
  let gaps: string[] = [];

  if (effectiveWebsite && params.runLiveAudit !== false) {
    auditResult = await auditBusinessWebsiteLive({ url: effectiveWebsite, customerId });
    readinessScore = auditResult.digitalReadinessScore;
    gaps = auditResult.detectedGaps;
    if (!effectiveEmail && auditResult.contactEmailsFound.length > 0) effectiveEmail = auditResult.contactEmailsFound[0];
    if (!effectivePhone && auditResult.contactPhonesFound.length > 0) effectivePhone = auditResult.contactPhonesFound[0];

    if (auditResult.sourceMode === 'OFFLINE_OR_UNREACHABLE') {
      websiteStatus = isChain ? 'CORPORATE_SITE_UNAUDITED' : 'UNREACHABLE';
      gaps = [
        isChain
          ? `Verified official website (${effectiveWebsite}) timed out to automated egress audit (WAF/geo filter); no unverified weaknesses claimed.`
          : `Official website (${effectiveWebsite}) unreachable to automated audit (${auditResult.summary}).`,
      ];
    } else if ((auditResult.httpStatus ?? 0) >= 400) {
      websiteStatus = 'BROKEN_WEBSITE';
    } else if (auditResult.digitalReadinessScore < 85 || auditResult.detectedGaps.length > 0) {
      websiteStatus = 'WEAK_WEBSITE';
    } else {
      websiteStatus = 'HEALTHY_WEBSITE';
    }
  } else if (!effectiveWebsite) {
    websiteStatus = effectivePhone || effectiveEmail ? 'NO_WEBSITE' : 'WEBSITE_UNCONFIRMED_LOW_EVIDENCE';
    gaps = [effectivePhone || effectiveEmail ? 'Reachable SMB contact verified; no website found.' : 'No website AND no phone/email verified.'];
  }

  const scoring = scoreBusinessOpportunity({
    websiteStatus,
    digitalReadinessScore: readinessScore,
    gapsCount: gaps.length,
    hasPhone: Boolean(effectivePhone),
    hasEmail: Boolean(effectiveEmail),
    hasAddress: Boolean(opp.address),
    isChainOrEnterprise: isChain,
    liveAuditCompleted: auditResult?.sourceMode === 'VERIFIED_LIVE_HTTP',
    hasCrossCheckCorroboration: Boolean(effectiveWebsite || effectivePhone || effectiveEmail),
    httpStatus: auditResult?.httpStatus ?? null,
  });

  const qualificationDecision: QualificationDecision =
    params.archiveExistingProposal && isChain
      ? 'EXCLUDED_CHAIN'
      : params.archiveExistingProposal
        ? 'ARCHIVED_HISTORICAL'
        : scoring.qualificationDecision;

  const verificationEvidence = {
    verifiedWebsite: effectiveWebsite,
    verifiedPhone: effectivePhone,
    verifiedEmail: effectiveEmail,
    isChainOrEnterprise: isChain,
    auditId: auditResult?.id || opp.audit_id || null,
    httpStatus: auditResult?.httpStatus ?? null,
    liveAuditSourceMode: auditResult?.sourceMode || null,
    detectedGaps: gaps,
    reverifiedAt: nowIso(),
  };

  const problemSummary = gaps.join(' ');
  const evidenceNotes = `Verified external intelligence (${nowIso().slice(0, 10)}): ${effectiveWebsite ? `Website ${effectiveWebsite} (audit: ${auditResult?.sourceMode || 'EXISTING'}, HTTP ${auditResult?.httpStatus ?? 'N/A'}).` : 'No website.'} Phone: ${effectivePhone || 'none'}. Email: ${effectiveEmail || 'none'}. Chain/Enterprise: ${isChain}.`;

  db.prepare(
    `UPDATE commerce_opportunities
     SET business_name = ?, website_url = ?, website_status = ?, audit_id = COALESCE(?, audit_id),
         problem_statement = ?, evidence_notes = ?, priority_score = ?, validation_score = ?, priority_tier = ?,
         confidence_score = ?, verification_status = ?, is_chain_or_enterprise = ?,
         verification_evidence_json = ?, qualification_decision = ?
     WHERE id = ?`
  ).run(
    effectiveName,
    effectiveWebsite,
    websiteStatus,
    auditResult?.id || null,
    problemSummary,
    evidenceNotes,
    scoring.priorityScore,
    scoring.priorityScore,
    scoring.priorityTier,
    scoring.confidenceScore,
    scoring.verificationStatus,
    isChain ? 1 : 0,
    JSON.stringify(verificationEvidence),
    qualificationDecision,
    params.opportunityId
  );

  if (customerId) {
    db.prepare(
      `UPDATE commerce_customers
       SET name = ?, company = ?, email = ?, phone = ?, website_url = ?,
           priority_score = ?, verification_status = ?, confidence_score = ?, is_chain_or_enterprise = ?,
           stage = CASE WHEN ? IN ('EXCLUDED_CHAIN','UNQUALIFIED_LOW_EVIDENCE','ARCHIVED_HISTORICAL') THEN 'LEAD' ELSE stage END
       WHERE id = ?`
    ).run(
      effectiveName,
      effectiveName,
      effectiveEmail,
      effectivePhone,
      effectiveWebsite,
      scoring.priorityScore,
      scoring.verificationStatus,
      scoring.confidenceScore,
      isChain ? 1 : 0,
      qualificationDecision,
      customerId
    );
  }

  if (params.historicalProposalNote && opp.proposal_id) {
    db.prepare('UPDATE commerce_proposals SET proposal_note = ?, updated_at = ? WHERE id = ?').run(
      params.historicalProposalNote,
      nowIso(),
      String(opp.proposal_id)
    );
  }

  recordAuditEvent('operator', 'COMMERCE', 'OPPORTUNITY_REVERIFIED', {
    opportunityId: params.opportunityId,
    websiteStatus,
    verificationStatus: scoring.verificationStatus,
    qualificationDecision,
    confidenceScore: scoring.confidenceScore,
  });

  return {
    opportunity: db.prepare('SELECT * FROM commerce_opportunities WHERE id = ?').get(params.opportunityId),
    customer: customerId ? db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(customerId) : null,
    audit: auditResult,
  };
}

export function prepareCommercialPackageForOpportunity(params: {
  opportunityId: string;
  setupPriceEur?: number;
  monthlyRetainerEur?: number;
  hourlyCostEur?: number;
  estimatedEffortHours?: number;
  pricingTier?: 'STARTER' | 'GROWTH' | 'MANAGED_SLA';
  language?: 'en' | 'it' | 'ar' | 'fr';
}) {
  const db = getDb();
  const opp = db.prepare('SELECT * FROM commerce_opportunities WHERE id = ?').get(params.opportunityId) as
    | Record<string, unknown>
    | undefined;
  if (!opp) throw new Error('Opportunity not found.');

  if (Number(opp.is_chain_or_enterprise || 0) === 1 || String(opp.qualification_decision || '') === 'EXCLUDED_CHAIN') {
    throw new Error('Cannot generate SMB commercial package for an excluded corporate chain/enterprise entity.');
  }

  const brandName = String(opp.business_name || opp.title || 'Local Business').split('—')[0].trim();
  const city = String(opp.city || opp.target_market || 'Local Market');
  const address = opp.address ? String(opp.address) : null;
  const publicSourceUrl = opp.public_source_url ? String(opp.public_source_url) : null;
  const websiteUrl = opp.website_url ? String(opp.website_url) : null;
  const websiteStatus = String(opp.website_status || 'UNKNOWN');
  const gapsText = String(opp.problem_statement || 'Missing responsive mobile lead-capture funnel and SEO metadata.');
  const lang = params.language || 'en';

  const linkedCus = opp.customer_id
    ? (db.prepare('SELECT phone FROM commerce_customers WHERE id = ?').get(String(opp.customer_id)) as { phone?: string | null } | undefined)
    : undefined;

  const services =
    lang === 'it'
      ? [
          websiteStatus === 'NO_WEBSITE' || websiteStatus === 'BROKEN_WEBSITE'
            ? `Sito Web Ufficiale Mobile-First per ${brandName}`
            : `Restyling Mobile Responsive & Prenotazione Diretta per ${brandName}`,
          'Modulo Diretto Richiesta Appuntamento / Prima Visita su Smartphone',
          'SEO Locale, Scheda Contatti Verificata & Monitoraggio Continuo',
        ]
      : [
          websiteStatus === 'NO_WEBSITE'
            ? `Custom High-Converting Website Launch for ${brandName} (${city})`
            : `Responsive Mobile & Direct Booking Upgrade for ${brandName}`,
          'Direct Lead Capture Form & Automated CRM Intake',
          'Local SEO Metadata, Google Business Readiness & Uptime SLA',
        ];

  const site = generateDigitalProductSite({
    brandName,
    tagline:
      lang === 'it'
        ? `${brandName} — Prenotazioni & Presenza Digitale (${city})`
        : `${brandName} — Fast Online Booking & Digital Client Portal (${city})`,
    language: lang,
    template: 'OMEGA_V5',
    services,
    address,
    city,
    phone: linkedCus?.phone || null,
  });

  const effortHours = Math.max(4, params.estimatedEffortHours ?? Number(opp.estimated_effort_hours || 16));
  const tier = params.pricingTier || (Number(opp.priority_score || 0) >= 75 ? 'GROWTH' : 'STARTER');
  const setupPriceEur = params.setupPriceEur ?? (tier === 'MANAGED_SLA' ? 890 : tier === 'GROWTH' ? 650 : 450);
  const monthlyRetainerEur = params.monthlyRetainerEur ?? (tier === 'MANAGED_SLA' ? 199 : tier === 'GROWTH' ? 149 : 99);

  let customerId = opp.customer_id ? String(opp.customer_id) : null;
  if (!customerId) {
    const cus = createLeadCustomer({
      name: brandName,
      company: brandName,
      channel: 'opportunity_pipeline',
      stage: 'QUALIFIED',
      notes: `Auto-linked from opportunity ${params.opportunityId}`,
    }) as Record<string, unknown>;
    customerId = String(cus.id);
    db.prepare('UPDATE commerce_customers SET opportunity_id = ? WHERE id = ?').run(params.opportunityId, customerId);
  } else {
    db.prepare("UPDATE commerce_customers SET stage = CASE WHEN stage = 'LEAD' THEN 'QUALIFIED' ELSE stage END WHERE id = ?").run(customerId);
  }

  const demoUrl = site.id === 'site_2e58dc5f-d' ? '/preview/fisioterapia-atlante' : `/preview/${site.id}`;
  const proposal = createCommercialProposal({
    opportunityId: params.opportunityId,
    customerId,
    siteId: site.id,
    clientName: brandName,
    title:
      lang === 'it'
        ? `${brandName} — Proposta Mobile-First & Acquisizione Clienti`
        : `${brandName} — Digital Storefront Demo & Lead Automation Proposal`,
    problemSummary: gapsText,
    pricingTier: tier,
    estimatedEffortHours: effortHours,
    hourlyCostEur: params.hourlyCostEur ?? 15,
    infraCostEur: 12,
    setupPriceEur,
    monthlyRetainerEur,
    language: lang,
    address,
    city,
    publicSourceUrl,
    websiteUrl,
    demoUrl,
  }) as Record<string, unknown>;

  db.prepare(
    `UPDATE commerce_opportunities
     SET status = 'PROPOSAL_PREPARED', customer_id = ?, site_id = ?, proposal_id = ?
     WHERE id = ?`
  ).run(customerId, site.id, String(proposal.id), params.opportunityId);

  recordAuditEvent('operator', 'COMMERCE', 'COMMERCIAL_PACKAGE_PREPARED', {
    opportunityId: params.opportunityId,
    customerId,
    siteId: site.id,
    proposalId: String(proposal.id),
    setupPriceEur,
    language: lang,
  });

  return {
    opportunity: db.prepare('SELECT * FROM commerce_opportunities WHERE id = ?').get(params.opportunityId),
    customer: db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(customerId),
    site,
    proposal,
  };
}

export function authorizeProposalOutreach(params: {
  proposalId: string;
  decidedBy?: string;
  markSent?: boolean;
}) {
  const db = getDb();
  const proposal = db.prepare('SELECT * FROM commerce_proposals WHERE id = ?').get(params.proposalId) as
    | Record<string, unknown>
    | undefined;
  if (!proposal) throw new Error('Proposal not found.');

  if (proposal.proposal_note && /DO NOT SEND|HISTORICAL_DRAFT/i.test(String(proposal.proposal_note))) {
    throw new Error(`Proposal ${params.proposalId} is locked as historical draft: ${String(proposal.proposal_note)}`);
  }

  if (proposal.opportunity_id) {
    const opp = db
      .prepare('SELECT is_chain_or_enterprise, qualification_decision FROM commerce_opportunities WHERE id = ?')
      .get(String(proposal.opportunity_id)) as { is_chain_or_enterprise?: number; qualification_decision?: string } | undefined;
    if (opp && (opp.is_chain_or_enterprise === 1 || opp.qualification_decision === 'EXCLUDED_CHAIN' || opp.qualification_decision === 'ARCHIVED_HISTORICAL')) {
      throw new Error(`Outreach blocked: linked opportunity status is ${opp.qualification_decision || 'EXCLUDED_CHAIN'}.`);
    }
  }

  const approvalId = Number(proposal.approval_id || 0);
  if (approvalId > 0) {
    const gate = db.prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId) as { status: string } | undefined;
    if (gate && gate.status === 'pending') {
      decideApproval(approvalId, 'approved', params.decidedBy || 'operator', 'Operator authorized commercial outreach');
    } else if (gate && gate.status === 'rejected') {
      throw new Error(`Approval gate #${approvalId} was rejected.`);
    }
  }

  const nextStatus: ProposalStatus = params.markSent ? 'SENT' : 'APPROVED';
  const updated = updateProposalStatus(params.proposalId, nextStatus) as Record<string, unknown>;

  if (params.markSent && proposal.customer_id) {
    db.prepare('UPDATE commerce_customers SET last_contacted_at = ? WHERE id = ?').run(nowIso(), String(proposal.customer_id));
  }

  const cus = proposal.customer_id
    ? (db.prepare('SELECT email, phone FROM commerce_customers WHERE id = ?').get(String(proposal.customer_id)) as
        | { email?: string | null; phone?: string | null }
        | undefined)
    : undefined;
  const email = cus?.email || '';
  const phone = cus?.phone || '';
  const subject = String(proposal.outreach_subject || '');
  const body = String(proposal.outreach_body || '');
  const whatsappMessage = String(proposal.whatsapp_message || '');
  const mailtoUrl = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const cleanPhoneDigits = phone.replace(/[^\d]/g, '');
  const whatsappUrl = cleanPhoneDigits && whatsappMessage ? `https://wa.me/${cleanPhoneDigits}?text=${encodeURIComponent(whatsappMessage)}` : null;

  return {
    proposal: updated,
    deliveryMode: params.markSent ? 'AUTHORIZED_OPERATOR_DISPATCH_LOGGED' : 'APPROVED_READY_FOR_DISPATCH',
    recipientEmail: email || null,
    recipientPhone: phone || null,
    mailtoUrl,
    whatsappUrl,
    whatsappMessage: whatsappMessage || null,
  };
}

export function recordCustomerReply(params: {
  customerId: string;
  replyStatus: ReplyStatus;
  replyNotes?: string;
  nextStage?: CustomerStage;
}) {
  const db = getDb();
  const cus = db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(params.customerId) as
    | Record<string, unknown>
    | undefined;
  if (!cus) throw new Error('CRM contact not found.');

  const repliedAt = params.replyStatus === 'NONE' ? null : nowIso();
  const nextStage: CustomerStage =
    params.nextStage ||
    (params.replyStatus === 'DECLINED'
      ? 'CHURNED'
      : params.replyStatus === 'REPLIED_INTERESTED' || params.replyStatus === 'REPLIED_QUESTIONS'
        ? 'RESPONDED'
        : (String(cus.stage) as CustomerStage));

  db.prepare(
    `UPDATE commerce_customers
     SET reply_status = ?, reply_notes = ?, replied_at = ?, stage = ?
     WHERE id = ?`
  ).run(params.replyStatus, params.replyNotes?.trim() || null, repliedAt, nextStage, params.customerId);

  recordAuditEvent('operator', 'COMMERCE', 'CRM_REPLY_RECORDED', {
    customerId: params.customerId,
    replyStatus: params.replyStatus,
    nextStage,
  });
  return db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(params.customerId);
}

export function recordVerifiedConversionPayment(params: {
  customerId: string;
  proposalId?: string | null;
  amountEur: number;
  paymentReference: string;
  paymentMethod?: string;
  invoiceTitle?: string;
  recordedBy?: string;
}) {
  if (params.amountEur <= 0) throw new Error('Verified payment amount must be positive.');
  const refNorm = params.paymentReference.trim();
  if (!refNorm || refNorm.length < 3) {
    throw new Error('Explicit payment reference (bank/Stripe/invoice reference) is required.');
  }
  const db = getDb();
  const cus = db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(params.customerId) as
    | Record<string, unknown>
    | undefined;
  if (!cus) throw new Error('Customer not found.');

  const duplicateRefRow = db
    .prepare(
      `SELECT id FROM commerce_financial_ledger
       WHERE entry_type = 'REVENUE' AND verified_payment = 1 AND lower(COALESCE(notes, '')) LIKE ?
       LIMIT 1`
    )
    .get(`%verified payment ref: ${refNorm.toLowerCase()} (%`) as { id: string } | undefined;
  if (duplicateRefRow) {
    throw new Error(`Duplicate payment reference '${refNorm}' already recorded (ledger ${duplicateRefRow.id}).`);
  }

  if (params.proposalId) {
    const prop = db.prepare('SELECT id FROM commerce_proposals WHERE id = ?').get(params.proposalId);
    if (!prop) throw new Error('Proposal not found.');
    updateProposalStatus(params.proposalId, 'WON');
  }
  advanceCustomerStage(params.customerId, 'CUSTOMER_WON');

  const inv = createDraftInvoice({
    customerId: params.customerId,
    title: params.invoiceTitle?.trim() || `${String(cus.name)} — Digital Delivery Payment`,
    currency: 'EUR',
    amount: Number(params.amountEur.toFixed(2)),
  }) as Record<string, unknown>;

  if (inv.approval_id) {
    decideApproval(Number(inv.approval_id), 'approved', params.recordedBy || 'operator', `Payment verified: ${params.paymentReference.trim()}`);
  }

  const ledger = recordFinancialEntry({
    entryType: 'REVENUE',
    category: params.paymentMethod?.trim() || 'verified_client_payment',
    amountEur: Number(params.amountEur.toFixed(2)),
    proposalId: params.proposalId || null,
    invoiceId: String(inv.id),
    verifiedPayment: true,
    notes: `Verified payment ref: ${params.paymentReference.trim()} (Customer: ${String(cus.name)})`,
    recordedBy: params.recordedBy || 'operator',
  }) as Record<string, unknown>;

  db.prepare('UPDATE commerce_financial_ledger SET customer_id = ? WHERE id = ?').run(params.customerId, String(ledger.id));

  return {
    customer: db.prepare('SELECT * FROM commerce_customers WHERE id = ?').get(params.customerId),
    invoice: db.prepare('SELECT * FROM commerce_invoices WHERE id = ?').get(String(inv.id)),
    ledger: db.prepare('SELECT * FROM commerce_financial_ledger WHERE id = ?').get(String(ledger.id)),
  };
}

export function listCommerceOverview() {
  const db = getDb();
  const metrics = getCommerceTruthMetrics();
  return {
    externalActionsEnabled: isExternalCommerceEnabled(),
    humanApprovalRequired: true,
    metrics: {
      ...metrics,
      expensesEur: metrics.actualOperatingCostsEur,
    },
    opportunities: db.prepare('SELECT * FROM commerce_opportunities ORDER BY priority_score DESC, created_at DESC LIMIT 50').all(),
    audits: db.prepare('SELECT * FROM commerce_presence_audits ORDER BY created_at DESC LIMIT 30').all(),
    customers: db.prepare('SELECT * FROM commerce_customers ORDER BY priority_score DESC, created_at DESC LIMIT 50').all(),
    proposals: db.prepare('SELECT * FROM commerce_proposals ORDER BY created_at DESC LIMIT 40').all(),
    contentAssets: db.prepare('SELECT * FROM commerce_content_assets ORDER BY created_at DESC LIMIT 30').all(),
    invoices: db.prepare('SELECT * FROM commerce_invoices ORDER BY created_at DESC LIMIT 40').all(),
    ledger: db.prepare('SELECT * FROM commerce_financial_ledger ORDER BY created_at DESC LIMIT 40').all(),
    sites: db
      .prepare('SELECT id, brand_name, tagline, language, template, artifact_id, status, approval_id, created_at FROM commerce_sites ORDER BY created_at DESC LIMIT 30')
      .all(),
  };
}

export function getCommerceSiteHtml(id: string): string | null {
  const row = getDb().prepare('SELECT html_content FROM commerce_sites WHERE id = ?').get(id) as
    | { html_content: string }
    | undefined;
  return row ? row.html_content : null;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
