const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const cheerio = require('cheerio');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = 3000;
const TAPP_PACKAGE = '@aarwitz/tapp@0.17.12';
const TAPP_CAPTURE_ROOT = path.join(os.homedir(), '.tapp', 'captures');
const reportsDir = path.join(__dirname, 'reports');
const auditLogPath = path.join(__dirname, 'audit-log.json');
const leadsPath = path.join(__dirname, 'leads.json');
const auditJobsPath = process.env.CLIEN_AUDIT_JOBS_PATH || path.join(__dirname, 'audit-jobs.json');

const recordingsDir = path.join(__dirname, 'recordings');
fs.mkdirSync(recordingsDir, { recursive: true });
fs.mkdirSync(reportsDir, { recursive: true });

if (!fs.existsSync(auditLogPath)) {
  fs.writeFileSync(auditLogPath, '[]\n');
}
if (!fs.existsSync(leadsPath)) {
  fs.writeFileSync(leadsPath, '{"version":1,"leads":[]}\n');
}
if (!fs.existsSync(auditJobsPath)) {
  fs.writeFileSync(auditJobsPath, '{"version":1,"jobs":[]}\n');
}

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));
app.use('/recordings', express.static(recordingsDir));
app.use('/reports', express.static(reportsDir));
app.use('/tapp-captures', express.static(TAPP_CAPTURE_ROOT));

function safeUrl(value) {
  if (!value) return null;
  try {
    const normalized = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    const parsed = new URL(normalized);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname.includes('.') ? parsed : null;
  } catch (error) {
    return null;
  }
}

function buildDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return 'example.com';
  }
}

function companyNameFromDomain(domain) {
  const core = domain.replace(/^www\./, '').split('.')[0];
  return core.split(/[-_]/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function slugifyCompanyName(companyName) {
  return String(companyName || 'company')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'company';
}

function normalizeAuditLog(value) {
  if (value && value.version === 1 && value.companies && typeof value.companies === 'object') {
    return value;
  }

  const archive = { version: 1, companies: {} };
  const entries = Array.isArray(value) ? value : [];
  entries.forEach((entry) => {
    const company = entry && entry.company || {};
    const domain = String(company.domain || buildDomain(company.url || '')).replace(/^www\./, '').toLowerCase();
    if (!domain || domain === 'example.com') return;
    if (!archive.companies[domain]) {
      archive.companies[domain] = {
        name: company.name || companyNameFromDomain(domain),
        url: company.url || `https://${domain}`,
        audits: []
      };
    }
    const { company: duplicateCompany, ...audit } = entry;
    if (!archive.companies[domain].audits.some((candidate) => candidate.captureId === audit.captureId)) {
      archive.companies[domain].audits.push(audit);
    }
  });
  Object.values(archive.companies).forEach((company) => {
    company.audits.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  });
  return archive;
}

function readAuditLog() {
  try {
    return normalizeAuditLog(JSON.parse(fs.readFileSync(auditLogPath, 'utf8')));
  } catch (error) {
    return { version: 1, companies: {} };
  }
}

function writeAuditLog(archive) {
  fs.writeFileSync(auditLogPath, `${JSON.stringify(archive, null, 2)}\n`);
}

function readLeads() {
  try {
    const value = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));
    return { version: 1, leads: Array.isArray(value && value.leads) ? value.leads : [] };
  } catch (error) {
    return { version: 1, leads: [] };
  }
}

function writeLeads(value) {
  fs.writeFileSync(leadsPath, `${JSON.stringify(value, null, 2)}\n`);
}

function readAuditJobs() {
  try {
    const value = JSON.parse(fs.readFileSync(auditJobsPath, 'utf8'));
    return { version: 1, jobs: Array.isArray(value && value.jobs) ? value.jobs : [] };
  } catch (error) {
    return { version: 1, jobs: [] };
  }
}

function writeAuditJobs(value) {
  const temporaryPath = `${auditJobsPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, auditJobsPath);
}

function recoverInterruptedAuditJobs() {
  const archive = readAuditJobs();
  let changed = false;
  archive.jobs.forEach((job) => {
    if (!['queued', 'running', 'processing'].includes(job.status)) return;
    job.status = 'interrupted';
    job.error = 'Server restarted before the audit completed.';
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    changed = true;
  });
  if (changed) writeAuditJobs(archive);
}

function createAuditJob(targetUrl) {
  const timestamp = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    targetUrl,
    domain: buildDomain(targetUrl).replace(/^www\./, '').toLowerCase(),
    status: 'queued',
    phase: null,
    screens: 0,
    actions: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null,
    captureId: null,
    error: null
  };
  const archive = readAuditJobs();
  archive.jobs.unshift(job);
  writeAuditJobs(archive);
  return job;
}

function updateAuditJob(id, changes) {
  const archive = readAuditJobs();
  const job = archive.jobs.find((candidate) => candidate.id === id);
  if (!job) return null;
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  writeAuditJobs(archive);
  return job;
}

recoverInterruptedAuditJobs();

const pendingAuditExecutions = [];
let auditWorkerRunning = false;
let activeAuditExecution = null;

function refreshAuditQueuePositions() {
  pendingAuditExecutions.forEach((entry, index) => {
    const queuePosition = index + 1;
    updateAuditJob(entry.job.id, { status: 'queued', phase: 'queued', queuePosition });
    entry.onQueued({ jobId: entry.job.id, position: queuePosition });
  });
}

async function processAuditQueue() {
  if (auditWorkerRunning) return;
  auditWorkerRunning = true;
  while (pendingAuditExecutions.length > 0) {
    const entry = pendingAuditExecutions.shift();
    activeAuditExecution = entry;
    updateAuditJob(entry.job.id, { status: 'running', phase: 'starting', queuePosition: 0 });
    refreshAuditQueuePositions();
    try {
      const result = await entry.executor(entry.job, entry.baseUrl, entry.onProgress, entry.controller.signal);
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      activeAuditExecution = null;
    }
  }
  auditWorkerRunning = false;
}

function enqueueAuditJob(job, baseUrl, onProgress = () => {}, onQueued = () => {}, executor = executeAuditJob) {
  return new Promise((resolve, reject) => {
    pendingAuditExecutions.push({ job, baseUrl, onProgress, onQueued, executor, resolve, reject, controller: new AbortController() });
    refreshAuditQueuePositions();
    void processAuditQueue();
  });
}

function cancelAuditJob(id) {
  if (activeAuditExecution && activeAuditExecution.job.id === id) {
    activeAuditExecution.controller.abort();
    return true;
  }
  const index = pendingAuditExecutions.findIndex((entry) => entry.job.id === id);
  if (index < 0) return false;
  const [entry] = pendingAuditExecutions.splice(index, 1);
  const error = new Error('Audit canceled.');
  error.name = 'AbortError';
  updateAuditJob(id, { status: 'canceled', phase: 'canceled', queuePosition: 0, finishedAt: new Date().toISOString(), error: null });
  entry.reject(error);
  refreshAuditQueuePositions();
  return true;
}

function normalizeLeadInput(value) {
  const url = safeUrl(value && value.url);
  if (!url) return null;
  const domain = url.hostname.replace(/^www\./, '').toLowerCase();
  return {
    name: String(value && value.name || companyNameFromDomain(domain)).trim().slice(0, 100),
    url: url.origin,
    domain,
    address: String(value && value.address || '').trim().slice(0, 300),
    owners: Array.isArray(value && value.owners) ? value.owners.map((owner) => String(owner).trim()).filter(Boolean).slice(0, 10) : [],
    summary: String(value && value.summary || '').trim().slice(0, 1000),
    industry: String(value && value.industry || '').trim().slice(0, 120),
    email: String(value && value.email || '').trim().slice(0, 200),
    phone: String(value && value.phone || '').trim().slice(0, 80),
    sourceUrls: Array.isArray(value && value.sourceUrls) ? value.sourceUrls.map(String).slice(0, 10) : [url.toString()]
  };
}

function extractUrlsFromText(content) {
  const matches = String(content || '').match(/(?:https?:\/\/|www\.)[^\s<>()"']+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|co|biz|us|ca|ai)\b[^\s<>()"']*/gi) || [];
  const urls = new Map();
  matches.forEach((match) => {
    const parsed = safeUrl(match.replace(/[.,;:!?]+$/, ''));
    if (parsed) urls.set(parsed.hostname.replace(/^www\./, '').toLowerCase(), parsed.origin);
  });
  return [...urls.values()].slice(0, 25);
}

function compactJsonLd(value, output = []) {
  if (Array.isArray(value)) value.forEach((item) => compactJsonLd(item, output));
  else if (value && typeof value === 'object') {
    output.push(value);
    if (value['@graph']) compactJsonLd(value['@graph'], output);
  }
  return output;
}

async function extractLeadProfile(targetUrl) {
  const parsed = safeUrl(targetUrl);
  if (!parsed) return null;
  const domain = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const fallback = normalizeLeadInput({ url: parsed.origin, sourceUrls: [parsed.toString()] });
  try {
    const response = await fetch(parsed.origin, {
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': 'Clien/1.0 lead research' }
    });
    if (!response.ok) return fallback;
    const html = await response.text();
    const $ = cheerio.load(html);
    const jsonLd = [];
    $('script[type="application/ld+json"]').each((index, element) => {
      try { compactJsonLd(JSON.parse($(element).text()), jsonLd); } catch (error) {}
    });
    const organization = jsonLd.find((item) => /Organization|LocalBusiness|Corporation/i.test(String(item['@type'] || ''))) || {};
    const addressValue = organization.address || jsonLd.find((item) => item.address)?.address;
    const address = typeof addressValue === 'string' ? addressValue : addressValue && [addressValue.streetAddress, addressValue.addressLocality, addressValue.addressRegion, addressValue.postalCode, addressValue.addressCountry].filter(Boolean).join(', ');
    const founderValue = organization.founder || organization.founders || [];
    const owners = (Array.isArray(founderValue) ? founderValue : [founderValue]).map((owner) => typeof owner === 'string' ? owner : owner && owner.name).filter(Boolean);
    const title = $('meta[property="og:site_name"]').attr('content') || organization.name || $('title').first().text().split(/\s+[|–—-]\s+/)[0];
    const summary = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || organization.description || '';
    const bodyText = $('body').text().replace(/\s+/g, ' ');
    const email = organization.email || (bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || '';
    const phone = organization.telephone || '';
    return normalizeLeadInput({
      name: title || companyNameFromDomain(domain),
      url: parsed.origin,
      address,
      owners,
      summary,
      industry: organization.industry || organization.knowsAbout || '',
      email,
      phone,
      sourceUrls: [parsed.toString()]
    });
  } catch (error) {
    return fallback;
  }
}

function saveAuditLog(result, payload) {
  const capturePath = payload && payload.capture && payload.capture.path;
  const captureId = payload && payload.capture && payload.capture.id
    ? payload.capture.id
    : capturePath
      ? path.basename(capturePath)
      : `audit-${Date.now()}`;
  const capturedAt = capturePath && fs.existsSync(capturePath)
    ? fs.statSync(capturePath).mtime.toISOString()
    : new Date().toISOString();
  const audit = {
    captureId,
    capturedAt,
    audit: {
      grade: result.outreachGrade,
      score: result.outreachScore,
      gradeBasis: result.gradeBasis,
      findings: result.bugsFound,
      screens: Number(payload && payload.screensExplored || 0),
      actions: Number(payload && payload.actionsPerformed || 0),
      findingFingerprints: result.findingFingerprints,
      reproduction: result.reproduction
    },
    evidence: {
      type: 'tapp-frame-sequence',
      frames: result.slides.length,
      capturePath,
      url: result.evidenceUrl
    },
    report: {
      pdfUrl: result.reportPdfUrl,
      projectPrice: result.projectPrice
    }
  };
  const archive = readAuditLog();
  const domain = result.domain.replace(/^www\./, '').toLowerCase();
  const company = archive.companies[domain] || { audits: [] };
  company.name = result.companyName;
  company.url = result.companyUrl;
  company.audits = company.audits.filter((candidate) => candidate.captureId !== captureId);
  company.audits.push(audit);
  company.audits.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  archive.companies[domain] = company;
  writeAuditLog(archive);
  return audit;
}

writeAuditLog(readAuditLog());

function companyNameFromCandidates(candidates, domain) {
  const domainCore = domain.replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const values = candidates.map((value) => String(value || '').trim()).filter((value) => value.length > 1 && value.length < 100);

  for (const value of values) {
    const words = value.match(/[a-z0-9]+(?:['’][a-z0-9]+)?/gi) || [];
    for (let start = 0; start < words.length; start += 1) {
      let joined = '';
      for (let end = start; end < words.length; end += 1) {
        joined += words[end].replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (joined === domainCore) {
          return words.slice(start, end + 1).map((word) =>
            /^[A-Z0-9]+$/.test(word) && word.length > 2
              ? word.charAt(0) + word.slice(1).toLowerCase()
              : word
          ).join(' ');
        }
        if (!domainCore.startsWith(joined)) break;
      }
    }
  }

  return values[0] || companyNameFromDomain(domain);
}

async function extractCompanyProfile(targetUrl) {
  const parsed = safeUrl(targetUrl);
  const domain = buildDomain(targetUrl);
  const fallback = { name: companyNameFromDomain(domain), url: parsed ? parsed.origin : targetUrl };
  if (!parsed) return fallback;

  try {
    const response = await fetch(parsed.origin, {
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': 'Clien/1.0 website review' }
    });
    if (!response.ok) return fallback;
    const $ = cheerio.load(await response.text());
    const candidates = [
      $('meta[property="og:site_name"]').attr('content'),
      $('meta[name="application-name"]').attr('content')
    ];

    $('script[type="application/ld+json"]').each((index, element) => {
      try {
        const data = JSON.parse($(element).text());
        const entries = Array.isArray(data) ? data : [data];
        entries.forEach((entry) => {
          const nodes = entry && Array.isArray(entry['@graph']) ? entry['@graph'] : [entry];
          nodes.forEach((node) => {
            const types = Array.isArray(node && node['@type']) ? node['@type'] : [node && node['@type']];
            if (types.some((type) => /Organization|LocalBusiness|Restaurant|Store|Hotel/i.test(type || ''))) {
              candidates.push(node.name);
            }
          });
        });
      } catch (error) {
        // Ignore invalid third-party structured data
      }
    });

    const title = $('title').first().text().trim();
    if (title) candidates.push(...title.split(/\s+[|–—-]\s+/));
    return { name: companyNameFromCandidates(candidates, domain), url: parsed.origin };
  } catch (error) {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTappExplore(targetUrl, onProgress = () => {}, signal) {
  const parsed = safeUrl(targetUrl);
  if (!parsed) {
    throw new Error('Please enter a valid website URL.');
  }

  const normalized = parsed.toString();
  const jsonPath = path.join(os.tmpdir(), `clien-tapp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const args = [
    '-y', TAPP_PACKAGE, 'explore', normalized,
    '--platform', 'web',
    '--actions', '120',
    '--timeout', '300',
    '--json', jsonPath
  ];

  let activityReported = false;
  await new Promise((resolve, reject) => {
    const child = execFile('npx', args, { cwd: __dirname, signal }, (error, stdout, stderr) => {
      if (signal && signal.aborted) {
        const abortError = new Error('Audit canceled.');
        abortError.name = 'AbortError';
        return reject(abortError);
      }
      if (error && error.code !== 0) {
        return reject(new Error(stderr || stdout || error.message));
      }
      resolve();
    });
    const reportActivity = () => {
      if (activityReported) return;
      activityReported = true;
      onProgress({ phase: 'checking' });
    };
    child.stdout.on('data', reportActivity);
    child.stderr.on('data', reportActivity);
  });

  if (!activityReported) onProgress({ phase: 'checking' });

  await sleep(200);

  if (!fs.existsSync(jsonPath)) {
    throw new Error('Tapp did not produce an audit result file.');
  }

  const raw = fs.readFileSync(jsonPath, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error('Tapp returned an invalid JSON result.');
  }

  try {
    fs.unlinkSync(jsonPath);
  } catch (error) {
    // Ignore cleanup failures
  }

  return payload;
}

function getCaptureMedia(payload, findings) {
  const capturePath = payload && payload.capture && payload.capture.path ? payload.capture.path : null;
  if (!capturePath || !fs.existsSync(capturePath)) {
    return { slides: [], reportHtml: null };
  }

  const files = fs.readdirSync(capturePath)
    .filter((file) => /^state_.*\.(png|jpg|jpeg|webp)$/i.test(file))
    .sort((a, b) => {
      const aNum = Number((a.match(/state_(\d+)/) || [])[1] || 0);
      const bNum = Number((b.match(/state_(\d+)/) || [])[1] || 0);
      return aNum - bNum;
    });

  let uiMap = null;
  const uiMapPath = path.join(capturePath, 'ui-map.json');
  if (fs.existsSync(uiMapPath)) {
    try {
      uiMap = JSON.parse(fs.readFileSync(uiMapPath, 'utf8'));
    } catch (error) {
      uiMap = null;
    }
  }

  const captureName = path.basename(capturePath);
  const screens = Array.isArray(payload && payload.screens) ? payload.screens : [];
  const actionByScreen = new Map();
  const markerPath = path.join(capturePath, 'ocqa-markers.txt');
  if (fs.existsSync(markerPath)) {
    let latestAction = null;
    fs.readFileSync(markerPath, 'utf8').split('\n').forEach((line) => {
      const separator = line.indexOf(':');
      if (separator < 0) return;
      const marker = line.slice(0, separator);
      try {
        const value = JSON.parse(line.slice(separator + 1));
        if (marker === 'OCQA_ACTION') {
          latestAction = value.narrative || `${value.type || 'Action'} ${value.target || ''}`.trim();
        }
        if (marker === 'OCQA_STATE' && value.screen && !actionByScreen.has(value.screen)) {
          actionByScreen.set(value.screen, latestAction || `Opened ${value.url || value.screen}`);
        }
        if (marker === 'OCQA_TRANSITION' && value.to) {
          actionByScreen.set(value.to, value.action ? `Selected “${value.action}”` : latestAction);
        }
      } catch (error) {
        // Ignore incomplete trace lines
      }
    });
  }

  const slides = files.map((file) => {
    const stateNumber = Number((file.match(/state_(\d+)/) || [])[1] || 0);
    const screen = screens[stateNumber - 1] || `Screen ${stateNumber}`;
    const node = uiMap && Array.isArray(uiMap.nodes)
      ? uiMap.nodes.find((candidate) => candidate.name === screen)
      : null;
    const routes = node && Array.isArray(node.routes) ? node.routes.map((route) => route.path) : [];
    const issues = findings.filter((finding) => {
      if (finding.screen && finding.screen === screen) return true;
      const routeLikeScreen = typeof finding.screen === 'string' && finding.screen.startsWith('/') ? finding.screen : null;
      const destinationValues = [finding.target, routeLikeScreen].filter(Boolean);
      const valuesToMatch = finding.type === 'broken_link' && destinationValues.length > 0
        ? destinationValues
        : [...destinationValues, finding.url];
      const issueUrls = valuesToMatch.map((value) => {
        try {
          return value ? new URL(value, payload.target).pathname.replace(/\/$/, '') : null;
        } catch (error) {
          return null;
        }
      }).filter(Boolean);
      return routes.some((route) => issueUrls.includes(route.replace(/\/$/, '')));
    }).map((finding) => ({
      number: findings.indexOf(finding) + 1,
      severity: String(finding.severity || 'info').toUpperCase(),
      title: String(finding.title || 'Potential issue').replace(/\u001b\[[0-9;]*m/g, ''),
      expected: describeExpectedBehavior(finding),
      observed: describeObservedBehavior(finding)
    }));

    return {
      src: `/tapp-captures/${captureName}/${encodeURIComponent(file)}`,
      screen,
      action: actionByScreen.get(screen) || `Opened ${screen}`,
      issues
    };
  });
  const reportHtml = fs.existsSync(path.join(capturePath, 'report.html'))
    ? `/tapp-captures/${captureName}/report.html`
    : null;

  return { slides, reportHtml };
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const ACTIONABLE_FINDING_TYPES = new Set([
  'anchor_missing',
  'broken_link',
  'dead_control',
  'js_exception',
  'load_timeout',
  'page_error',
  'request_failed',
  'unresponsive_element'
]);

function isActionableFinding(finding) {
  const title = String(finding && finding.title || '');
  if (/^Outbound link (?:unreachable|returns HTTP)/i.test(title)) return false;
  return ACTIONABLE_FINDING_TYPES.has(finding && finding.type);
}

function findingFingerprint(finding) {
  const normalizedTitle = String(finding && finding.title || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b\d{3,}\b/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return crypto.createHash('sha256')
    .update(`${finding && finding.type || 'unknown'}|${normalizedTitle}`)
    .digest('hex')
    .slice(0, 16);
}

function getComparisonContext(domain) {
  const company = readAuditLog().companies[String(domain || '').replace(/^www\./, '').toLowerCase()];
  const comparableAudits = company && Array.isArray(company.audits)
    ? company.audits.filter((entry) => Array.isArray(entry.audit && entry.audit.findingFingerprints))
    : [];
  return {
    priorAuditCount: comparableAudits.length,
    priorFindingFingerprints: [...new Set(comparableAudits.flatMap((entry) => entry.audit.findingFingerprints))]
  };
}

function findingConfidence(finding, comparison) {
  if (!comparison || comparison.priorAuditCount === 0) return 'baseline';
  return comparison.priorFindingFingerprints.includes(findingFingerprint(finding))
    ? 'reproduced'
    : 'needs-verification';
}

function sortFindingsByPriority(findings) {
  return [...findings].sort((left, right) => {
    const actionability = Number(isActionableFinding(right)) - Number(isActionableFinding(left));
    if (actionability !== 0) return actionability;
    return (SEVERITY_RANK[String(left.severity || 'info').toLowerCase()] ?? 5) -
      (SEVERITY_RANK[String(right.severity || 'info').toLowerCase()] ?? 5);
  });
}

function describeExpectedBehavior(finding) {
  const expectations = {
    anchor_missing: 'The selected link should move the visitor to the intended section.',
    broken_link: 'The selected link should open a working destination.',
    dead_control: 'The selected control should visibly respond and complete its intended action.',
    js_exception: 'The page should run without a JavaScript exception.',
    load_timeout: 'The destination should finish loading within the audit timeout.',
    page_error: 'The page should load without a visible or runtime error.',
    request_failed: 'The required page resource should load successfully.',
    unresponsive_element: 'The selected control should visibly respond and complete its intended action.'
  };
  return expectations[finding && finding.type] || 'The destination should load and remain usable.';
}

function describeObservedBehavior(finding) {
  const title = String(finding && finding.title || 'The check did not behave as expected')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const location = finding && (finding.target || finding.url);
  return `${title}${location ? ` (${location})` : ''}.`;
}

function conciseFindingTitle(finding) {
  const title = String(finding && finding.title || 'Potential issue')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/https?:\/\/\S+/gi, 'linked destination')
    .replace(/\s+/g, ' ')
    .trim();
  return title.length > 150 ? `${title.slice(0, 147)}...` : title;
}

function conciseObservedBehavior(finding) {
  const observed = describeObservedBehavior(finding)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return observed.length > 180 ? `${observed.slice(0, 177)}...` : observed;
}

function estimateProjectPrice(findings) {
  const hourlyRate = Number(process.env.LIDI_HOURLY_RATE) || 125;
  const groups = new Map();

  findings.filter(isActionableFinding).forEach((finding) => {
    const title = String(finding.title || finding.type || 'issue')
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const key = `${finding.type}|${title}`;
    const group = groups.get(key) || { severity: String(finding.severity || 'low').toLowerCase(), count: 0 };
    group.count += 1;
    groups.set(key, group);
  });

  if (groups.size === 0) return null;

  const effort = {
    critical: [6, 12],
    high: [4, 8],
    medium: [2, 4],
    low: [1, 2],
    info: [0.5, 1]
  };
  let hoursLow = 0;
  let hoursHigh = 0;
  groups.forEach((group) => {
    const [baseLow, baseHigh] = effort[group.severity] || effort.low;
    const repeatCount = Math.min(4, Math.max(0, group.count - 1));
    hoursLow += baseLow + repeatCount * 0.25;
    hoursHigh += baseHigh + repeatCount * 0.75;
  });

  const roundUp = (value) => Math.ceil(value / 250) * 250;
  const low = Math.max(500, roundUp(hoursLow * hourlyRate));
  const high = Math.max(low + 250, roundUp(hoursHigh * hourlyRate * 1.2));
  return {
    low,
    high,
    hoursLow: Math.ceil(hoursLow),
    hoursHigh: Math.ceil(hoursHigh),
    rootCauses: groups.size,
    hourlyRate,
    label: 'Preliminary implementation range; confirm platform access and scope before quoting'
  };
}

function gradeOutreachOpportunity(payload, findings, comparison = { priorAuditCount: 0, priorFindingFingerprints: [] }) {
  const screens = Number(payload && payload.screensExplored || 0);
  if (!payload || payload.inconclusive || payload.runStatus !== 'completed' || screens === 0) {
    return {
      grade: 'N/A',
      score: null,
      label: 'Audit inconclusive',
      basis: 'The audit did not complete with enough coverage to grade.',
      actionableFindings: 0,
      advisoryFindings: findings.length,
      shouldContact: false
    };
  }

  const actionable = findings.filter(isActionableFinding);
  const advisoryFindings = findings.length - actionable.length;
  const reproduced = actionable.filter((finding) => findingConfidence(finding, comparison) === 'reproduced');
  const needsVerification = actionable.filter((finding) => findingConfidence(finding, comparison) === 'needs-verification');
  const hasComparison = comparison.priorAuditCount > 0;
  const affectedScreens = new Set(actionable.map((finding) => finding.screen || finding.url || finding.target).filter(Boolean)).size;
  const severityScore = actionable.reduce((total, finding) => {
    const points = { critical: 25, high: 14, medium: 6, low: 2 };
    const basePoints = points[String(finding.severity || 'low').toLowerCase()] || 0;
    return total + (hasComparison && findingConfidence(finding, comparison) !== 'reproduced' ? basePoints * 0.35 : basePoints);
  }, 0);
  const reproducedScreens = new Set(reproduced.map((finding) => finding.screen || finding.url || finding.target).filter(Boolean)).size;
  const screenScore = hasComparison
    ? reproducedScreens * 4 + Math.max(0, affectedScreens - reproducedScreens)
    : affectedScreens * 4;
  const score = Math.min(100, Math.round(severityScore + Math.min(20, screenScore)));
  const comparisonBasis = hasComparison
    ? `${reproduced.length} reproduced issue(s); ${needsVerification.length} need verification against ${comparison.priorAuditCount} comparable prior audit(s).`
    : 'This run establishes the comparison baseline.';
  const basis = `${actionable.length} verified customer-path issue(s) across ${affectedScreens} screen(s); ${comparisonBasis} ${advisoryFindings} advisory finding(s) excluded from the grade.`;
  const details = {
    score,
    basis,
    actionableFindings: actionable.length,
    advisoryFindings,
    reproducedFindings: reproduced.length,
    needsVerificationFindings: needsVerification.length,
    priorAuditCount: comparison.priorAuditCount
  };

  if (score >= 55) return { grade: 'A', label: 'Priority lead', shouldContact: true, ...details };
  if (score >= 30) return { grade: 'B', label: 'Worth contacting', shouldContact: true, ...details };
  if (score >= 12) return { grade: 'C', label: 'Review first', shouldContact: false, ...details };
  return { grade: 'D', label: 'Do not contact', shouldContact: false, ...details };
}

function buildOutreachEmail({ companyName, companyUrl, domain, opportunity, bugsFound, priorityFindings, evidenceUrl, reportPdfUrl }) {
  if (!opportunity.shouldContact) {
    if (opportunity.grade === 'N/A') {
      return [
        'OUTREACH NOT READY — AUDIT INCONCLUSIVE',
        '',
        'The website could not be reviewed thoroughly enough to qualify this lead.',
        'Check the URL or access requirements, then run the audit again before deciding whether to contact the business.'
      ].join('\n');
    }

    return [
      `NO OUTREACH RECOMMENDED — GRADE ${opportunity.grade}`,
      '',
      'The review did not uncover enough verified, customer-facing opportunity to justify a personal sales email.',
      'Keep this business off the outreach list unless a manual review identifies a stronger reason to contact them.'
    ].join('\n');
  }

  const issueSummary = bugsFound === 1
    ? 'one customer-facing website issue'
    : `${bugsFound} customer-facing website issues`;
  const issueLines = priorityFindings.slice(0, 3).map((finding, index) =>
    `${index + 1}. ${String(finding.title || 'Customer-facing issue').replace(/\u001b\[[0-9;]*m/g, '')}`
  );

  return [
    'Subject: A quick greeting from a neighbor',
    '',
    `Hi ${companyName} team,`,
    '',
    'I’m [Your Name] from LIDI Solutions. We live and work nearby, and I wanted to reach out personally rather than send a generic website pitch.',
    '',
    `While looking through ${domain}, I found ${issueSummary} that may be making it harder for customers to navigate the site, find what they need, or take the next step. I recorded a short walkthrough and put the findings into a clear report so you can see exactly what I mean:`,
    ...(issueLines.length ? ['', ...issueLines] : []),
    '',
    `Website reviewed: ${companyUrl}`,
    `Visual walkthrough: ${evidenceUrl}`,
    `PDF bug report: ${reportPdfUrl}`,
    '',
    'I’d be happy to fix the priority items for $[X]. If you would rather talk it through first, I can also meet nearby for 15 minutes and show you what I found. No pressure either way.',
    '',
    'We care about the businesses that make the Seaport feel like a community, and I’d love to help make the online experience as strong as the one you provide in person.',
    '',
    'Best,',
    '[Your Name]',
    'LIDI Solutions',
    process.env.LIDI_WEBSITE_URL || '[LIDI Solutions website URL]'
  ].join('\n');
}

function summarizeFindings(payload, context = {}) {
  const rawFindings = Array.isArray(payload && payload.findings) ? payload.findings : [];
  const findings = sortFindingsByPriority([...new Map(rawFindings.map((finding) => [
    [finding.type, finding.title, finding.url, finding.target].filter(Boolean).join('|'),
    finding
  ])).values()]);
  const headline = payload && payload.headline ? payload.headline : 'Tapp exploration completed.';
  const comparison = {
    priorAuditCount: Number(context.priorAuditCount || 0),
    priorFindingFingerprints: Array.isArray(context.priorFindingFingerprints) ? context.priorFindingFingerprints : []
  };

  const media = getCaptureMedia(payload, findings);
  const mapped = findings.map((finding, index) => {
    const title = finding && finding.title ? finding.title.replace(/\u001b\[[0-9;]*m/g, '') : 'Potential issue';
    const severity = finding && finding.severity ? String(finding.severity).toUpperCase() : 'INFO';
    const confidence = findingConfidence(finding, comparison).replace('-', ' ').toUpperCase();
    const classification = isActionableFinding(finding) ? `${severity} · ${confidence}` : `${severity} · ADVISORY`;
    const location = finding && (finding.screen || finding.url || finding.target);
    const evidenceFrame = media.slides.findIndex((slide) => slide.issues.some((issue) => issue.number === index + 1));
    return [
      `#${index + 1} · ${classification} — ${title}`,
      `  Screen: ${location || 'Location unavailable'}`,
      `  Expected: ${describeExpectedBehavior(finding)}`,
      `  Observed: ${describeObservedBehavior(finding)}`,
      `  Evidence: ${evidenceFrame >= 0 ? `frame ${evidenceFrame + 1} of ${media.slides.length}` : 'No matching screenshot captured; verify manually.'}`
    ].join('\n');
  });

  const bugsFound = findings.length;
  const target = payload && payload.target ? payload.target : '';
  const domain = buildDomain(target || payload && payload.url || 'https://example.com');
  const opportunity = gradeOutreachOpportunity(payload, findings, comparison);
  const projectPrice = estimateProjectPrice(findings);
  const refinedFindings = findings.map((finding, index) => {
    const evidenceFrame = media.slides.findIndex((slide) => slide.issues.some((issue) => issue.number === index + 1));
    const severity = String(finding.severity || 'low').toLowerCase();
    return {
      number: index + 1,
      severity: ['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'low',
      actionable: isActionableFinding(finding),
      title: conciseFindingTitle(finding),
      screen: finding.screen || finding.url || finding.target || 'Location unavailable',
      expected: describeExpectedBehavior(finding),
      observed: conciseObservedBehavior(finding),
      evidenceFrame
    };
  });

  const report = [
    `TECHNICAL OPPORTUNITY GRADE: ${opportunity.grade} — ${opportunity.label}`,
    opportunity.score === null ? 'Opportunity score: unavailable' : `Opportunity score: ${opportunity.score}/100`,
    `Grade basis: ${opportunity.basis}`,
    'Grade scope: Technical fix opportunity only; it does not measure budget, purchase intent, or likelihood to reply.',
    '',
    `${headline}`,
    '',
    `Target: ${target || 'website URL'}`,
    `Domain: ${domain}`,
    `Screens explored: ${payload && payload.screensExplored ? payload.screensExplored : 0}`,
    `Actions performed: ${payload && payload.actionsPerformed ? payload.actionsPerformed : 0}`,
    `Deterministic findings: ${bugsFound}`,
    '',
    'Findings (priority order):'
  ];

  if (mapped.length > 0) {
    report.push(...mapped);
  } else {
    report.push('No deterministic issues were found in the exercised surfaces.');
  }

  report.push('', 'Preliminary project range:');
  if (projectPrice) {
    report.push(
      `$${projectPrice.low.toLocaleString()}–$${projectPrice.high.toLocaleString()} (${projectPrice.hoursLow}–${projectPrice.hoursHigh} estimated hours across ${projectPrice.rootCauses} unique fix categories)`,
      `Footnote: ${projectPrice.label}. Calculated at $${projectPrice.hourlyRate}/hour with contingency; set LIDI_HOURLY_RATE to change the internal rate.`
    );
  } else {
    report.push('Manual scoping required; no verified customer-path fixes were identified.');
  }

  if (payload && Array.isArray(payload.checkedFor) && payload.checkedFor.length) {
    report.push('', 'Checks performed:');
    payload.checkedFor.forEach((item) => report.push(`- ${item}`));
  }

  const companyName = context.companyName || companyNameFromDomain(domain);
  const companyUrl = context.companyUrl || target;
  const evidenceUrl = context.evidenceUrl || media.reportHtml || 'Evidence unavailable';
  const reportPdfUrl = context.reportPdfUrl || 'PDF unavailable';
  const email = buildOutreachEmail({
    companyName,
    companyUrl,
    domain,
    opportunity,
    bugsFound: opportunity.actionableFindings,
    priorityFindings: findings.filter(isActionableFinding),
    evidenceUrl,
    reportPdfUrl
  });

  return {
    report: report.join('\n'),
    email,
    domain,
    companyName,
    companyUrl,
    bugsFound,
    outreachGrade: opportunity.grade,
    outreachScore: opportunity.score,
    outreachLabel: opportunity.label,
    shouldContact: opportunity.shouldContact,
    gradeBasis: opportunity.basis,
    projectPrice,
    findingFingerprints: findings.map(findingFingerprint),
    reproduction: {
      reproduced: opportunity.reproducedFindings || 0,
      needsVerification: opportunity.needsVerificationFindings || 0,
      priorAudits: opportunity.priorAuditCount || 0
    },
    refinedReport: {
      summary: {
        companyName,
        companyUrl,
        verified: opportunity.actionableFindings,
        evidenceUrl
      },
      findings: refinedFindings
        .filter((finding) => finding.actionable)
        .map(({ actionable, ...finding }) => finding)
    },
    pagesScanned: payload && payload.coverage && payload.coverage.screensExplored ? payload.coverage.screensExplored : 0,
    elementsFound: payload && payload.complete && payload.complete.actions ? payload.complete.actions : 0,
    videoUrl: media.reportHtml,
    evidenceUrl,
    reportPdfUrl,
    slides: media.slides,
    raw: payload
  };
}

function createPdfReport(result, payload, filePath) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ margin: 48, size: 'LETTER' });
    const stream = fs.createWriteStream(filePath);
    document.pipe(stream);
    document.font('Helvetica-Bold').fontSize(20).text(`${result.companyName} Website Review`);
    document.moveDown(0.4).font('Helvetica').fontSize(10).text(result.companyUrl);
    document.moveDown().font('Helvetica').fontSize(10).text(
      `${result.refinedReport.summary.verified} customer-facing issue${result.refinedReport.summary.verified === 1 ? '' : 's'} documented with matching visual evidence.`
    );
    result.refinedReport.findings.forEach((finding) => {
      document.moveDown(0.8).font('Helvetica-Bold').fontSize(11).text(`#${finding.number} · ${finding.severity.toUpperCase()} — ${finding.title}`);
      document.moveDown(0.25).font('Helvetica').fontSize(9).text(`Location: ${finding.screen}`);
      document.text(`Expected: ${finding.expected}`);
      document.text(`Observed: ${finding.observed}`);
      document.text(`Evidence: ${finding.evidenceFrame >= 0 ? `frame ${finding.evidenceFrame + 1} of ${result.slides.length}` : 'Visual evidence unavailable'}`);
    });

    const customerFindingNumbers = new Set(result.refinedReport.findings.map((finding) => finding.number));
    result.slides.filter((slide) => slide.issues.some((issue) => customerFindingNumbers.has(issue.number))).slice(0, 6).forEach((slide) => {
      const capturePath = payload.capture && payload.capture.path;
      const imagePath = capturePath && path.join(capturePath, decodeURIComponent(path.basename(slide.src)));
      if (!imagePath || !fs.existsSync(imagePath)) return;
      document.addPage();
      document.font('Helvetica-Bold').fontSize(14).text(slide.screen);
      document.moveDown(0.4);
      slide.issues.filter((issue) => customerFindingNumbers.has(issue.number)).slice(0, 5)
        .forEach((issue) => document.font('Helvetica').fontSize(9).text(`${issue.severity}: ${issue.title}`));
      document.moveDown(0.6);
      document.image(imagePath, { fit: [516, 570], align: 'center', valign: 'top' });
    });

    document.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function analyzeWebsite(inputUrl, baseUrl, onProgress = () => {}, signal) {
  onProgress({ phase: 'exploring' });
  const payload = await runTappExplore(inputUrl, onProgress, signal);
  onProgress({
    phase: 'verifying',
    screens: Number(payload && payload.screensExplored || 0),
    actions: Number(payload && payload.actionsPerformed || 0)
  });
  const profile = await extractCompanyProfile(payload.target || inputUrl);
  const capturePath = payload.capture && payload.capture.path;
  const captureId = payload.capture && payload.capture.id
    ? payload.capture.id
    : capturePath
      ? path.basename(capturePath)
      : `audit-${Date.now()}`;
  const pdfFilename = `${slugifyCompanyName(profile.name)}_clien_report.pdf`;
  const reportDirectory = path.join(reportsDir, captureId);
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPdfUrl = `${baseUrl}/reports/${encodeURIComponent(captureId)}/${encodeURIComponent(pdfFilename)}`;
  const comparison = getComparisonContext(buildDomain(profile.url || payload.target || inputUrl));
  onProgress({ phase: 'building', screens: Number(payload && payload.screensExplored || 0), actions: Number(payload && payload.actionsPerformed || 0) });
  const media = getCaptureMedia(payload, Array.isArray(payload.findings) ? payload.findings : []);
  const evidenceUrl = media.reportHtml ? `${baseUrl}${media.reportHtml}` : `${baseUrl}`;
  const result = summarizeFindings(payload, {
    companyName: profile.name,
    companyUrl: profile.url,
    evidenceUrl,
    reportPdfUrl,
    ...comparison
  });
  onProgress({ phase: 'drafting', screens: Number(payload && payload.screensExplored || 0), actions: Number(payload && payload.actionsPerformed || 0) });
  await createPdfReport(result, payload, path.join(reportDirectory, pdfFilename));
  saveAuditLog(result, payload);
  return result;
}

async function executeAuditJob(job, baseUrl, onProgress = () => {}, signal) {
  const startedAt = job.startedAt || new Date().toISOString();
  try {
    const result = await analyzeWebsite(job.targetUrl, baseUrl, (progress) => {
      const status = ['exploring', 'checking'].includes(progress.phase) ? 'running' : 'processing';
      updateAuditJob(job.id, {
        status,
        phase: progress.phase,
        screens: Number(progress.screens || 0),
        actions: Number(progress.actions || 0),
        startedAt
      });
      onProgress({ ...progress, jobId: job.id });
    }, signal);
    const capture = result.raw && result.raw.capture;
    updateAuditJob(job.id, {
      status: 'complete',
      phase: 'complete',
      screens: Number(result.raw && result.raw.screensExplored || 0),
      actions: Number(result.raw && result.raw.actionsPerformed || 0),
      captureId: capture && (capture.id || capture.path && path.basename(capture.path)) || null,
      finishedAt: new Date().toISOString(),
      error: null
    });
    return result;
  } catch (error) {
    const canceled = error.name === 'AbortError' || signal && signal.aborted;
    updateAuditJob(job.id, {
      status: canceled ? 'canceled' : 'failed',
      phase: canceled ? 'canceled' : 'failed',
      finishedAt: new Date().toISOString(),
      error: canceled ? null : String(error.message || 'Audit failed.').slice(0, 1000)
    });
    throw error;
  }
}

app.get('/api/audits', (req, res) => {
  res.json(readAuditLog());
});

app.get('/api/audit-jobs', (req, res) => {
  res.json(readAuditJobs());
});

app.get('/api/audit-jobs/:id', (req, res) => {
  const job = readAuditJobs().jobs.find((candidate) => candidate.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Audit job not found.' });
  res.json(job);
});

app.post('/api/audit-jobs/:id/cancel', (req, res) => {
  const job = readAuditJobs().jobs.find((candidate) => candidate.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Audit job not found.' });
  if (!['queued', 'running', 'processing'].includes(job.status)) {
    return res.status(409).json({ error: 'This audit is no longer cancelable.' });
  }
  if (!cancelAuditJob(job.id)) return res.status(409).json({ error: 'This audit is no longer active.' });
  res.json({ ...job, status: 'canceled', phase: 'canceled' });
});

app.get('/api/leads', (req, res) => {
  res.json(readLeads());
});

app.post('/api/leads/extract', async (req, res) => {
  const urls = extractUrlsFromText(req.body && req.body.content);
  if (urls.length === 0) return res.status(400).json({ error: 'Add at least one website URL to extract leads.' });
  const leads = [];
  for (const url of urls) {
    const lead = await extractLeadProfile(url);
    if (lead) leads.push(lead);
  }
  res.json({ leads });
});

app.post('/api/leads/:id/enrich', async (req, res) => {
  const archive = readLeads();
  const lead = archive.leads.find((candidate) => candidate.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  const profile = await extractLeadProfile(lead.url);
  if (!profile) return res.status(422).json({ error: 'Company information could not be extracted.' });
  Object.assign(lead, profile, { id: lead.id, status: lead.status, createdAt: lead.createdAt, updatedAt: new Date().toISOString() });
  writeLeads(archive);
  res.json(lead);
});

app.post('/api/leads', (req, res) => {
  const candidates = Array.isArray(req.body && req.body.leads) ? req.body.leads : [];
  const archive = readLeads();
  const existingDomains = new Set(archive.leads.map((lead) => lead.domain));
  const created = [];
  candidates.forEach((candidate) => {
    const normalized = normalizeLeadInput(candidate);
    if (!normalized || existingDomains.has(normalized.domain)) return;
    const timestamp = new Date().toISOString();
    const lead = {
      id: crypto.randomUUID(),
      ...normalized,
      status: 'to-assess',
      createdAt: timestamp,
      updatedAt: timestamp
    };
    archive.leads.unshift(lead);
    existingDomains.add(lead.domain);
    created.push(lead);
  });
  writeLeads(archive);
  res.status(created.length > 0 ? 201 : 200).json({ archive, created: created.length });
});

app.patch('/api/leads/:id', (req, res) => {
  const archive = readLeads();
  const lead = archive.leads.find((candidate) => candidate.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found.' });
  const statuses = new Set(['to-assess', 'assessed', 'contacted', 'archived']);
  if (req.body && statuses.has(req.body.status)) lead.status = req.body.status;
  if (req.body && typeof req.body.name === 'string' && req.body.name.trim()) {
    lead.name = req.body.name.trim().slice(0, 100);
  }
  lead.updatedAt = new Date().toISOString();
  writeLeads(archive);
  res.json(lead);
});

app.delete('/api/leads/:id', (req, res) => {
  const archive = readLeads();
  const nextLeads = archive.leads.filter((candidate) => candidate.id !== req.params.id);
  if (nextLeads.length === archive.leads.length) return res.status(404).json({ error: 'Lead not found.' });
  archive.leads = nextLeads;
  writeLeads(archive);
  res.status(204).end();
});

app.get('/api/analyze/stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).end();
  const parsed = safeUrl(targetUrl);
  if (!parsed) return res.status(400).json({ error: 'Please enter a valid website URL.' });
  const job = createAuditJob(parsed.toString());
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('job', { jobId: job.id });
  try {
    const result = await enqueueAuditJob(
      job,
      `${req.protocol}://${req.get('host')}`,
      (progress) => send('progress', progress),
      (queued) => send('queued', queued)
    );
    send('result', { ...result, jobId: job.id });
  } catch (error) {
    console.error(error);
    send('audit-error', { error: error.message || 'Audit failed.' });
  } finally {
    res.end();
  }
});

app.get('/api/analyze', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing website URL.' });
  }

  const parsed = safeUrl(targetUrl);
  if (!parsed) return res.status(400).json({ error: 'Please enter a valid website URL.' });
  const job = createAuditJob(parsed.toString());
  try {
    const result = await enqueueAuditJob(job, `${req.protocol}://${req.get('host')}`);
    res.json({ ...result, jobId: job.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Audit failed.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Clien Tapp server running on http://localhost:${PORT}`);
  });
}

module.exports = {
  buildOutreachEmail,
  companyNameFromCandidates,
  createPdfReport,
  estimateProjectPrice,
  extractCompanyProfile,
  extractLeadProfile,
  extractUrlsFromText,
  getCaptureMedia,
  gradeOutreachOpportunity,
  findingFingerprint,
  findingConfidence,
  getComparisonContext,
  isActionableFinding,
  readAuditLog,
  readAuditJobs,
  readLeads,
  createAuditJob,
  updateAuditJob,
  recoverInterruptedAuditJobs,
  enqueueAuditJob,
  cancelAuditJob,
  saveAuditLog,
  slugifyCompanyName,
  describeExpectedBehavior,
  describeObservedBehavior,
  conciseFindingTitle,
  conciseObservedBehavior,
  sortFindingsByPriority,
  summarizeFindings
};
