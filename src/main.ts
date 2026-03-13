import { Actor } from 'apify';
import { CheerioCrawler, RequestQueue, log, EnqueueStrategy } from 'crawlee';

// --- Types ---
interface InputSchema {
    seeds: string[];
    maxDepth?: number;
    maxCompanies?: number;
    includeJobPages?: boolean;
    includeReports?: boolean;
    proxyConfiguration?: any;
    languages?: string[];
    minScore?: number;
    maxConcurrency?: number;
}

interface CompanyRecord {
    companyName: string | null;
    domain: string;
    rootUrl: string;
    hqCountryGuess: string | null;
    sustainabilityPages: Array<{ url: string; title: string | null }>;
    reports: Array<{
        url: string;
        title: string | null;
        yearGuess: number | null;
        type: string | null;
    }>;
    certifications: string[];
    netZeroCommitment: {
        hasCommitment: boolean;
        targetYear: number | null;
        sourceUrl: string | null;
    };
    esgJobs: Array<{
        title: string;
        location: string | null;
        url: string;
        sourceDomain: string;
    }>;
    contact: {
        emails: string[];
        contactPageUrls: string[];
    };
    social: {
        linkedin: string | null;
        twitter: string | null;
        facebook: string | null;
    };
    sustainabilityIntentScore: number;
    firstSeenAt: string;
    lastUpdatedAt: string;
}

// --- Config and State ---
let maxCompanies = 1000;
let minScore = 0;
let includeJobPages = true;
let includeReports = true;
let exportedCompaniesCount = 0;

const companiesMap = new Map<string, CompanyRecord>();

// --- Helpers ---
const getRootDomain = (url: string): string => {
    try {
        const urlOb = new URL(url);
        let hostname = urlOb.hostname.toLowerCase();
        if (hostname.startsWith('www.')) hostname = hostname.substring(4);
        return hostname;
    } catch {
        return url;
    }
};

const createEmptyRecord = (domain: string, rootUrl: string): CompanyRecord => ({
    companyName: null,
    domain,
    rootUrl,
    hqCountryGuess: null,
    sustainabilityPages: [],
    reports: [],
    certifications: [],
    netZeroCommitment: {
        hasCommitment: false,
        targetYear: null,
        sourceUrl: null,
    },
    esgJobs: [],
    contact: { emails: [], contactPageUrls: [] },
    social: { linkedin: null, twitter: null, facebook: null },
    sustainabilityIntentScore: 0,
    firstSeenAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
});

const calculateScore = (record: CompanyRecord): number => {
    let score = 0;
    if (record.sustainabilityPages.length > 0) score += 20;
    if (record.reports.length > 0) score += 20;
    // Distinct certs
    const uniqueCerts = new Set(record.certifications).size;
    score += Math.min(uniqueCerts * 10, 30);
    if (record.netZeroCommitment.hasCommitment) score += 10;
    score += Math.min(record.esgJobs.length * 5, 20);
    return Math.min(score, 100);
};

// --- Detection Logic ---
const SUSTAINABILITY_URL_KEYWORDS = ['sustainability', 'esg', 'csr', 'impact', 'responsibility', 'climate', 'net-zero', 'decarbonization', 'environment', 'reports', 'sustainability-report'];
const REPORT_PDF_KEYWORDS = ['sustainability report', 'esg report', 'integrated report', 'non-financial report', 'non‑financial report', 'corporate responsibility report'];
const CERTIFICATIONS = ['GRI', 'CDP', 'TCFD', 'SASB', 'UN Global Compact', 'UNGC', 'ISO 14001', 'SBTi'];
const ESG_JOB_KEYWORDS = ['sustainability', 'esg', 'climate', 'decarbonization', 'impact', 'responsible sourcing', 'sustainable finance'];
const JOB_URL_KEYWORDS = ['careers', 'jobs', 'join-us', 'work-with-us', 'career'];

const extractYear = (text: string): number | null => {
    const match = text.match(/\b(202[0-9]|203[0-9]|204[0-9]|2050)\b/);
    return match ? parseInt(match[0], 10) : null;
};

// --- Main Execution ---
log.info('Starting Global Climate & Sustainability B2B Leads Actor');

await Actor.init();

const input = await Actor.getInput<InputSchema>();
if (!input || !input.seeds || input.seeds.length === 0) {
    throw new Error('Invalid input: "seeds" property is required');
}

const maxDepth = input.maxDepth ?? 2;
maxCompanies = input.maxCompanies ?? 1000;
includeJobPages = input.includeJobPages ?? true;
includeReports = input.includeReports ?? true;
minScore = input.minScore ?? 0;
const maxConcurrency = input.maxConcurrency ?? 20;

const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
const requestQueue = await RequestQueue.open();

// Enqueue seeds
for (const seed of input.seeds) {
    await requestQueue.addRequest({ 
        url: seed, 
        userData: { depth: 0, label: 'SEED' } 
    });
}

// Crawler Setup
const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency,
    maxRequestsPerCrawl: 50 * input.seeds.length, // Failsafe
    async requestHandler({ request, $, log: requestLog, enqueueLinks }) {
        if (exportedCompaniesCount >= maxCompanies) {
            requestLog.info('Max companies reached. Stopping crawl.');
            return;
        }

        const url = request.loadedUrl || request.url;
        const domain = getRootDomain(url);
        const depth = request.userData.depth || 0;
        
        // Initialize record if missing
        if (!companiesMap.has(domain)) {
            companiesMap.set(domain, createEmptyRecord(domain, url));
        }
        const record = companiesMap.get(domain)!;
        record.lastUpdatedAt = new Date().toISOString();

        const title = $('title').text().trim() || null;
        const pageText = $('body').text().replace(/\s+/g, ' ').toLowerCase();

        // 1. Basic Company Info Extraction (Only once per domain or if empty)
        if (!record.companyName) {
            record.companyName = $('meta[property="og:site_name"]').attr('content') || 
                                 title?.split(/[-|]/)[0].trim() || 
                                 $('h1').first().text().trim() || 
                                 null;
        }

        // Extremely simple country guess from footer (In a real app, use a proper NER library)
        if (!record.hqCountryGuess) {
            const footerText = $('footer').text().toLowerCase();
            const countryHints = ['usa', 'united states', 'uk', 'united kingdom', 'germany', 'france', 'canada', 'australia', 'sweden'];
            for (const country of countryHints) {
                if (footerText.includes(country)) {
                    record.hqCountryGuess = country.toUpperCase();
                    break;
                }
            }
        }

        // 2. Sustainability Page Detection
        const urlLower = url.toLowerCase();
        const isSustPage = SUSTAINABILITY_URL_KEYWORDS.some(kw => urlLower.includes(kw));
        
        // Check for strong text signals
        const hasEsgLanguage = ['sustainability', 'esg', 'corporate responsibility', 'carbon footprint'].some(kw => pageText.includes(kw));
        
        if (isSustPage || (depth > 0 && hasEsgLanguage)) {
             if (!record.sustainabilityPages.some(p => p.url === url)) {
                 record.sustainabilityPages.push({ url, title });
             }
        }

        // 3. Certifications
        for (const cert of CERTIFICATIONS) {
            if (pageText.includes(cert.toLowerCase()) && !record.certifications.includes(cert)) {
                record.certifications.push(cert);
            }
        }

        // 4. Net Zero Commitment
        if (!record.netZeroCommitment.hasCommitment) {
            if (pageText.includes('net zero') || pageText.includes('net-zero') || pageText.includes('science based target') || pageText.includes('decarbonization')) {
                record.netZeroCommitment.hasCommitment = true;
                record.netZeroCommitment.sourceUrl = url;
                // Attempt to find a year near 'net zero'
                const match = pageText.match(/net zero( by)? (20[2-5][0-9])/i);
                if (match && match[2]) {
                    record.netZeroCommitment.targetYear = parseInt(match[2], 10);
                } else {
                    record.netZeroCommitment.targetYear = extractYear(pageText); // fallback
                }
            }
        }

        // 5. PDF Reports (if enabled and this is an HTML page linking to PDFs)
        if (includeReports) {
            $('a[href$=".pdf"]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                const pdfUrl = new URL(href, url).href;
                const linkText = $(el).text().toLowerCase();
                
                const isReport = REPORT_PDF_KEYWORDS.some(kw => linkText.includes(kw) || pdfUrl.toLowerCase().includes(kw.replace(' ', '-')));
                
                if (isReport && !record.reports.some(r => r.url === pdfUrl)) {
                    let typeMatch = REPORT_PDF_KEYWORDS.find(kw => linkText.includes(kw));
                    record.reports.push({
                        url: pdfUrl,
                        title: $(el).text().trim(),
                        yearGuess: extractYear(linkText) || extractYear(pdfUrl),
                        type: typeMatch ? typeMatch.replace(/\b\w/g, c => c.toUpperCase()) : 'Sustainability Report'
                    });
                }
            });
        }

        // 6. Job Pages (if enabled)
        const isJobPage = JOB_URL_KEYWORDS.some(kw => urlLower.includes(kw));
        if (includeJobPages && isJobPage) {
            // Very naive job extraction - looking for common job board card patterns, or just all links
            $('a').each((_, el) => {
                const jobTitle = $(el).text().trim();
                const jobHref = $(el).attr('href');
                if (!jobHref || jobTitle.length < 5) return;
                
                const jobTitleLower = jobTitle.toLowerCase();
                if (ESG_JOB_KEYWORDS.some(kw => jobTitleLower.includes(kw))) {
                    try {
                        const jobUrl = new URL(jobHref, url).href;
                        if (!record.esgJobs.some(j => j.url === jobUrl)) {
                            record.esgJobs.push({
                                title: jobTitle,
                                location: null, // Hard to reliably extract without specific CSS selectors
                                url: jobUrl,
                                sourceDomain: domain
                            });
                        }
                    } catch (e) { /* ignore */ }
                }
            });
        }

        // 7. Enqueue Links for deeper crawl
        if (depth < maxDepth && !isJobPage && !isSustPage) { // don't crawl deep from within job/sust pages to save requests
             await enqueueLinks({
                 strategy: EnqueueStrategy.SameDomain,
                 userData: { depth: depth + 1 },
                 transformRequestFunction(req) {
                     // Filter out obvious media/unrelated files
                     if (req.url.match(/\.(png|jpg|jpeg|gif|css|js|woff|svg)$/i)) return false;
                     return req;
                 }
             });
        }
        
        // Also manually enqueue job/careers pages if we are at depth 0 and haven't seen them
        if (depth === 0 && includeJobPages) {
            await enqueueLinks({
                globs: ['**/*career*', '**/*job*', '**/*join-us*', '**/*work-with-us*'],
                userData: { depth: depth + 1, label: 'JOB_BOARD' }
            });
        }
    },
    
    failedRequestHandler({ request, log }) {
        log.warning(`Request ${request.url} failed too many times.`);
    },
});

await crawler.run();

log.info('Crawl finished. Processing and exporting valid records...');

// Post-crawl processing: Score and Filter
const recordsToPush = [];
for (const record of companiesMap.values()) {
    record.sustainabilityIntentScore = calculateScore(record);
    
    if (record.sustainabilityIntentScore >= minScore) {
        recordsToPush.push(record);
        exportedCompaniesCount++;
        if (exportedCompaniesCount >= maxCompanies) {
            break;
        }
    }
}

log.info(`Pushing ${recordsToPush.length} valid companies to dataset.`);
await Actor.pushData(recordsToPush);

log.info('Actor finished successfully.');
await Actor.exit();
