const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '64kb' }));

const SDP_BASE = 'https://sdpondemand.manageengine.com';
const PORTAL = 'itdesk';
const PORT = process.env.PORT || 3000;

const allowedMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

const TECHNICIAN_GROUPS_BY_SITE = {
  'Motorad Israel': {
    priority: 'IL Priority Support',
    default: 'IL IT Support'
  },
  'Motorad Germany': {
    priority: 'IL Priority Support',
    default: 'IL IT Support'
  }
};

const PRIORITY_TECHNICIAN_CATEGORY = 'IT - Priority Request/Support';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
    fileSize: 10 * 1024 * 1024,
    fields: 20,
    fieldSize: 100 * 1024
  },
  fileFilter: (req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    return callback(null, true);
  }
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
}

function resolveCategory(category) {
  const normalized = String(category ?? '').trim();

  // These are form-level routing choices, not necessarily ServiceDesk
  // category names. Configure the exact ServiceDesk category names in Railway.
  if (normalized === 'Maintenance') {
    return process.env.SDP_MAINTENANCE_CATEGORY || 'General';
  }

  if (normalized === 'Business Intelligence') {
    return process.env.SDP_BI_CATEGORY || 'General';
  }

  // ServiceDesk Plus category names are exact. Normalize comma spacing
  // so values such as "JNP, WebCat" match "JNP,WebCat".
  return normalized.replace(/,\s+/g, ',') || 'General';
}

async function getAccessToken() {
  const required = ['SDP_CLIENT_ID', 'SDP_CLIENT_SECRET', 'SDP_REFRESH_TOKEN'];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing ServiceDesk configuration: ${missing.join(', ')}`);
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.SDP_CLIENT_ID,
    client_secret: process.env.SDP_CLIENT_SECRET,
    refresh_token: process.env.SDP_REFRESH_TOKEN
  });

  const response = await axios.post(
    'https://accounts.zoho.com/oauth/v2/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (!response.data?.access_token) {
    throw new Error('ServiceDesk token refresh failed');
  }

  return response.data.access_token;
}

const TECHNICIAN_STORE_PATH = process.env.TECHNICIAN_STORE_PATH || path.join(__dirname, 'data', 'technicians.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || ADMIN_PASSWORD;

const DEFAULT_TECHNICIANS = {
  'IL IT Support': [],
  'IL Priority Support': []
};

function ensureTechnicianStore() {
  const directory = path.dirname(TECHNICIAN_STORE_PATH);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(TECHNICIAN_STORE_PATH)) {
    fs.writeFileSync(TECHNICIAN_STORE_PATH, JSON.stringify(DEFAULT_TECHNICIANS, null, 2));
  }
}

function readTechnicianStore() {
  ensureTechnicianStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(TECHNICIAN_STORE_PATH, 'utf8'));
    return {
      'IL IT Support': Array.isArray(parsed['IL IT Support']) ? parsed['IL IT Support'] : [],
      'IL Priority Support': Array.isArray(parsed['IL Priority Support']) ? parsed['IL Priority Support'] : []
    };
  } catch {
    return { ...DEFAULT_TECHNICIANS };
  }
}

function writeTechnicianStore(store) {
  ensureTechnicianStore();
  const temporaryPath = `${TECHNICIAN_STORE_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2));
  fs.renameSync(temporaryPath, TECHNICIAN_STORE_PATH);
}

function getManualTechniciansForSite(siteName, categoryName) {
  const siteGroups = TECHNICIAN_GROUPS_BY_SITE[siteName];
  if (!siteGroups) return [];

  const selectedGroup = categoryName === PRIORITY_TECHNICIAN_CATEGORY
    ? siteGroups.priority
    : siteGroups.default;

  const store = readTechnicianStore();
  return [...new Set((store[selectedGroup] || []).map((name) => String(name).trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function createAdminSession() {
  const expiresAt = Date.now() + (8 * 60 * 60 * 1000);
  const payload = `${expiresAt}`;
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  return `${base64Url(payload)}.${signature}`;
}

function isAdminSessionValid(req) {
  if (!ADMIN_SESSION_SECRET) return false;
  const cookies = String(req.headers.cookie || '').split(';').reduce((result, item) => {
    const [key, ...parts] = item.trim().split('=');
    if (key) result[key] = parts.join('=');
    return result;
  }, {});
  const session = cookies.admin_session;
  if (!session) return false;

  const [encodedExpiry, signature] = session.split('.');
  if (!encodedExpiry || !signature) return false;

  const payload = Buffer.from(encodedExpiry, 'base64url').toString('utf8');
  const expectedSignature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  if (signature.length !== expectedSignature.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return false;

  return Number(payload) > Date.now();
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin access is not configured' });
  }
  if (!isAdminSessionValid(req)) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  return next();
}

app.use(express.static(path.join(__dirname, 'static')));

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin access is not configured' });
  }

  const password = String(req.body?.password || '');
  const passwordMatches = password.length === ADMIN_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));
  if (!password || !passwordMatches) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  res.setHeader('Set-Cookie', `admin_session=${createAdminSession()}; Max-Age=28800; HttpOnly; Secure; SameSite=Strict; Path=/`);
  return res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  res.setHeader('Set-Cookie', 'admin_session=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/');
  return res.json({ ok: true });
});

app.get('/api/admin/technicians', requireAdmin, (req, res) => {
  return res.json({ technicians: readTechnicianStore() });
});

app.post('/api/admin/technicians', requireAdmin, (req, res) => {
  const group = String(req.body?.group || '').trim();
  const name = String(req.body?.name || '').trim();
  const store = readTechnicianStore();

  if (!Object.prototype.hasOwnProperty.call(store, group)) {
    return res.status(400).json({ error: 'Invalid technician group' });
  }
  if (!name || name.length > 150) {
    return res.status(400).json({ error: 'Technician name is required' });
  }
  if (!store[group].some((existing) => existing.toLowerCase() === name.toLowerCase())) {
    store[group].push(name);
    store[group].sort((left, right) => left.localeCompare(right));
    writeTechnicianStore(store);
  }

  return res.json({ ok: true, technicians: store });
});

app.delete('/api/admin/technicians', requireAdmin, (req, res) => {
  const group = String(req.body?.group || '').trim();
  const name = String(req.body?.name || '').trim();
  const store = readTechnicianStore();

  if (!Object.prototype.hasOwnProperty.call(store, group)) {
    return res.status(400).json({ error: 'Invalid technician group' });
  }

  store[group] = store[group].filter((existing) => existing.toLowerCase() !== name.toLowerCase());
  writeTechnicianStore(store);
  return res.json({ ok: true, technicians: store });
});

app.get('/api/technicians', (req, res) => {
  const siteName = String(req.query.site ?? '').trim();
  const categoryName = String(req.query.category ?? '').trim();
  if (!siteName) return res.status(400).json({ error: 'site is required' });

  const siteGroups = TECHNICIAN_GROUPS_BY_SITE[siteName];
  const selectedGroup = siteGroups
    ? (categoryName === PRIORITY_TECHNICIAN_CATEGORY ? siteGroups.priority : siteGroups.default)
    : null;

  return res.json({
    site: siteName,
    category: categoryName,
    group: selectedGroup,
    technicians: getManualTechniciansForSite(siteName, categoryName)
  });
});

app.post('/api/submit', (req, res) => {
  upload.any()(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(400).json({
        error: uploadError.message || 'Invalid upload'
      });
    }

    try {
      const {
        email,
        subject,
        description,
        urgency,
        category,
        site,
        technician
      } = req.body;

      const requesterEmail = String(email ?? '').trim().toLowerCase();
      const ticketSubject = String(subject ?? '').trim();
      const ticketDescription = String(description ?? '').trim();
      const ticketUrgency = String(urgency ?? 'Normal').trim();
      const ticketCategory = resolveCategory(category);
      const ticketSite = String(site ?? '').trim();
      const ticketTechnician = String(technician ?? '').trim();

      if (!isValidEmail(requesterEmail)) {
        return res.status(400).json({ error: 'A valid requester email is required' });
      }

      if (!ticketSubject) {
        return res.status(400).json({ error: 'A subject is required' });
      }

      if (!ticketDescription) {
        return res.status(400).json({ error: 'A description is required' });
      }

      // Log metadata only. Do not log the full email, subject, description,
      // attachment contents, OAuth tokens, or other ticket details.
      console.log('Received help desk submission', {
        hasRequester: true,
        subjectLength: ticketSubject.length,
        urgency: ticketUrgency,
        category: ticketCategory,
        site: ticketSite,
        technician: ticketTechnician || null,
        attachmentCount: Array.isArray(req.files) ? req.files.length : 0
      });

      const token = await getAccessToken();

      // Accept both the current plain-text form payload and older submissions
      // that included <b> and <br> markup in the description.
      const plainDescription = ticketDescription
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/?b>/gi, '')
        .replace(/&nbsp;/gi, ' ')
        .trim();
      const safeDescription = escapeHtml(plainDescription).replace(/\n/g, '<br>');

      const fullDescription =
        `<b>Submitted By:</b> ${escapeHtml(requesterEmail)}<br><br>` +
        `${safeDescription}`;

      const requestPayload = {
        request: {
          subject: ticketSubject,
          description: fullDescription,
          requester: { email_id: requesterEmail },
          urgency: { name: ticketUrgency },
          category: { name: ticketCategory },
          site: { name: ticketSite },
          request_type: { name: 'Incident' },
          template: { name: 'Motorad NA Service Request' }
        }
      };

      if (ticketTechnician) {
        requestPayload.request.technician = { name: ticketTechnician };
      }

      const params = new URLSearchParams({
        input_data: JSON.stringify(requestPayload)
      });

      const createResponse = await axios.post(
        `${SDP_BASE}/app/${PORTAL}/api/v3/requests`,
        params.toString(),
        {
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            Accept: 'application/vnd.manageengine.sdp.v3+json',
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const createdRequest = createResponse.data?.request;
      const requestId = createdRequest?.id;
      const displayId = createdRequest?.display_id;

      if (!requestId || !displayId) {
        throw new Error('ServiceDesk returned no ticket identifier');
      }

      const attachmentErrors = [];
      const files = Array.isArray(req.files) ? req.files : [];

      for (const file of files) {
        try {
          const form = new FormData();
          form.append('addtoattachment', 'true');
          form.append('filename', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype
          });

          await axios.post(
            `${SDP_BASE}/app/${PORTAL}/api/v3/requests/${requestId}/_uploads`,
            form,
            {
              headers: {
                Authorization: `Zoho-oauthtoken ${token}`,
                Accept: 'application/vnd.manageengine.sdp.v3+json',
                ...form.getHeaders()
              }
            }
          );
        } catch (attachmentError) {
          const message = attachmentError instanceof Error
            ? attachmentError.message
            : 'Attachment upload failed';
          attachmentErrors.push({ filename: file.originalname, error: message });
          console.error('Attachment upload failed', {
            filename: file.originalname,
            error: message
          });
        }
      }

      return res.json({
        success: true,
        display_id: displayId,
        id: requestId,
        attachment_errors: attachmentErrors
      });
    } catch (error) {
      const detail = error.response?.data
        ? JSON.stringify(error.response.data)
        : error instanceof Error
          ? error.message
          : 'Ticket submission failed';

      console.error('ServiceDesk submission failed:', detail);
      return res.status(500).json({ error: 'Ticket submission failed' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
