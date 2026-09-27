const siteUrlInput = document.getElementById('siteUrl');
const crawlBtn = document.getElementById('crawlBtn');
const reportOutput = document.getElementById('reportOutput');
const reportViewControls = document.getElementById('reportViewControls');
const refinedReportButton = document.getElementById('refinedReportButton');
const rawReportButton = document.getElementById('rawReportButton');
const refinedReport = document.getElementById('refinedReport');
const emailOutput = document.getElementById('emailOutput');
const journeyVideo = document.getElementById('journeyVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const recordingIndicator = document.getElementById('recordingIndicator');
const statusNotice = document.getElementById('statusNotice');
const progressLabel = document.getElementById('progressLabel');
const cancelAuditButton = document.getElementById('cancelAuditButton');
const progressSteps = [...document.querySelectorAll('[data-progress-phase]')];
const progressCounts = document.getElementById('progressCounts');
const videoState = document.getElementById('videoState');
const reportState = document.getElementById('reportState');
const videoSection = document.getElementById('videoSection');
const reportSection = document.getElementById('reportSection');
const emailSection = document.getElementById('emailSection');
const slideshowControls = document.getElementById('slideshowControls');
const previousSlide = document.getElementById('previousSlide');
const nextSlide = document.getElementById('nextSlide');
const togglePlayback = document.getElementById('togglePlayback');
const slideCounter = document.getElementById('slideCounter');
const actionOverlay = document.getElementById('actionOverlay');
const actionText = document.getElementById('actionText');
const issueOverlay = document.getElementById('issueOverlay');
const issueScreen = document.getElementById('issueScreen');
const issueList = document.getElementById('issueList');
const playbackFilter = document.getElementById('playbackFilter');
const allFramesButton = document.getElementById('allFramesButton');
const issuesOnlyButton = document.getElementById('issuesOnlyButton');
const artifactLinks = document.getElementById('artifactLinks');
const evidenceLink = document.getElementById('evidenceLink');
const pdfLink = document.getElementById('pdfLink');
const auditLogButton = document.getElementById('auditLogButton');
const auditLogBackdrop = document.getElementById('auditLogBackdrop');
const auditLogPanel = document.getElementById('auditLogPanel');
const closeAuditLogButton = document.getElementById('closeAuditLog');
const auditLogStatus = document.getElementById('auditLogStatus');
const auditLogList = document.getElementById('auditLogList');
const leadsButton = document.getElementById('leadsButton');
const leadsPanel = document.getElementById('leadsPanel');
const closeLeadsButton = document.getElementById('closeLeads');
const leadExtractForm = document.getElementById('leadExtractForm');
const leadExtractInput = document.getElementById('leadExtractInput');
const leadExtractFiles = document.getElementById('leadExtractFiles');
const leadDrafts = document.getElementById('leadDrafts');
const leadDraftList = document.getElementById('leadDraftList');
const approveLeadDrafts = document.getElementById('approveLeadDrafts');
const leadSearch = document.getElementById('leadSearch');
const leadStatusFilter = document.getElementById('leadStatusFilter');
const selectVisibleLeads = document.getElementById('selectVisibleLeads');
const leadSelectionCount = document.getElementById('leadSelectionCount');
const assessSelectedLeads = document.getElementById('assessSelectedLeads');
const leadsStatus = document.getElementById('leadsStatus');
const leadsList = document.getElementById('leadsList');

let slideshowTimer = null;
let slideshowIndex = 0;
let slideshowSlides = [];
let slideshowPlaying = false;
let playbackMode = 'all';
let currentRefinedReport = null;
let currentReportMeta = null;
let currentLeads = [];
let activeAuditRequests = 0;
let activeAuditJobId = null;
let activeAuditUrl = null;
let canceledAuditUrl = null;
let extractedLeadDrafts = [];
const selectedLeadIds = new Set();
const pendingLeadIds = new Set();

const FRAME_DURATION = 520;
const ISSUE_FRAME_DURATION = 2800;
const PROGRESS_PHASES = ['exploring', 'checking', 'verifying', 'building', 'drafting'];

function setAuditProgress({ phase = 'exploring', screens, actions } = {}) {
  const phaseIndex = PROGRESS_PHASES.indexOf(phase);
  const activeIndex = phase === 'complete' ? PROGRESS_PHASES.length : Math.max(0, phaseIndex);
  statusNotice.classList.remove('is-message');
  statusNotice.hidden = false;
  progressLabel.textContent = 'Audit in progress';
  progressSteps.forEach((step, index) => {
    step.classList.toggle('is-complete', index < activeIndex);
    step.classList.toggle('is-active', index === activeIndex);
  });
  const counts = [];
  if (Number.isFinite(screens)) counts.push(`${screens} screens`);
  if (Number.isFinite(actions)) counts.push(`${actions} actions`);
  progressCounts.textContent = counts.join(' · ');
}

function updateCrawlButton() {
  if (activeAuditRequests > 0) {
    crawlBtn.textContent = 'Queue';
    return;
  }
  if (!canceledAuditUrl) {
    crawlBtn.textContent = 'Crawl';
    return;
  }
  crawlBtn.textContent = siteUrlInput.value.trim() === canceledAuditUrl ? 'Retry' : 'Crawl again';
}

function setReportView(view) {
  const showRefined = view === 'refined' && currentRefinedReport;
  refinedReport.hidden = !showRefined;
  reportOutput.hidden = Boolean(showRefined);
  refinedReportButton.setAttribute('aria-pressed', String(Boolean(showRefined)));
  rawReportButton.setAttribute('aria-pressed', String(!showRefined));
  if (!reportState.hidden && currentReportMeta) {
    reportState.textContent = showRefined
      ? `customer bug report · ${currentRefinedReport.summary.verified} verified issue${currentRefinedReport.summary.verified === 1 ? '' : 's'}`
      : `technical opportunity ${currentReportMeta.grade} · ${currentReportMeta.label}`;
  }
}

function appendSummaryMetric(container, label, value) {
  const metric = document.createElement('div');
  const metricValue = document.createElement('strong');
  const metricLabel = document.createElement('span');
  metricValue.textContent = String(value);
  metricLabel.textContent = label;
  metric.append(metricValue, metricLabel);
  container.appendChild(metric);
}

function renderRefinedReport(report) {
  refinedReport.textContent = '';
  if (!report || !report.summary) return;
  const summary = document.createElement('section');
  const heading = document.createElement('div');
  const eyebrow = document.createElement('span');
  const title = document.createElement('h2');
  const basis = document.createElement('p');
  summary.className = 'refined-summary';
  heading.className = 'refined-summary-heading';
  eyebrow.textContent = 'Website review';
  title.textContent = report.summary.companyName;
  basis.textContent = `${report.summary.verified} customer-facing issue${report.summary.verified === 1 ? '' : 's'} documented with matching visual evidence.`;
  heading.append(eyebrow, title);
  const website = document.createElement('a');
  website.className = 'refined-website';
  website.href = report.summary.companyUrl;
  website.target = '_blank';
  website.rel = 'noopener';
  website.textContent = report.summary.companyUrl;
  summary.append(heading, basis, website);
  refinedReport.appendChild(summary);

  const groups = [
    ['critical', 'Critical'],
    ['high', 'High priority'],
    ['medium', 'Medium priority'],
    ['low', 'Low priority']
  ];
  groups.forEach(([key, label]) => {
    const findings = report.findings.filter((finding) => finding.severity === key);
    if (!findings.length) return;
    const section = document.createElement('section');
    const groupHeading = document.createElement('h3');
    const list = document.createElement('div');
    section.className = 'refined-group';
    groupHeading.textContent = `${label} · ${findings.length}`;
    list.className = 'refined-findings';
    findings.forEach((finding) => {
      const item = document.createElement('button');
      const itemHeading = document.createElement('span');
      const itemTitle = document.createElement('strong');
      const screen = document.createElement('span');
      const expected = document.createElement('span');
      const observed = document.createElement('span');
      item.type = 'button';
      item.className = 'refined-finding';
      item.disabled = finding.evidenceFrame < 0;
      itemHeading.className = 'refined-finding-number';
      itemHeading.textContent = `#${finding.number} · ${finding.severity}`;
      itemTitle.textContent = finding.title;
      screen.className = 'refined-finding-screen';
      screen.textContent = finding.screen;
      expected.textContent = `Expected · ${finding.expected}`;
      observed.textContent = `Observed · ${finding.observed}`;
      item.append(itemHeading, itemTitle, screen, expected, observed);
      if (finding.evidenceFrame >= 0) {
        item.title = `Show evidence frame ${finding.evidenceFrame + 1}`;
        item.addEventListener('click', () => {
          stopSlideshow();
          setPlaybackMode('issues', finding.evidenceFrame);
          showSlide(finding.evidenceFrame);
          if (window.matchMedia('(max-width: 720px)').matches) videoSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
      list.appendChild(item);
    });
    section.append(groupHeading, list);
    refinedReport.appendChild(section);
  });
}

function createAuditLink(label, href) {
  const link = document.createElement('a');
  link.textContent = label;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

const LEAD_STATUS_LABELS = {
  'to-assess': 'To assess',
  assessed: 'Assessed',
  contacted: 'Contacted',
  archived: 'Archived'
};

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'The request failed.');
  }
  return response.status === 204 ? null : response.json();
}

function createDraftField(draft, label, key, multiline = false) {
  const wrapper = document.createElement('label');
  const caption = document.createElement('span');
  const control = document.createElement(multiline ? 'textarea' : 'input');
  wrapper.className = `lead-draft-field${multiline ? ' is-wide' : ''}`;
  caption.textContent = label;
  control.value = key === 'owners' ? (draft.owners || []).join(', ') : draft[key] || '';
  control.addEventListener('input', () => {
    draft[key] = key === 'owners' ? control.value.split(',').map((value) => value.trim()).filter(Boolean) : control.value;
  });
  wrapper.append(caption, control);
  return wrapper;
}

function renderLeadDrafts() {
  leadDraftList.textContent = '';
  leadDrafts.hidden = extractedLeadDrafts.length === 0;
  extractedLeadDrafts.forEach((draft, index) => {
    const card = document.createElement('article');
    const select = document.createElement('input');
    const fields = document.createElement('div');
    card.className = 'lead-draft';
    fields.className = 'lead-draft-fields';
    select.type = 'checkbox';
    select.checked = draft.selected !== false;
    select.setAttribute('aria-label', `Add ${draft.name || draft.domain}`);
    select.addEventListener('change', () => { extractedLeadDrafts[index].selected = select.checked; });
    fields.append(
      createDraftField(draft, 'Company', 'name'),
      createDraftField(draft, 'URL', 'url'),
      createDraftField(draft, 'Address', 'address'),
      createDraftField(draft, 'Owners / founders', 'owners'),
      createDraftField(draft, 'Industry', 'industry'),
      createDraftField(draft, 'Email', 'email'),
      createDraftField(draft, 'Phone', 'phone'),
      createDraftField(draft, 'Mission / summary', 'summary', true)
    );
    card.append(select, fields);
    leadDraftList.appendChild(card);
  });
}

function getVisibleLeads() {
  const query = leadSearch.value.trim().toLowerCase();
  const status = leadStatusFilter.value;
  return currentLeads.filter((lead) => {
    const matchesQuery = !query || `${lead.name} ${lead.domain}`.toLowerCase().includes(query);
    const matchesStatus = status === 'all' || status === 'active'
      ? status === 'all' || lead.status !== 'archived'
      : lead.status === status;
    return matchesQuery && matchesStatus;
  });
}

function updateBatchControls(visibleLeads = getVisibleLeads()) {
  const selectable = visibleLeads.filter((lead) => !pendingLeadIds.has(lead.id));
  const selectedVisible = selectable.filter((lead) => selectedLeadIds.has(lead.id));
  selectVisibleLeads.checked = selectable.length > 0 && selectedVisible.length === selectable.length;
  selectVisibleLeads.indeterminate = selectedVisible.length > 0 && selectedVisible.length < selectable.length;
  selectVisibleLeads.disabled = selectable.length === 0;
  leadSelectionCount.textContent = `${selectedLeadIds.size} selected`;
  assessSelectedLeads.disabled = selectedLeadIds.size === 0;
}

function populateLeadProfile(container, lead) {
  container.textContent = '';
  const workflow = document.createElement('div');
  const workflowLabel = document.createElement('strong');
  const workflowOptions = document.createElement('div');
  workflow.className = 'lead-profile-workflow';
  workflowLabel.textContent = 'Status';
  workflowOptions.className = 'lead-profile-statuses';
  Object.entries(LEAD_STATUS_LABELS).forEach(([value, label]) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.textContent = label;
    option.setAttribute('aria-pressed', String(lead.status === value));
    option.addEventListener('click', async () => {
      if (value === lead.status) return;
      try {
        await updateLead(lead.id, { status: value });
      } catch (error) {
        leadsStatus.hidden = false;
        leadsStatus.textContent = error.message;
      }
    });
    workflowOptions.appendChild(option);
  });
  workflow.append(workflowLabel, workflowOptions);
  container.appendChild(workflow);
  const profileValues = [
    ['Address', lead.address],
    ['Owners / founders', Array.isArray(lead.owners) ? lead.owners.join(', ') : ''],
    ['Industry', lead.industry],
    ['Mission / summary', lead.summary],
    ['Email', lead.email],
    ['Phone', lead.phone]
  ].filter(([, value]) => value);
  if (profileValues.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No organization details found on the public website.';
    container.appendChild(empty);
  } else {
    profileValues.forEach(([label, value]) => {
      const item = document.createElement('div');
      const term = document.createElement('strong');
      const detail = document.createElement('span');
      term.textContent = label;
      detail.textContent = value;
      item.append(term, detail);
      container.appendChild(item);
    });
  }
  if (Array.isArray(lead.sourceUrls) && lead.sourceUrls.length > 0) {
    const sources = document.createElement('div');
    const term = document.createElement('strong');
    term.textContent = 'Sources';
    sources.appendChild(term);
    lead.sourceUrls.forEach((sourceUrl) => {
      const source = document.createElement('a');
      source.href = sourceUrl;
      source.target = '_blank';
      source.rel = 'noopener';
      source.textContent = sourceUrl;
      sources.appendChild(source);
    });
    container.appendChild(sources);
  }
}

function renderLeads() {
  const visibleLeads = getVisibleLeads();
  const queuedLeads = currentLeads.filter((lead) => pendingLeadIds.has(lead.id));
  const availableLeads = visibleLeads.filter((lead) => !pendingLeadIds.has(lead.id));
  leadsList.textContent = '';
  leadsStatus.hidden = queuedLeads.length > 0 || availableLeads.length > 0;
  leadsStatus.textContent = currentLeads.length === 0 ? 'No leads yet.' : 'No leads match this view.';

  const appendHeading = (label, count) => {
    const heading = document.createElement('div');
    heading.className = 'lead-list-heading';
    heading.innerHTML = `<span>${label}</span><span>${count}</span>`;
    leadsList.appendChild(heading);
  };

  const appendLead = (lead) => {
    const row = document.createElement('article');
    const identity = document.createElement('div');
    const name = document.createElement('strong');
    const domain = document.createElement('a');
    const controls = document.createElement('div');
    const profileButton = document.createElement('button');
    const assess = document.createElement('button');
    const remove = document.createElement('button');
    const selection = document.createElement('input');
    const profile = document.createElement('div');
    row.className = 'lead-row';
    identity.className = 'lead-identity';
    controls.className = 'lead-controls';
    profileButton.className = 'lead-info-button';
    profile.className = 'lead-profile';
    profile.hidden = true;
    selection.className = 'lead-selection';
    selection.type = 'checkbox';
    selection.checked = selectedLeadIds.has(lead.id);
    selection.disabled = pendingLeadIds.has(lead.id);
    selection.setAttribute('aria-label', `Select ${lead.name}`);
    selection.addEventListener('change', () => {
      if (selection.checked) selectedLeadIds.add(lead.id);
      else selectedLeadIds.delete(lead.id);
      updateBatchControls(visibleLeads);
    });
    name.textContent = lead.name;
    domain.textContent = lead.domain;
    domain.href = lead.url;
    domain.target = '_blank';
    domain.rel = 'noopener';
    profileButton.type = 'button';
    profileButton.textContent = 'Company info';
    profileButton.setAttribute('aria-expanded', 'false');
    profileButton.setAttribute('aria-controls', `lead-profile-${lead.id}`);
    profile.id = `lead-profile-${lead.id}`;
    profileButton.addEventListener('click', async () => {
      if (!profile.hidden) {
        profile.hidden = true;
        profileButton.setAttribute('aria-expanded', 'false');
        return;
      }
      profile.hidden = false;
      profileButton.setAttribute('aria-expanded', 'true');
      if (![lead.address, lead.summary, lead.industry, lead.email, lead.phone, ...(lead.owners || [])].some(Boolean)) {
        profile.textContent = 'Researching public company information...';
        try {
          const enriched = await requestJson(`/api/leads/${encodeURIComponent(lead.id)}/enrich`, { method: 'POST' });
          Object.assign(lead, enriched);
          currentLeads = currentLeads.map((candidate) => candidate.id === lead.id ? enriched : candidate);
        } catch (error) {
          profile.textContent = error.message;
          return;
        }
      }
      populateLeadProfile(profile, lead);
    });

    populateLeadProfile(profile, lead);
    assess.type = 'button';
    assess.className = 'lead-assess';
    assess.textContent = pendingLeadIds.has(lead.id) ? 'Queued' : 'Assess';
    assess.disabled = pendingLeadIds.has(lead.id);
    assess.addEventListener('click', () => {
      siteUrlInput.value = lead.url;
      closeLeads();
      runAudit({ url: lead.url, leadId: lead.id });
    });
    remove.type = 'button';
    remove.className = 'lead-remove';
    remove.textContent = '×';
    remove.title = `Delete ${lead.name}`;
    remove.setAttribute('aria-label', `Delete ${lead.name}`);
    remove.addEventListener('click', async () => {
      try {
        await requestJson(`/api/leads/${encodeURIComponent(lead.id)}`, { method: 'DELETE' });
        currentLeads = currentLeads.filter((candidate) => candidate.id !== lead.id);
        renderLeads();
      } catch (error) {
        leadsStatus.hidden = false;
        leadsStatus.textContent = error.message;
      }
    });
    identity.append(name, domain);
    controls.append(profileButton, assess, remove);
    row.append(selection, identity, controls);
    row.appendChild(profile);
    leadsList.appendChild(row);
  };

  if (queuedLeads.length > 0) {
    appendHeading('Queued', queuedLeads.length);
    queuedLeads.forEach(appendLead);
  }
  appendHeading('All', availableLeads.length);
  availableLeads.forEach(appendLead);
  updateBatchControls(visibleLeads);
}

async function updateLead(id, changes) {
  const updated = await requestJson(`/api/leads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(changes)
  });
  currentLeads = currentLeads.map((lead) => lead.id === id ? updated : lead);
  renderLeads();
  return updated;
}

async function loadLeads() {
  leadsStatus.hidden = false;
  leadsStatus.textContent = 'Loading leads...';
  try {
    const archive = await requestJson('/api/leads');
    currentLeads = archive.leads || [];
    renderLeads();
  } catch (error) {
    leadsStatus.textContent = error.message;
  }
}

function openLeads() {
  if (!auditLogPanel.hidden) closeAuditLog(false);
  auditLogBackdrop.hidden = false;
  leadsPanel.hidden = false;
  leadsButton.setAttribute('aria-expanded', 'true');
  document.body.classList.add('audit-log-open');
  closeLeadsButton.focus();
  loadLeads();
}

function closeLeads(restoreFocus = true) {
  leadsPanel.hidden = true;
  auditLogBackdrop.hidden = true;
  leadsButton.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('audit-log-open');
  if (restoreFocus) leadsButton.focus();
}

function renderAuditLog(archive) {
  auditLogList.textContent = '';
  const companies = Object.entries(archive && archive.companies || {})
    .sort(([, left], [, right]) => {
      const leftDate = left.audits && left.audits[0] ? left.audits[0].capturedAt : '';
      const rightDate = right.audits && right.audits[0] ? right.audits[0].capturedAt : '';
      return rightDate.localeCompare(leftDate);
    });
  auditLogStatus.hidden = companies.length > 0;
  auditLogStatus.textContent = companies.length > 0 ? '' : 'No completed audits yet.';

  companies.forEach(([domain, company]) => {
    const section = document.createElement('section');
    section.className = 'audit-company';
    const heading = document.createElement('h3');
    const website = document.createElement('a');
    const audits = document.createElement('div');
    heading.textContent = company.name;
    website.textContent = domain;
    website.href = company.url;
    website.target = '_blank';
    website.rel = 'noopener';
    audits.className = 'audit-runs';

    (company.audits || []).forEach((entry) => {
      const run = document.createElement('article');
      const summary = document.createElement('div');
      const date = document.createElement('time');
      const metrics = document.createElement('span');
      const links = document.createElement('div');
      run.className = 'audit-run';
      summary.className = 'audit-run-summary';
      links.className = 'audit-run-links';
      date.dateTime = entry.capturedAt;
      date.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.capturedAt));
      const reproduction = entry.audit.reproduction;
      const repeatSummary = reproduction && reproduction.priorAudits > 0 ? ` · ${reproduction.reproduced} reproduced` : '';
      metrics.textContent = `Grade ${entry.audit.grade} · ${entry.audit.findings} findings · ${entry.evidence.frames} frames${repeatSummary}`;
      summary.append(date, metrics);
      if (entry.evidence && entry.evidence.url) links.appendChild(createAuditLink('Evidence', entry.evidence.url));
      if (entry.report && entry.report.pdfUrl) links.appendChild(createAuditLink('PDF', entry.report.pdfUrl));
      run.append(summary, links);
      audits.appendChild(run);
    });

    section.append(heading, website, audits);
    auditLogList.appendChild(section);
  });
}

async function openAuditLog() {
  if (!leadsPanel.hidden) closeLeads(false);
  auditLogBackdrop.hidden = false;
  auditLogPanel.hidden = false;
  auditLogButton.setAttribute('aria-expanded', 'true');
  document.body.classList.add('audit-log-open');
  closeAuditLogButton.focus();
  auditLogStatus.hidden = false;
  auditLogStatus.textContent = 'Loading audits...';
  auditLogList.textContent = '';
  try {
    const response = await fetch('/api/audits');
    if (!response.ok) throw new Error('Could not load the archive.');
    renderAuditLog(await response.json());
  } catch (error) {
    auditLogStatus.textContent = error.message;
  }
}

function closeAuditLog(restoreFocus = true) {
  auditLogBackdrop.hidden = true;
  auditLogPanel.hidden = true;
  auditLogButton.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('audit-log-open');
  if (restoreFocus) auditLogButton.focus();
}

function setRecordingState(isRecording) {
  recordingIndicator.hidden = !isRecording;
  statusNotice.hidden = !isRecording;
}

function setSectionState(isVideoComplete, isReportComplete) {
  videoState.hidden = !isVideoComplete;
  reportState.hidden = !isReportComplete;

  if (isVideoComplete) {
    videoState.textContent = 'journey complete';
  }

  if (isReportComplete) {
    reportState.textContent = 'report complete';
  }
}

function setStatusText(message) {
  statusNotice.hidden = false;
  statusNotice.classList.add('is-message');
  progressLabel.textContent = message;
}

function stopSlideshow() {
  if (slideshowTimer) {
    clearTimeout(slideshowTimer);
    slideshowTimer = null;
  }
  slideshowPlaying = false;
  togglePlayback.textContent = '▶';
  togglePlayback.setAttribute('aria-label', 'Play capture sequence');
}

function scheduleNextSlide() {
  if (!slideshowPlaying || slideshowSlides.length === 0) return;
  const slide = slideshowSlides[slideshowIndex];
  const hasIssues = typeof slide !== 'string' && Array.isArray(slide.issues) && slide.issues.length > 0;
  slideshowTimer = setTimeout(() => {
    stepSlide(1);
    scheduleNextSlide();
  }, hasIssues ? ISSUE_FRAME_DURATION : FRAME_DURATION);
}

function getPlaybackIndices() {
  const indices = slideshowSlides.map((slide, index) => ({ slide, index }))
    .filter(({ slide }) => playbackMode === 'all' || typeof slide !== 'string' && Array.isArray(slide.issues) && slide.issues.length > 0)
    .map(({ index }) => index);
  return indices.length > 0 ? indices : slideshowSlides.map((slide, index) => index);
}

function stepSlide(direction) {
  const indices = getPlaybackIndices();
  if (indices.length === 0) return;
  const currentPosition = indices.indexOf(slideshowIndex);
  const nextPosition = currentPosition < 0
    ? 0
    : (currentPosition + direction + indices.length) % indices.length;
  showSlide(indices[nextPosition]);
}

function setPlaybackMode(mode, preferredIndex = null) {
  const hasIssueFrames = slideshowSlides.some((slide) => typeof slide !== 'string' && Array.isArray(slide.issues) && slide.issues.length > 0);
  playbackMode = mode === 'issues' && hasIssueFrames ? 'issues' : 'all';
  allFramesButton.setAttribute('aria-pressed', String(playbackMode === 'all'));
  issuesOnlyButton.setAttribute('aria-pressed', String(playbackMode === 'issues'));
  issuesOnlyButton.disabled = !hasIssueFrames;
  if (slideshowSlides.length === 0) return;
  const indices = getPlaybackIndices();
  const nextIndex = preferredIndex !== null && indices.includes(preferredIndex)
    ? preferredIndex
    : indices.includes(slideshowIndex) ? slideshowIndex : indices[0];
  showSlide(nextIndex);
}

function playSlideshow() {
  if (slideshowSlides.length === 0) return;
  slideshowPlaying = true;
  togglePlayback.textContent = 'Ⅱ';
  togglePlayback.setAttribute('aria-label', 'Pause capture sequence');
  scheduleNextSlide();
}

function startSlideshow(slides) {
  stopSlideshow();
  if (!Array.isArray(slides) || slides.length === 0) {
    return;
  }

  slideshowSlides = slides;
  slides.forEach((slide) => {
    const image = new Image();
    image.src = typeof slide === 'string' ? slide : slide.src;
  });
  slideshowIndex = 0;
  playbackFilter.hidden = false;
  setPlaybackMode('all', 0);
  showSlide(0);
  slideshowControls.hidden = false;
  playSlideshow();
}

function showSlide(index) {
  if (slideshowSlides.length === 0) return;
  slideshowIndex = (index + slideshowSlides.length) % slideshowSlides.length;
  const slide = slideshowSlides[slideshowIndex];
  const source = typeof slide === 'string' ? slide : slide.src;
  const issues = typeof slide === 'string' || !Array.isArray(slide.issues) ? [] : slide.issues;
  journeyVideo.src = source;
  journeyVideo.style.display = 'block';
  journeyVideo.alt = `${slide.screen || 'Website'} capture ${slideshowIndex + 1} of ${slideshowSlides.length}`;
  const playbackIndices = getPlaybackIndices();
  const playbackPosition = playbackIndices.indexOf(slideshowIndex) + 1;
  slideCounter.textContent = playbackMode === 'issues'
    ? `${playbackPosition} / ${playbackIndices.length} issues`
    : `${slideshowIndex + 1} / ${slideshowSlides.length}`;
  actionText.textContent = slide.action || `Opened ${slide.screen || 'website screen'}`;
  actionOverlay.hidden = false;
  issueScreen.textContent = slide.screen || `Screen ${slideshowIndex + 1}`;
  issueList.textContent = '';
  issues.slice(0, 3).forEach((issue) => {
    const item = document.createElement('div');
    item.className = 'issue-item';
    const heading = document.createElement('strong');
    const title = document.createElement('span');
    const expected = document.createElement('small');
    const observed = document.createElement('small');
    heading.textContent = `#${issue.number} · ${issue.severity}`;
    title.textContent = issue.title;
    expected.textContent = `Expected: ${issue.expected}`;
    observed.textContent = `Observed: ${issue.observed}`;
    item.append(heading, title, expected, observed);
    issueList.appendChild(item);
  });
  issueOverlay.hidden = issues.length === 0;
  videoPlaceholder.style.display = 'none';
}

function renderAudit(result) {
  reportOutput.textContent = result.report || 'No audit report generated.';
  currentRefinedReport = result.refinedReport || null;
  currentReportMeta = { grade: result.outreachGrade, label: result.outreachLabel };
  renderRefinedReport(currentRefinedReport);
  reportViewControls.hidden = !currentRefinedReport;
  setReportView('raw');
  emailOutput.textContent = result.email || 'Hi,\n\nI reviewed the site and found a few issues worth fixing.\nBest,\n[Your Name]';
  setRecordingState(false);
  statusNotice.hidden = true;

  const slides = Array.isArray(result.slides) ? result.slides.filter(Boolean) : [];
  const hasVideo = slides.length > 0;
  const hasReport = Boolean(
    result.report &&
      result.report !== 'No audit report generated.' &&
      result.report !== 'No bugs reported yet.'
  );

  stopSlideshow();
  slideshowSlides = [];
  slideshowControls.hidden = true;
  playbackFilter.hidden = true;
  issueOverlay.hidden = true;
  actionOverlay.hidden = true;
  artifactLinks.hidden = true;

  if (result.evidenceUrl) {
    evidenceLink.href = result.evidenceUrl;
    artifactLinks.hidden = false;
  }
  if (result.reportPdfUrl) {
    pdfLink.href = result.reportPdfUrl;
    artifactLinks.hidden = false;
  }
  evidenceLink.hidden = !result.evidenceUrl;
  pdfLink.hidden = !result.reportPdfUrl;

  if (hasVideo) {
    startSlideshow(slides);
  } else {
    journeyVideo.removeAttribute('src');
    journeyVideo.style.display = 'none';
    videoPlaceholder.style.display = 'flex';
    videoPlaceholder.textContent = result.report ? 'No journey captures available' : '';
  }

  setSectionState(hasVideo, hasReport);

  if (hasReport && result.outreachGrade) {
    reportState.textContent = `technical opportunity ${result.outreachGrade} · ${result.outreachLabel}`;
    reportState.dataset.grade = result.outreachGrade;
  } else {
    delete reportState.dataset.grade;
  }
}

function scrollToStage(stage) {
  stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function streamAudit(url, handlers = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ url });
    const source = new EventSource(`/api/analyze/stream?${params.toString()}`);
    let settled = false;
    let progressCancelled = false;
    let progressQueue = Promise.resolve();
    const queueProgress = (progress, duration = 450) => {
      progressQueue = progressQueue.then(() => new Promise((done) => {
        if (!progressCancelled) setAuditProgress(progress);
        setTimeout(done, duration);
      }));
      return progressQueue;
    };
    source.addEventListener('job', (event) => handlers.onJob && handlers.onJob(JSON.parse(event.data)));
    source.addEventListener('queued', (event) => handlers.onQueued && handlers.onQueued(JSON.parse(event.data)));
    source.addEventListener('progress', (event) => {
      const progress = JSON.parse(event.data);
      if (handlers.onProgress) handlers.onProgress(progress);
      queueProgress(progress);
    });
    source.addEventListener('result', async (event) => {
      settled = true;
      source.close();
      await progressQueue;
      await queueProgress({ phase: 'complete' }, 300);
      resolve(JSON.parse(event.data));
    });
    source.addEventListener('audit-error', (event) => {
      settled = true;
      progressCancelled = true;
      source.close();
      reject(new Error(JSON.parse(event.data).error || 'Audit failed.'));
    });
    source.onerror = () => {
      if (settled) return;
      settled = true;
      progressCancelled = true;
      source.close();
      reject(new Error('The audit connection was interrupted.'));
    };
  });
}

async function runAudit({ url: submittedUrl, leadId = null } = {}) {
  const url = (submittedUrl || siteUrlInput.value).trim();
  if (!url) {
    reportOutput.textContent = 'Please enter a valid website URL.';
    return;
  }

  const isFirstRequest = activeAuditRequests === 0;
  activeAuditRequests += 1;
  if (leadId) {
    selectedLeadIds.delete(leadId);
    pendingLeadIds.add(leadId);
    renderLeads();
  }
  updateCrawlButton();
  setRecordingState(true);
  if (isFirstRequest) {
    setAuditProgress({ phase: 'exploring' });
    currentRefinedReport = null;
    currentReportMeta = null;
    refinedReport.textContent = '';
    reportViewControls.hidden = true;
    setReportView('raw');
    reportOutput.textContent = '> Starting crawl\n> Recording browser journey\n> Capturing console and request issues';
    emailOutput.textContent = 'Drafting Email...';
    videoPlaceholder.innerHTML = '<span class="play-button" aria-hidden="true">▶</span>';
    videoPlaceholder.style.display = 'flex';
    journeyVideo.style.display = 'none';
    setSectionState(false, false);
  }

  let jobId = null;
  try {
    const data = await streamAudit(url, {
      onJob: (job) => { jobId = job.jobId; },
      onQueued: ({ position }) => {
        if (position > 1 || !isFirstRequest) {
          setStatusText(`Audit queued · ${position} waiting`);
        }
      },
      onProgress: (progress) => {
        activeAuditJobId = progress.jobId || jobId;
        activeAuditUrl = url;
        cancelAuditButton.hidden = !activeAuditJobId;
      }
    });

    renderAudit(data);
    if (leadId) {
      await updateLead(leadId, { status: 'assessed' }).catch(() => {});
    }

    requestAnimationFrame(() => scrollToStage(reportSection));
  } catch (error) {
    const canceled = error.message === 'Audit canceled.';
    if (canceled) {
      canceledAuditUrl = url;
      siteUrlInput.value = url;
    }
    reportOutput.textContent = canceled ? '> Audit canceled\n> Ready to retry' : `> Audit failed\n> ${error.message}`;
    emailOutput.textContent = 'No draft available.';
    videoPlaceholder.innerHTML = '<span class="play-button" aria-hidden="true">▶</span>';
    setRecordingState(false);
    setSectionState(false, false);
    setStatusText(canceled ? 'Audit canceled' : 'Audit failed');
  } finally {
    activeAuditRequests -= 1;
    if (activeAuditJobId === jobId) {
      activeAuditJobId = null;
      activeAuditUrl = null;
      cancelAuditButton.hidden = true;
    }
    if (leadId) {
      pendingLeadIds.delete(leadId);
      renderLeads();
    }
    updateCrawlButton();
    setRecordingState(activeAuditRequests > 0);
  }
}

crawlBtn.addEventListener('click', () => runAudit());
cancelAuditButton.addEventListener('click', async () => {
  if (!activeAuditJobId) return;
  cancelAuditButton.disabled = true;
  try {
    await requestJson(`/api/audit-jobs/${encodeURIComponent(activeAuditJobId)}/cancel`, { method: 'POST' });
    if (activeAuditUrl) siteUrlInput.value = activeAuditUrl;
  } catch (error) {
    setStatusText(error.message);
  } finally {
    cancelAuditButton.disabled = false;
  }
});
siteUrlInput.addEventListener('input', updateCrawlButton);
siteUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runAudit();
});
previousSlide.addEventListener('click', () => {
  stopSlideshow();
  stepSlide(-1);
});
nextSlide.addEventListener('click', () => {
  stopSlideshow();
  stepSlide(1);
});
togglePlayback.addEventListener('click', () => {
  if (slideshowPlaying) {
    stopSlideshow();
  } else {
    playSlideshow();
  }
});
refinedReportButton.addEventListener('click', () => setReportView('refined'));
rawReportButton.addEventListener('click', () => setReportView('raw'));
allFramesButton.addEventListener('click', () => setPlaybackMode('all'));
issuesOnlyButton.addEventListener('click', () => setPlaybackMode('issues'));
auditLogButton.addEventListener('click', openAuditLog);
closeAuditLogButton.addEventListener('click', closeAuditLog);
leadsButton.addEventListener('click', openLeads);
closeLeadsButton.addEventListener('click', closeLeads);
leadSearch.addEventListener('input', renderLeads);
leadStatusFilter.addEventListener('change', renderLeads);
selectVisibleLeads.addEventListener('change', () => {
  getVisibleLeads().forEach((lead) => {
    if (pendingLeadIds.has(lead.id)) return;
    if (selectVisibleLeads.checked) selectedLeadIds.add(lead.id);
    else selectedLeadIds.delete(lead.id);
  });
  renderLeads();
});
assessSelectedLeads.addEventListener('click', () => {
  const leads = currentLeads.filter((lead) => selectedLeadIds.has(lead.id) && !pendingLeadIds.has(lead.id));
  selectedLeadIds.clear();
  closeLeads();
  leads.forEach((lead) => void runAudit({ url: lead.url, leadId: lead.id }));
});
leadExtractFiles.addEventListener('change', async () => {
  const contents = await Promise.all([...leadExtractFiles.files].map((file) => file.text()));
  leadExtractInput.value = [leadExtractInput.value, ...contents].filter(Boolean).join('\n');
});
leadExtractForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = leadExtractInput.value.trim();
  if (!content) return;
  leadsStatus.hidden = false;
  leadsStatus.textContent = 'Extracting public company details...';
  try {
    const result = await requestJson('/api/leads/extract', {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    extractedLeadDrafts = result.leads.map((lead) => ({ ...lead, selected: true }));
    renderLeadDrafts();
    leadsStatus.textContent = `${extractedLeadDrafts.length} draft${extractedLeadDrafts.length === 1 ? '' : 's'} ready for review.`;
  } catch (error) {
    leadsStatus.textContent = error.message;
  }
});
approveLeadDrafts.addEventListener('click', async () => {
  const leads = extractedLeadDrafts.filter((lead) => lead.selected);
  if (leads.length === 0) return;
  try {
    const result = await requestJson('/api/leads', {
      method: 'POST',
      body: JSON.stringify({ leads })
    });
    currentLeads = result.archive.leads;
    extractedLeadDrafts = [];
    leadExtractInput.value = '';
    leadExtractFiles.value = '';
    renderLeadDrafts();
    renderLeads();
    leadsStatus.hidden = false;
    leadsStatus.textContent = result.created > 0 ? `${result.created} lead${result.created === 1 ? '' : 's'} added.` : 'No new leads added.';
  } catch (error) {
    leadsStatus.hidden = false;
    leadsStatus.textContent = error.message;
  }
});
auditLogBackdrop.addEventListener('click', () => {
  if (!leadsPanel.hidden) closeLeads();
  else closeAuditLog();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!leadsPanel.hidden) closeLeads();
  else if (!auditLogPanel.hidden) closeAuditLog();
});
journeyVideo.addEventListener('error', () => {
  stopSlideshow();
  journeyVideo.removeAttribute('src');
  journeyVideo.style.display = 'none';
  slideshowControls.hidden = true;
  issueOverlay.hidden = true;
  actionOverlay.hidden = true;
  videoPlaceholder.textContent = 'Capture unavailable';
  videoPlaceholder.style.display = 'flex';
  setSectionState(false, !reportState.hidden);
});

statusNotice.hidden = true;
setRecordingState(false);
setSectionState(false, false);
renderAudit({
  report: 'No bugs reported yet.',
  email: 'Run a crawl to qualify the lead and draft a personal outreach email.'
});
