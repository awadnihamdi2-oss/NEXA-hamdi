import crypto from 'node:crypto';
import { getDb, nowIso, recordAuditEvent } from '../db/database.ts';
import { wrapUntrustedContext } from '../security/auth.ts';
import type { EvidenceType } from '../types/nexa.ts';

export interface ArxivPaper {
  id: string;
  title: string;
  url: string;
  authors: string[];
  publishedAt: string;
  summary: string;
}

export interface ResearchQueryResult {
  query: string;
  extractedKeywords: string;
  status: 'VERIFIED_LIVE' | 'UNAVAILABLE_OFFLINE' | 'NO_RESULTS';
  papers: ArxivPaper[];
  errorMessage?: string;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractResearchKeywords(rawQuery: string): string {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'build', 'create',
    'design', 'system', 'using', 'based', 'research', 'how', 'what', 'which', 'make', 'zero',
  ]);
  const tokens = rawQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));
  const unique = Array.from(new Set(tokens)).slice(0, 6);
  return unique.length > 0 ? unique.join(' ') : rawQuery.trim().slice(0, 80);
}

export function parseArxivAtomXml(xml: string): ArxivPaper[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const papers: ArxivPaper[] = [];

  for (const entry of entries) {
    const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);
    const authorMatches = Array.from(entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)).map((m) =>
      decodeXmlEntities(m[1])
    );

    const url = idMatch ? decodeXmlEntities(idMatch[1]) : '';
    const title = titleMatch ? decodeXmlEntities(titleMatch[1]) : '';
    const summary = summaryMatch ? decodeXmlEntities(summaryMatch[1]) : '';
    const publishedAt = publishedMatch ? decodeXmlEntities(publishedMatch[1]) : '';
    const shortId = url.split('/abs/').pop() || crypto.createHash('sha256').update(title || url).digest('hex').slice(0, 12);

    if (title && url) {
      papers.push({
        id: `arxiv_${shortId.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        title,
        url,
        authors: authorMatches,
        publishedAt,
        summary,
      });
    }
  }

  return papers;
}

export async function searchArxivLive(rawQuery: string, maxResults = 5, missionId: string | null = null): Promise<ResearchQueryResult> {
  const keywords = extractResearchKeywords(rawQuery);
  const terms = keywords.split(/\s+/).filter(Boolean);
  const searchExpr = terms.map((t) => `all:${encodeURIComponent(t)}`).join('+AND+');
  const apiUrl = `https://export.arxiv.org/api/query?search_query=${searchExpr}&start=0&max_results=${Math.min(Math.max(maxResults, 1), 15)}`;

  try {
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'NEXA-QUANT-RESEARCH/1.0' },
      signal: AbortSignal.timeout(12000),
    });

    if (!resp.ok) {
      return {
        query: rawQuery,
        extractedKeywords: keywords,
        status: 'UNAVAILABLE_OFFLINE',
        papers: [],
        errorMessage: `arXiv API returned HTTP ${resp.status}`,
      };
    }

    const xml = await resp.text();
    const papers = parseArxivAtomXml(xml);
    const db = getDb();
    const ts = nowIso();

    const insertSource = db.prepare(
      `INSERT OR REPLACE INTO sources
       (id, source_type, title, url, authors, published_at, abstract, retrieval_status, raw_metadata_json, retrieved_at)
       VALUES (?, 'arxiv', ?, ?, ?, ?, ?, 'VERIFIED_LIVE', ?, ?)`
    );

    for (const paper of papers) {
      insertSource.run(
        paper.id,
        paper.title,
        paper.url,
        JSON.stringify(paper.authors),
        paper.publishedAt,
        paper.summary,
        JSON.stringify({ query: rawQuery, keywords, wrappedExcerpt: wrapUntrustedContext('arxiv', paper.summary) }),
        ts
      );
    }

    recordAuditEvent('research_engine', 'RESEARCH', 'ARXIV_SEARCH', { keywords, count: papers.length }, missionId);

    return {
      query: rawQuery,
      extractedKeywords: keywords,
      status: papers.length > 0 ? 'VERIFIED_LIVE' : 'NO_RESULTS',
      papers,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error reaching arXiv';
    return {
      query: rawQuery,
      extractedKeywords: keywords,
      status: 'UNAVAILABLE_OFFLINE',
      papers: [],
      errorMessage: msg,
    };
  }
}

export interface WebSignalItem {
  id: string;
  source: 'openalex' | 'wikipedia';
  title: string;
  url: string;
  snippet: string;
  publishedAt: string;
}

export interface WebSignalSearchResult {
  query: string;
  extractedKeywords: string;
  status: 'VERIFIED_LIVE' | 'UNAVAILABLE_OFFLINE' | 'NO_RESULTS';
  signals: WebSignalItem[];
  errorMessage?: string;
}

export async function searchPublicWebSignals(
  rawQuery: string,
  maxResults = 5,
  missionId: string | null = null
): Promise<WebSignalSearchResult> {
  const keywords = extractResearchKeywords(rawQuery);
  const limit = Math.min(Math.max(maxResults, 1), 10);
  const signals: WebSignalItem[] = [];
  const errors: string[] = [];

  // 1. Live OpenAlex public scholarly & industry intelligence API (zero API key)
  try {
    const oaUrl = `https://api.openalex.org/works?search=${encodeURIComponent(keywords)}&per-page=${limit}&select=id,title,publication_date,primary_location`;
    const oaResp = await fetch(oaUrl, {
      headers: { 'User-Agent': 'NEXA-COMMERCE-RESEARCH/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (oaResp.ok) {
      const data = (await oaResp.json()) as {
        results?: Array<{
          id?: string;
          title?: string;
          publication_date?: string;
          primary_location?: { landing_page_url?: string };
        }>;
      };
      for (const item of data.results || []) {
        if (!item.title) continue;
        const rawId = (item.id || crypto.randomUUID()).split('/').pop() || crypto.randomUUID().slice(0, 8);
        signals.push({
          id: `oa_${rawId.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          source: 'openalex',
          title: item.title,
          url: item.primary_location?.landing_page_url || item.id || 'https://openalex.org',
          snippet: `OpenAlex verified work (${item.publication_date || 'recent'})`,
          publishedAt: item.publication_date || '',
        });
      }
    } else {
      errors.push(`OpenAlex HTTP ${oaResp.status}`);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'OpenAlex unreachable');
  }

  // 2. Live Wikipedia Action API public search (zero API key)
  try {
    const wpUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keywords)}&format=json&srlimit=${Math.min(limit, 5)}`;
    const wpResp = await fetch(wpUrl, {
      headers: { 'User-Agent': 'NEXA-COMMERCE-RESEARCH/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (wpResp.ok) {
      const wpData = (await wpResp.json()) as {
        query?: { search?: Array<{ pageid: number; title: string; snippet: string; timestamp?: string }> };
      };
      for (const s of wpData.query?.search || []) {
        const cleanSnippet = s.snippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        signals.push({
          id: `wp_${s.pageid}`,
          source: 'wikipedia',
          title: s.title,
          url: `https://en.wikipedia.org/?curid=${s.pageid}`,
          snippet: cleanSnippet,
          publishedAt: s.timestamp || '',
        });
      }
    } else {
      errors.push(`Wikipedia HTTP ${wpResp.status}`);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Wikipedia unreachable');
  }

  const db = getDb();
  const ts = nowIso();
  if (signals.length > 0) {
    const insertSource = db.prepare(
      `INSERT OR REPLACE INTO sources
       (id, source_type, title, url, authors, published_at, abstract, retrieval_status, raw_metadata_json, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED_LIVE', ?, ?)`
    );
    for (const sig of signals) {
      insertSource.run(
        sig.id,
        sig.source,
        sig.title,
        sig.url,
        JSON.stringify([sig.source.toUpperCase()]),
        sig.publishedAt,
        sig.snippet,
        JSON.stringify({ query: rawQuery, keywords, wrappedExcerpt: wrapUntrustedContext('web_research', sig.snippet) }),
        ts
      );
    }
    recordAuditEvent('research_engine', 'RESEARCH', 'WEB_SIGNAL_SEARCH', { keywords, count: signals.length }, missionId);
  }

  return {
    query: rawQuery,
    extractedKeywords: keywords,
    status: signals.length > 0 ? 'VERIFIED_LIVE' : errors.length > 0 ? 'UNAVAILABLE_OFFLINE' : 'NO_RESULTS',
    signals,
    errorMessage: signals.length === 0 && errors.length > 0 ? errors.join('; ') : undefined,
  };
}

export function addEvidenceClaim(params: {
  missionId?: string | null;
  sourceId?: string | null;
  sourceLabel?: string | null;
  claim: string;
  evidenceType: EvidenceType;
  confidence?: number | null;
  notes?: string | null;
}): { id: number; contradictionFlag: boolean } {
  const db = getDb();
  const claim = params.claim.trim();
  if (claim.length < 5) {
    throw new Error('Evidence claim must contain at least 5 characters.');
  }
  if (params.confidence !== undefined && params.confidence !== null && (params.confidence < 0 || params.confidence > 1)) {
    throw new Error('Confidence must be between 0 and 1.');
  }

  // Lightweight contradiction detector against existing stored verified/hypothesis claims
  const existing = db.prepare('SELECT claim, evidence_type FROM evidence ORDER BY id DESC LIMIT 50').all() as Array<{
    claim: string;
    evidence_type: string;
  }>;
  const lower = claim.toLowerCase();
  const negPairs: Array<[string, string]> = [
    ['profitable', 'unprofitable'],
    ['enabled', 'disabled'],
    ['free', 'paid'],
    ['safe', 'unsafe'],
    ['valid', 'invalid'],
    ['pass', 'fail'],
  ];
  let contradictionFlag = false;
  for (const row of existing) {
    const rowLower = row.claim.toLowerCase();
    for (const [a, b] of negPairs) {
      if ((lower.includes(a) && rowLower.includes(b)) || (lower.includes(b) && rowLower.includes(a))) {
        const wordsA = new Set(lower.split(/\W+/).filter((w) => w.length > 4));
        const wordsB = rowLower.split(/\W+/).filter((w) => w.length > 4);
        const overlap = wordsB.filter((w) => wordsA.has(w)).length;
        if (overlap >= 2) {
          contradictionFlag = true;
          break;
        }
      }
    }
    if (contradictionFlag) break;
  }

  const res = db
    .prepare(
      `INSERT INTO evidence
       (mission_id, source_id, source_label, claim, evidence_type, confidence, contradiction_flag, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.missionId ?? null,
      params.sourceId ?? null,
      params.sourceLabel ?? null,
      claim,
      params.evidenceType,
      params.confidence ?? null,
      contradictionFlag ? 1 : 0,
      params.notes ?? null,
      nowIso()
    );

  return { id: Number(res.lastInsertRowid), contradictionFlag };
}

export function queryKnowledgeBase(searchTerm = '', evidenceType?: EvidenceType) {
  const db = getDb();
  const term = searchTerm.trim().toLowerCase();

  let sources = db.prepare('SELECT * FROM sources ORDER BY retrieved_at DESC LIMIT 100').all() as Array<Record<string, unknown>>;
  let evidenceRows = db.prepare('SELECT * FROM evidence ORDER BY id DESC LIMIT 200').all() as Array<Record<string, unknown>>;

  if (evidenceType) {
    evidenceRows = evidenceRows.filter((e) => e.evidence_type === evidenceType);
  }

  if (term) {
    sources = sources.filter(
      (s) =>
        String(s.title || '').toLowerCase().includes(term) ||
        String(s.abstract || '').toLowerCase().includes(term)
    );
    evidenceRows = evidenceRows.filter(
      (e) =>
        String(e.claim || '').toLowerCase().includes(term) ||
        String(e.source_label || '').toLowerCase().includes(term)
    );
  }

  return {
    sources: sources.map((s) => ({
      id: String(s.id),
      sourceType: String(s.source_type),
      title: String(s.title),
      url: s.url ? String(s.url) : null,
      authors: JSON.parse(String(s.authors || '[]')) as string[],
      publishedAt: s.published_at ? String(s.published_at) : null,
      abstract: s.abstract ? String(s.abstract) : '',
      retrievalStatus: String(s.retrieval_status),
      retrievedAt: String(s.retrieved_at),
    })),
    evidence: evidenceRows.map((e) => ({
      id: Number(e.id),
      missionId: e.mission_id ? String(e.mission_id) : null,
      sourceId: e.source_id ? String(e.source_id) : null,
      sourceLabel: e.source_label ? String(e.source_label) : null,
      claim: String(e.claim),
      evidenceType: e.evidence_type as EvidenceType,
      confidence: e.confidence !== null && e.confidence !== undefined ? Number(e.confidence) : null,
      contradictionFlag: Number(e.contradiction_flag) === 1,
      notes: e.notes ? String(e.notes) : null,
      createdAt: String(e.created_at),
    })),
  };
}
