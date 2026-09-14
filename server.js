const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();

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

app.use(express.static(path.join(__dirname, 'static')));

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
        site
      } = req.body;

      const requesterEmail = String(email ?? '').trim().toLowerCase();
      const ticketSubject = String(subject ?? '').trim();
      const ticketDescription = String(description ?? '').trim();
      const ticketUrgency = String(urgency ?? 'Normal').trim();
      const ticketCategory = resolveCategory(category);
      const ticketSite = String(site ?? '').trim();

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
        attachmentCount: Array.isArray(req.files) ? req.files.length : 0
      });

      const token = await getAccessToken();
      const safeDescription = ticketDescription.replace(/\n/g, '<br>');

      const fullDescription =
        `<b>Submitted By:</b> ${escapeHtml(requesterEmail)}<br>` +
        `<b>Site:</b> ${escapeHtml(ticketSite)}<br>` +
        `<b>Urgency:</b> ${escapeHtml(ticketUrgency)}<br><br>` +
        `<b>Issue Description:</b><br>${escapeHtml(safeDescription)}`;

      const requestPayload = {
        request: {
          subject: ticketSubject,
          description: fullDescription,
          requester: { email_id: requesterEmail },
          urgency: { name: ticketUrgency },
          category: { name: ticketCategory },
          request_type: { name: 'Incident' },
          template: { name: 'Motorad NA Service Request' }
        }
      };

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
