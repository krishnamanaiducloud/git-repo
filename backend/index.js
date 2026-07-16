// backend/index.js
const express = require('express');
const axios = require('axios');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { randomBytes, randomUUID } = require('crypto');
require('dotenv').config();

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);

function normalizeBasePath(value = '/') {
  const candidate = `/${String(value).trim()}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  const segments = candidate.split('/').filter(Boolean);
  if (
    !/^\/[A-Za-z0-9/_-]*$/.test(candidate) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('BASE_PATH may contain only URL path letters, numbers, underscores, and hyphens');
  }
  return candidate;
}

// -------------------------
// Dynamic base path for OpenShift Route / Istio VirtualService
// Set BASE_PATH=/git-repo when serving under a sub-path.
// -------------------------
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH || '/');
let isReady = false;
let configurationReady = false;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  const styleNonce = randomBytes(18).toString('base64');
  res.locals.styleNonce = styleNonce;
  const suppliedRequestId = req.get('x-request-id');
  const requestId = suppliedRequestId && /^[A-Za-z0-9._:-]{1,100}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : randomUUID();
  const startedAt = Date.now();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    `script-src 'self' 'nonce-${styleNonce}'`,
    `style-src 'self' 'nonce-${styleNonce}'`
  ].join('; '));
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.on('finish', () => {
    console.log(JSON.stringify({
      level: 'info',
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    }));
  });
  next();
});

app.use((req, res, next) => {
  if (req.method === 'TRACE' || req.method === 'CONNECT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  next();
});

// -------------------------
// Health probes — root level, always reachable by k8s/OpenShift
// -------------------------
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

app.get('/readyz', (req, res) => {
  const ready = isReady && configurationReady;
  res.status(ready ? 200 : 503).send(ready ? 'ok' : 'not ready');
});

// -------------------------
// Application router (mounted at BASE_PATH for path-based routing)
// -------------------------
const router = express.Router();

router.use(express.json({ limit: '32kb', type: 'application/json' }));

router.use(
  express.static(path.join(__dirname, 'public/browser'), {
    index: false,
    setHeaders: (res, filePath) => {
      const fileName = path.basename(filePath);
      res.setHeader(
        'Cache-Control',
        fileName === 'index.html'
          ? 'no-store'
          : /-[A-Z0-9]{8,}\./i.test(fileName)
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=3600'
      );
    }
  })
);

const spaIndexPath = path.join(__dirname, 'public/browser', 'index.html');

function applyCspNonce(html, nonce) {
  if (!html.includes('__CSP_NONCE__')) {
    throw new Error('SPA index is missing its CSP nonce placeholder');
  }
  return html.replaceAll('__CSP_NONCE__', nonce);
}

async function sendSpaIndex(req, res, next) {
  try {
    const html = await fs.readFile(spaIndexPath, 'utf8');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(applyCspNonce(html, res.locals.styleNonce));
  } catch (error) {
    next(error);
  }
}

router.get('/', sendSpaIndex);

// -------------------------
// GitLab configuration
// -------------------------
const GITLAB_API_URL =
  process.env.GITLAB_API_URL || 'https://gitlab.example.com/api/v4';
const GITLAB_WEB_URL = process.env.GITLAB_WEB_URL || new URL(GITLAB_API_URL).origin;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const TEMPLATE_REPO_PREFIX =
  process.env.TEMPLATE_REPO_PREFIX ||
  'https://gitlab.centene.com/embark/templates-projects/';

axios.defaults.timeout = Number.parseInt(process.env.GITLAB_TIMEOUT_MS || '30000', 10);
axios.defaults.maxContentLength = 10 * 1024 * 1024;
axios.defaults.maxBodyLength = 10 * 1024 * 1024;

if (!GITLAB_TOKEN) {
  console.warn(
    '⚠️  GITLAB_TOKEN is not set. GitLab API calls will fail until this is configured.'
  );
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    console.warn(`⚠️  ${name} is not set; using fallback.`);
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Failed to parse ${name} as JSON:`, err.message);
    return fallback;
  }
}

const namespaceMap = parseJsonEnv('NAMESPACE_MAP', {});
const templateMap = parseJsonEnv('TEMPLATE_MAP', {});

function validHttpsUrl(value, name) {
  try {
    const url = new URL(value);
    const insecureAllowed = process.env.ALLOW_INSECURE_GITLAB === 'true';
    if (url.protocol !== 'https:' && !(insecureAllowed && url.protocol === 'http:')) {
      throw new Error('HTTPS is required');
    }
    if (url.username || url.password) {
      throw new Error('credentials must not be embedded in the URL');
    }
    return true;
  } catch (error) {
    console.error(`${name} is invalid: ${error.message}`);
    return false;
  }
}

configurationReady = Boolean(
  GITLAB_TOKEN &&
  Object.keys(namespaceMap).length &&
  Object.keys(templateMap).length &&
  validHttpsUrl(GITLAB_API_URL, 'GITLAB_API_URL') &&
  validHttpsUrl(GITLAB_WEB_URL, 'GITLAB_WEB_URL') &&
  validHttpsUrl(TEMPLATE_REPO_PREFIX, 'TEMPLATE_REPO_PREFIX')
);

const validArtifactTypes = {
  Go: ['Image', 'Library'],
  Java: ['Image', 'Library', 'Kjar'],
  Javascript: ['Image', 'Library']
};
const PROJECT_VISIBILITY = 'private';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redactSensitive(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) || String(value);
  return GITLAB_TOKEN ? text.replaceAll(GITLAB_TOKEN, '[REDACTED]') : text;
}

function authenticatedGitUrl(value) {
  const url = new URL(value);
  url.username = 'oauth2';
  url.password = GITLAB_TOKEN;
  return url.toString();
}

// -------------------------
// Helper functions
// -------------------------
async function ensureProtectedBranch(
  project_id,
  branch_name,
  { push_access_level, merge_access_level, allow_force_push }
) {
  try {
    const currentProtection = await axios.get(
      `${GITLAB_API_URL}/projects/${project_id}/protected_branches`,
      {
        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
      }
    );

    const branchProtected = currentProtection.data.some(
      (branch) => branch.name === branch_name
    );

    if (branchProtected) {
      console.log(
        `ℹ️ Branch "${branch_name}" is already protected. Deleting protection...`
      );

      await axios.delete(
        `${GITLAB_API_URL}/projects/${project_id}/protected_branches/${encodeURIComponent(
          branch_name
        )}`,
        {
          headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        }
      );

      console.log(`✅ Protection for branch "${branch_name}" deleted.`);
    } else {
      console.log(`ℹ️ Branch "${branch_name}" is not protected yet.`);
    }

    await axios.post(
      `${GITLAB_API_URL}/projects/${project_id}/protected_branches`,
      {
        name: branch_name,
        push_access_level,
        merge_access_level,
        allow_force_push
      },
      { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } }
    );

    console.log(
      `✅ Branch "${branch_name}" protected with desired settings.`
    );
  } catch (err) {
    console.error(
      `❌ Failed to ensure protection for branch "${branch_name}":`,
      err.response?.data || err.message
    );
  }
}

async function getProtectedBranchId(project_id, branch_name) {
  try {
    const resp = await axios.get(
      `${GITLAB_API_URL}/projects/${project_id}/protected_branches`,
      {
        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
      }
    );
    const branch = resp.data.find((b) => b.name === branch_name);
    if (branch) {
      console.log(
        `✅ Found protected_branch_id for ${branch_name}: ${branch.id}`
      );
      return branch.id;
    } else {
      console.warn(`⚠️ Protected branch ${branch_name} not found.`);
      return null;
    }
  } catch (err) {
    console.error(
      '❌ Failed to get protected branches:',
      err.response?.data || err.message
    );
    return null;
  }
}

async function getGroupId(group_search_term) {
  try {
    const resp = await axios.get(
      `${GITLAB_API_URL}/groups?search=${encodeURIComponent(
        group_search_term
      )}`,
      {
        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
      }
    );
    if (resp.data.length > 0) {
      console.log(
        `✅ Found group_id for ${group_search_term}: ${resp.data[0].id}`
      );
      return resp.data[0].id;
    } else {
      console.warn(`⚠️ Group ${group_search_term} not found.`);
      return null;
    }
  } catch (err) {
    console.error(
      '❌ Failed to get group:',
      err.response?.data || err.message
    );
    return null;
  }
}

async function shareGroupToProject(project_id, group_id) {
  try {
    await axios.post(
      `${GITLAB_API_URL}/projects/${project_id}/share`,
      {
        group_id,
        group_access: 30
      },
      {
        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
      }
    );
    console.log(`✅ Group ID ${group_id} shared to project.`);
  } catch (err) {
    if (
      err.response?.data?.message?.includes(
        'Project cannot be shared with the group it is in'
      )
    ) {
      console.log(
        '⚠️ Group is parent or ancestor, cannot share. Proceeding.'
      );
    } else if (
      err.response?.data?.message === 'Group already shared with this group'
    ) {
      console.log(`ℹ️ Group ID ${group_id} already shared.`);
    } else {
      console.error(
        '❌ Failed to share group to project:',
        err.response?.data || err.message
      );
    }
  }
}

async function waitForGroupSync(
  project_id,
  group_id,
  maxRetries = 5
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios.get(
        `${GITLAB_API_URL}/projects/${project_id}/groups?with_shared=true&shared_min_access_level=20`,
        {
          headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        }
      );
      const groupFound = resp.data.some(
        (group) => group.id === group_id
      );
      if (groupFound) {
        console.log(
          `✅ Group ID ${group_id} is confirmed shared to project.`
        );
        await sleep(1500);
        return;
      } else {
        console.log(
          `⏳ Waiting for group ID ${group_id} to sync... (${attempt}/${maxRetries})`
        );
        await sleep(2000);
      }
    } catch (err) {
      console.error(
        '❌ Failed to check project groups:',
        err.response?.data || err.message
      );
      await sleep(2000);
    }
  }
  console.warn(
    `⚠️ Group ID ${group_id} did NOT sync after retries.`
  );
}

/**
 * Wait a bit after project creation so GitLab has time
 * to provision the repository (avoids transient 422 errors).
 */
async function waitForRepoReady(project_id, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await axios.get(
        `${GITLAB_API_URL}/projects/${project_id}`,
        {
          headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        }
      );
      // If the project exists, we still give it a short time
      // to ensure underlying repo is ready.
      if (attempt > 1) {
        console.log(
          `✅ Project ${project_id} reachable after ${attempt} attempts.`
        );
      }
      await sleep(1500);
      return;
    } catch (err) {
      console.log(
        `⏳ Waiting for project ${project_id} to become ready... (${attempt}/${maxRetries})`
      );
      await sleep(2000);
    }
  }
  console.warn(
    `⚠️ Project ${project_id} may not be fully ready even after retries.`
  );
}

/**
 * Retry git push to handle transient GitLab problems
 * like "Could not create project" 422 during repo init.
 */
async function retryGitPush(gitRepo, args, retries = 5, delayMs = 2000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await gitRepo.push(args);
      if (attempt > 1) {
        console.log(
          `✅ Git push succeeded on attempt ${attempt}/${retries}`
        );
      }
      return;
    } catch (err) {
      lastError = err;
      console.error(
        `❌ Git push failed (attempt ${attempt}/${retries}):`,
        redactSensitive(err.message)
      );
      await sleep(delayMs);
    }
  }
  throw lastError || new Error('Git push failed after retries');
}

// -------------------------
// API: config for subgroups
// -------------------------
router.get('/api/config/subgroups', (req, res) => {
  try {
    const subgroups = Object.keys(namespaceMap).map((key) => ({
      label: key,
      value: key
    }));
    res.json(subgroups);
  } catch (err) {
    console.error('❌ Failed to load subgroups:', err.message);
    res.status(500).json({ error: 'Failed to load subgroups' });
  }
});

// -------------------------
// API: create GitLab repo
// -------------------------
const creationAttempts = new Map();
const idempotencyKeys = new Map();
const creationWindowMs = 10 * 60 * 1000;
const creationLimit = Math.max(1, Number.parseInt(process.env.CREATE_RATE_LIMIT || '5', 10));
const maxTrackedCreationClients = 10_000;
const maxTrackedIdempotencyKeys = 10_000;

function creationRateLimit(req, res, next) {
  const now = Date.now();
  for (const [candidate, timestamps] of creationAttempts) {
    const active = timestamps.filter((timestamp) => now - timestamp < creationWindowMs);
    if (active.length) creationAttempts.set(candidate, active);
    else creationAttempts.delete(candidate);
  }
  const key = req.ip || 'unknown';
  if (!creationAttempts.has(key) && creationAttempts.size >= maxTrackedCreationClients) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Repository creation is temporarily rate limited' });
  }
  const recent = creationAttempts.get(key) || [];
  if (recent.length >= creationLimit) {
    res.setHeader('Retry-After', Math.ceil((creationWindowMs - (now - recent[0])) / 1000));
    return res.status(429).json({ error: 'Too many repository creation requests. Try again later.' });
  }
  recent.push(now);
  creationAttempts.set(key, recent);
  next();
}

function rejectDuplicateRequest(req, res, next) {
  const now = Date.now();
  for (const [key, timestamp] of idempotencyKeys) {
    if (now - timestamp >= creationWindowMs) idempotencyKeys.delete(key);
  }
  const key = req.get('idempotency-key');
  if (!key) return next();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
    return res.status(400).json({ error: 'Invalid Idempotency-Key header' });
  }
  if (idempotencyKeys.has(key)) {
    return res.status(409).json({ error: 'This repository creation request was already received. Check GitLab before retrying.' });
  }
  if (idempotencyKeys.size >= maxTrackedIdempotencyKeys) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Repository creation is temporarily rate limited' });
  }
  idempotencyKeys.set(key, now);
  next();
}

router.post('/api/create_repo', creationRateLimit, rejectDuplicateRequest, async (req, res) => {
  let tmpDir = null;
  let project_id = null;

  try {
    if (!configurationReady) {
      return res.status(503).json({ error: 'Repository creation is not configured' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const projectName = typeof body.projectName === 'string' ? body.projectName.trim() : '';
    const subgroup = typeof body.subgroup === 'string' ? body.subgroup.trim() : '';
    const technology = typeof body.technology === 'string' ? body.technology.trim() : '';
    const artifactType = typeof body.artifactType === 'string' ? body.artifactType.trim() : '';
    const ownerInfo = typeof body.ownerInfo === 'string' ? body.ownerInfo.trim() : '';

    if (!projectName || !subgroup || !technology || !artifactType) {
      return res.status(400).json({
        error:
          'Missing required fields: projectName, subgroup, technology, artifactType'
      });
    }

    if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])$/.test(projectName)) {
      return res.status(400).json({
        error: 'Project name must be 2-63 characters, start and end with a letter or number, and contain only letters, numbers, underscores, or hyphens'
      });
    }
    if (ownerInfo.length > 200 || /[\u0000-\u001F\u007F]/.test(ownerInfo)) {
      return res.status(400).json({ error: 'Owner info is invalid or exceeds 200 characters' });
    }

    const namespace_id = namespaceMap[subgroup];
    const template_name =
      artifactType.toLowerCase() === 'kjar'
        ? 'embark-java-image-kjar'
        : `embark-${technology.toLowerCase()}-${artifactType.toLowerCase()}`;

    const template_project_id = templateMap[template_name];
    const repoUrl = `${TEMPLATE_REPO_PREFIX}${template_name}.git`;

    if (!namespace_id) {
      return res
        .status(400)
        .json({ error: 'Invalid subgroup mapping' });
    }
    if (!validArtifactTypes[technology]?.includes(artifactType)) {
      return res
        .status(400)
        .json({ error: 'Invalid Technology and Artifact Type' });
    }
    if (!template_project_id) {
      return res
        .status(400)
        .json({ error: 'Template mapping failed' });
    }

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-'));

    console.log('🚀 Creating GitLab project:', {
      projectName,
      subgroup,
      technology,
      artifactType,
      namespace_id,
      template_name
    });

    const projectResp = await axios.post(
      `${GITLAB_API_URL}/projects`,
      {
        name: projectName,
        path: projectName
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-'),
        namespace_id,
        visibility: PROJECT_VISIBILITY,
        description: `Owner: ${
          ownerInfo || 'N/A'
        }, Technology: ${technology}, Artifact: ${artifactType}`
      },
      {
        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
      }
    );

    project_id = projectResp.data.id;
    const projectPath = projectResp.data.path_with_namespace;

    console.log(
      `✅ Project created with ID ${project_id} (${projectPath})`
    );

    // Wait a bit for GitLab to provision the repository to avoid 422 errors.
    await waitForRepoReady(project_id);

    const git = simpleGit();
    const templateCloneUrl = authenticatedGitUrl(repoUrl);

    console.log(`ℹ️ Cloning template repo from ${repoUrl}`);
    await git.clone(templateCloneUrl, tmpDir);

    const gitCloned = simpleGit(tmpDir);
    await gitCloned.removeRemote('origin');

    const targetRepoUrl = authenticatedGitUrl(
      new URL(`${projectPath}.git`, `${GITLAB_WEB_URL.replace(/\/+$/, '')}/`).toString()
    );
    await gitCloned.addRemote('origin', targetRepoUrl);

    console.log('ℹ️ Pushing template contents to master (with retries)...');
    await retryGitPush(gitCloned, ['-u', 'origin', 'HEAD:master', '--force']);

    await fs.remove(tmpDir);
    tmpDir = null;
    console.log('✅ Template repo synced and temp dir removed');

    await axios.put(
      `${GITLAB_API_URL}/projects/${project_id}`,
      {
        default_branch: 'master'
      },
      { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } }
    );
    console.log('✅ Default branch set to master');

    await ensureProtectedBranch(project_id, 'master', {
      push_access_level: 0,
      merge_access_level: 30,
      allow_force_push: false
    });

    const masterBranchId = await getProtectedBranchId(
      project_id,
      'master'
    );
    const subgroupGroupId = await getGroupId(subgroup);

    if (masterBranchId && subgroupGroupId) {
      await shareGroupToProject(project_id, subgroupGroupId);
      await waitForGroupSync(project_id, subgroupGroupId);
      try {
        await axios.post(
          `${GITLAB_API_URL}/projects/${project_id}/approval_rules`,
          {
            name: 'Peer Review',
            approvals_required: 1,
            rule_type: 'regular',
            protected_branch_ids: [masterBranchId],
            applies_to_all_protected_branches: false,
            branches: ['master'],
            group_ids: [subgroupGroupId]
          },
          { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } }
        );
        console.log(
          '✅ Approval rule "Peer Review" added to master'
        );
      } catch (err) {
        console.error(
          '❌ Failed to set approval rule for master:',
          err.response?.data || err.message
        );
      }
    }

    let awsMasterExists = false;
    try {
      const branchesResp = await axios.get(
        `${GITLAB_API_URL}/projects/${project_id}/repository/branches`,
        {
          headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        }
      );
      awsMasterExists = branchesResp.data.some(
        (branch) => branch.name === 'aws_master'
      );
    } catch (err) {
      console.error(
        '❌ Failed to get branches:',
        err.response?.data || err.message
      );
    }

    if (!awsMasterExists) {
      try {
        await axios.post(
          `${GITLAB_API_URL}/projects/${project_id}/repository/branches`,
          {
            branch: 'aws_master',
            ref: 'master'
          },
          { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } }
        );
        console.log('✅ aws_master branch created from master');
      } catch (err) {
        console.error(
          '❌ Failed to create aws_master branch:',
          err.response?.data || err.message
        );
      }
    } else {
      console.log('ℹ️ aws_master branch already exists');
    }

    await ensureProtectedBranch(project_id, 'aws_master', {
      push_access_level: 0,
      merge_access_level: 30,
      allow_force_push: false
    });

    const awsMasterBranchId = await getProtectedBranchId(
      project_id,
      'aws_master'
    );

    if (awsMasterBranchId && subgroupGroupId) {
      await shareGroupToProject(project_id, subgroupGroupId);
      await waitForGroupSync(project_id, subgroupGroupId);
      try {
        await axios.post(
          `${GITLAB_API_URL}/projects/${project_id}/approval_rules`,
          {
            name: 'AWS Peer Review',
            approvals_required: 1,
            rule_type: 'regular',
            protected_branch_ids: [awsMasterBranchId],
            applies_to_all_protected_branches: false,
            branches: ['aws_master'],
            group_ids: [subgroupGroupId]
          },
          { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } }
        );
        console.log(
          '✅ Approval rule "AWS Peer Review" added to aws_master'
        );
      } catch (err) {
        console.error(
          '❌ Failed to set approval rule for aws_master:',
          err.response?.data || err.message
        );
      }
    }

    const protectedBranches = await axios.get(
      `${GITLAB_API_URL}/projects/${project_id}/protected_branches`,
      {
        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
      }
    );
    console.log(
      '✅ Final protected branches:',
      protectedBranches.data.map((b) => b.name)
    );

    res.json({
      message:
        'GitLab project created and initialized with template!',
      project_url: projectResp.data.web_url
    });
  } catch (error) {
    console.error(
      '❌ Error creating GitLab project:',
      redactSensitive(error.response?.data || error.message)
    );
    if (tmpDir) {
      try {
        await fs.remove(tmpDir);
      } catch (_) {
        // Ignore cleanup errors; the pod's ephemeral /tmp is discarded on restart.
      }
    }

    // (Optional) If you want, you could delete the partially created project here:
    // if (project_id) {
    //   try {
    //     await axios.delete(`${GITLAB_API_URL}/projects/${project_id}`, {
    //       headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
    //     });
    //     console.log(`🧹 Deleted partially created project ${project_id}`);
    //   } catch (delErr) {
    //     console.error('❌ Failed to delete partially created project:', delErr.response?.data || delErr.message);
    //   }
    // }

    res.status(500).json({ error: 'Failed to create GitLab project' });
  }
});

router.get('/healthz', (req, res) => res.status(200).send('ok'));
router.get('/readyz', (req, res) => {
  const ready = isReady && configurationReady;
  res.status(ready ? 200 : 503).send(ready ? 'ok' : 'not ready');
});

router.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// -------------------------
// SPA fallback (Angular) — skip /api paths so they 404 cleanly
// -------------------------
router.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  return sendSpaIndex(req, res, next);
});

// -------------------------
// Mount router at the configured base path
// -------------------------
if (BASE_PATH !== '/') {
  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.path === BASE_PATH) {
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(308, `${BASE_PATH}/${query}`);
    }
    next();
  });
}
app.use(BASE_PATH, router);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof SyntaxError && 'body' in error ? 400 : 500;
  if (status === 500) console.error('Unhandled request error:', redactSensitive(error.message));
  res.status(status).json({ error: status === 400 ? 'Malformed JSON request' : 'Internal server error' });
});

// -------------------------
// Start server + graceful shutdown
// -------------------------
let server;

function startServer(listenPort = port) {
  if (server) return server;
  server = app.listen(listenPort, () => {
    isReady = true;
    const address = server.address();
    const activePort = typeof address === 'object' && address ? address.port : listenPort;
    console.log(`GitLab Repo Creator running on port ${activePort} (BASE_PATH=${BASE_PATH})`);
  });
  return server;
}

function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  isReady = false;
  if (!server) return;
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  const forcedShutdown = setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 25_000);
  forcedShutdown.unref();
}

if (require.main === module) {
  startServer();
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { app, applyCspNonce, startServer, normalizeBasePath, PROJECT_VISIBILITY };
