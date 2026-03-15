import { Actor } from 'apify';
import { CheerioCrawler, RequestQueue, log, EnqueueStrategy } from 'crawlee';
import { getDomain } from 'tldts';

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

const extractCompanyNameFromDocument = ($: any, titleText: string | null): string | null => {
    let name = $('meta[property="og:site_name"]').attr('content') || 
               $('meta[property="og:title"]').attr('content') || 
               titleText || 
               $('h1').first().text() || 
               null;
    
    if (!name) return null;
    
    name = name.trim();
    name = name.replace(/Hang Tight!?|Routing to checkout(\.\.\.)?|burger|chevron( left| right)?|ellipses|logo(50th)?|pro logo|navigation( primary)?( cart| hamburger| profile| search| wishlist| x)?|Loading(\s*\.\.\.)?|play|search|shopping bag( filled)?|x|menu/gi, '');
    
    const parts = name.split(/[-|]/);
    if (parts.length > 1) {
        name = parts[0].trim();
    }
    
    name = name.replace(/\s+/g, ' ').trim();
    
    if (name.length > 120) {
        name = name.substring(0, 120).trim();
    }
    
    return name || null;
};

const normalizeEmail = (email: string): string | null => {
    let clean = email.trim();
    clean = clean.replace(/[.,;:\s!?]+$/, '');
    const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+(\.[a-zA-Z0-9._-]+)+$/;
    if (emailRegex.test(clean)) {
        return clean.toLowerCase();
    }
    return null;
};


const computeSustainabilityScore = (record: CompanyRecord): number => {
    let score = 0;
    if (record.sustainabilityPages.length === 1) score += 20;
    else if (record.sustainabilityPages.length > 1) score += 30;
    if (record.reports.length > 0) score += 40;
    // Distinct certs
    const uniqueCerts = new Set(record.certifications).size;
    score += Math.min(uniqueCerts * 20, 40);
    if (record.netZeroCommitment.hasCommitment) score += 20;
    score += Math.min(record.esgJobs.length * 5, 20);
    return Math.min(score, 100);
};

// --- Detection Logic ---
const REPORT_PDF_KEYWORDS = ['sustainability report', 'esg report', 'impact report', 'environmental report', 'integrated report', 'non-financial report', 'non‑financial report', 'annual sustainability', 'corporate responsibility report'];
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
        const urlLower = url.toLowerCase();
        const basicDomain = getRootDomain(url);
        const domain = getDomain(url) || basicDomain;
        const depth = request.userData.depth || 0;
        
        // Initialize record if missing
        if (!companiesMap.has(domain)) {
            companiesMap.set(domain, createEmptyRecord(domain, url));
        }
        const record = companiesMap.get(domain)!;
        record.lastUpdatedAt = new Date().toISOString();

        const title = $('title').text().trim() || null;
        const pageText = $('body').text().replace(/\s+/g, ' ').toLowerCase();

        // 1. Basic Company Info Extraction
        // Only prioritize homepage for the name
        if (depth === 0 || !record.companyName) {
            const newName = extractCompanyNameFromDocument($, title);
            if (newName && (depth === 0 || !record.companyName)) {
                record.companyName = newName;
            } else if (newName && record.companyName && newName.length < record.companyName.length && newName.length > 2) {
                record.companyName = newName;
            }
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

        // Helper to check if a path is a sustainability page
        const isSustainabilityPath = (path: string, exactSlugs: string[], avoidSlugs: string[], pathKeywords: string[], headingsText?: string): boolean => {
            const hasAvoidSlug = avoidSlugs.some(slug => path.includes(slug));
            const hasExactSlug = exactSlugs.some(slug => path === slug || path === slug + '/' || path.includes(slug));
            
            if (hasExactSlug) {
                return !hasAvoidSlug || exactSlugs.some(slug => path.endsWith(slug) || path.endsWith(slug + '/'));
            } else if (!hasAvoidSlug && headingsText) {
                if (pathKeywords.some(kw => path.includes(kw))) {
                    if (pathKeywords.some(kw => headingsText.includes(kw))) {
                        return true;
                    }
                }
            }
            return false;
        };

        const exactSlugs = ['/sustainability', '/our-footprint', '/our-footprint/', '/responsibility', '/csr', '/impact', '/esg', '/environment', '/social-responsibility', '/corporate-responsibility', '/climate', '/planet'];
        const avoidSlugs = ['/shop/', '/product/', '/products/', '/collections/'];
        const pathKeywords = ['sustainability', 'esg', 'csr', 'impact', 'climate', 'net-zero', 'decarbonization', 'planet'];

        // 2. Sustainability Page Detection (Current URL)
        let isSustPage = false;
        try {
            const u = new URL(url);
            isSustPage = isSustainabilityPath(u.pathname.toLowerCase(), exactSlugs, avoidSlugs, pathKeywords, $('h1, h2, h3').text().toLowerCase());
        } catch (e) { }

        if (isSustPage) {
             const u = new URL(url);
             if (getDomain(u.href) === domain || getRootDomain(u.href) === basicDomain) {
                 if (!record.sustainabilityPages.some(p => p.url === url)) {
                     record.sustainabilityPages.push({ url, title });
                 }
             }
        }

        // Crawl nav/footer links on homepage explicitly for sustainability pages
        if (depth === 0) {
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                try {
                    const linkUrl = new URL(href, url);
                    if (getDomain(linkUrl.href) === domain || getRootDomain(linkUrl.href) === basicDomain) {
                        const path = linkUrl.pathname.toLowerCase();
                        if (isSustainabilityPath(path, exactSlugs, avoidSlugs, pathKeywords)) {
                             if (!record.sustainabilityPages.some(p => p.url === linkUrl.href)) {
                                 record.sustainabilityPages.push({ url: linkUrl.href, title: $(el).text().trim() || null });
                             }
                        }
                    }
                } catch(e) {}
            });
        }

        // 3. Certifications
        for (const cert of CERTIFICATIONS) {
            if (pageText.includes(cert.toLowerCase()) && !record.certifications.includes(cert)) {
                record.certifications.push(cert);
            }
        }

        // 4. Net Zero Commitment
        if (!record.netZeroCommitment.hasCommitment && (isSustPage || depth === 0)) {
            if (pageText.includes('net zero') || pageText.includes('net-zero') || pageText.includes('science based target') || pageText.includes('sbti') || pageText.includes('decarbonization')) {
                record.netZeroCommitment.hasCommitment = true;
                record.netZeroCommitment.sourceUrl = url;
                // Attempt to find a year near 'net zero'
                const match = pageText.match(/(?:net zero|net-zero|science based target|sbti|decarbonization).{0,50}\b(20[2-5][0-9])\b/i);
                if (match && match[1]) {
                    record.netZeroCommitment.targetYear = parseInt(match[1], 10);
                } else {
                    record.netZeroCommitment.targetYear = extractYear(pageText); // fallback
                }
            }
        }

        // 5. Reports (if enabled and this is a sustainability page)
        if (includeReports && isSustPage) {
            $('a').each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                try {
                    const reportUrl = new URL(href, url).href;
                    if (reportUrl.match(/\.(png|jpg|jpeg|gif|css|js|woff|svg)$/i)) return;
                    
                    const linkText = $(el).text().toLowerCase();
                    const urlLower = reportUrl.toLowerCase();
                    
                    const isReport = REPORT_PDF_KEYWORDS.some(kw => linkText.includes(kw) || urlLower.includes(kw.replace(/ /g, '-')));
                    
                    if (isReport && !record.reports.some(r => r.url === reportUrl)) {
                        let typeMatch = REPORT_PDF_KEYWORDS.find(kw => linkText.includes(kw) || urlLower.includes(kw.replace(/ /g, '-')));
                        record.reports.push({
                            url: reportUrl,
                            title: $(el).text().trim() || null,
                            yearGuess: extractYear(linkText) || extractYear(urlLower),
                            type: typeMatch ? typeMatch.replace(/\b\w/g, c => c.toUpperCase()) : 'Sustainability Report'
                        });
                    }
                } catch (e) { /* ignore */ }
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

        // 8. Contact & Socials
        const contactKeywords = ['/contact', '/contact-us', '/contactus', '/get-in-touch', '/support'];
        if (contactKeywords.some(kw => urlLower.includes(kw))) {
            if (!record.contact.contactPageUrls.includes(url)) {
                record.contact.contactPageUrls.push(url);
            }
        }
        
        $('a').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const hrefLower = href.toLowerCase();
            
            if (contactKeywords.some(kw => hrefLower.includes(kw))) {
                try {
                     const cUrl = new URL(href, url).href;
                     if (getDomain(cUrl) === domain && !record.contact.contactPageUrls.includes(cUrl)) {
                         record.contact.contactPageUrls.push(cUrl);
                     }
                } catch { }
            }
            
            if (hrefLower.startsWith('mailto:')) {
                const emStr = hrefLower.replace('mailto:', '').split('?')[0];
                const cleanEm = normalizeEmail(emStr);
                if (cleanEm && !record.contact.emails.includes(cleanEm)) {
                    record.contact.emails.push(cleanEm);
                }
            }
            
            const inFooter = $(el).closest('footer').length > 0;
            if (depth === 0 || inFooter) {
                if (hrefLower.includes('linkedin.com/')) {
                    if (!record.social.linkedin) record.social.linkedin = href;
                } else if (hrefLower.includes('twitter.com/') || hrefLower.includes('x.com/')) {
                    if (!record.social.twitter && !hrefLower.includes('/share') && !hrefLower.includes('/status')) record.social.twitter = href;
                } else if (hrefLower.includes('facebook.com/')) {
                    if (!record.social.facebook && !hrefLower.includes('/sharer')) record.social.facebook = href;
                }
            }
        });
        
        const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g;
        const emMatch = $('body').text().match(emailRegex);
        if (emMatch) {
            const genericPrefixes = ['support@', 'help@', 'info@', 'contact@', 'sales@', 'hello@', 'service@', 'inquiries@', 'customerservice@', 'press@', 'media@', 'takedown@', 'accessibility@'];
            for (const emStr of emMatch) {
                const cleanEm = normalizeEmail(emStr);
                if (cleanEm) {
                    if (cleanEm.endsWith('.png') || cleanEm.endsWith('.jpg') || cleanEm.endsWith('.gif')) continue;
                    
                    const isGeneric = genericPrefixes.some(p => cleanEm.startsWith(p));
                    if (isGeneric || record.contact.emails.length < 3) {
                        if (!record.contact.emails.includes(cleanEm)) {
                             record.contact.emails.push(cleanEm);
                        }
                    }
                }
            }
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
    record.sustainabilityIntentScore = computeSustainabilityScore(record);
    
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
