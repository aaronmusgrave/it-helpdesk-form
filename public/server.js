const express  = require('express');
const multer   = require('multer');
const axios    = require('axios');
const FormData = require('form-data');
const path     = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const SDP_BASE          = 'https://sdpondemand.manageengine.com';
const PORTAL            = 'itdesk';
const DEFAULT_REQUESTER = 'aaron.musgrave@motorad.com';

async function getAccessToken() {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.SDP_CLIENT_ID,
    client_secret: process.env.SDP_CLIENT_SECRET,
    refresh_token: process.env.SDP_REFRESH_TOKEN
  });

  const resp = await axios.post(
    'https://accounts.zoho.com/oauth/v2/token',
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (!resp.data.access_token) throw new Error('Token error: ' + JSON.stringify(resp.data));
  return resp.data.access_token;
}

app.use(express.static(path.join(__dirname, 'static')));

app.post('/api/submit', upload.any(), async (req, res) => {
  try {
    const { email, subject, description, urgency, category, site } = req.body;

    if (!email || !subject) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const token = await getAccessToken();

    const fullDesc =
      `<b>Submitted By:</b> ${email}<br>` +
      `<b>Site:</b> ${site}<br>` +
      (description || '');

    const requestPayload = {
      request: {
        subject,
        description:  fullDesc,
        requester:    { email_id: DEFAULT_REQUESTER },
        urgency:      { name: urgency || 'Normal' },
        category:     { name: category },
        request_type: { name: 'Incident' },
        template:     { name: 'Motorad NA Service Request' }
      }
    };

    const params = new URLSearchParams({ input_data: JSON.stringify(requestPayload) });

    const createResp = await axios.post(
      `${SDP_BASE}/app/${PORTAL}/api/v3/requests`,
      params.toString(),
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'Accept':        'application/vnd.manageengine.sdp.v3+json',
          'Content-Type':  'application/x-www-form-urlencoded'
        }
      }
    );

    const requestId = createResp.data.request.id;
    const displayId = createResp.data.request.display_id;

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const form = new FormData();
          form.append('addtoattachment', 'true');
          form.append('filename', file.buffer, {
            filename:    file.originalname,
            contentType: file.mimetype
          });

          await axios.post(
            `${SDP_BASE}/app/${PORTAL}/api/v3/requests/${requestId}/_uploads`,
            form,
            {
              headers: {
                'Authorization': `Zoho-oauthtoken ${token}`,
                'Accept':        'application/vnd.manageengine.sdp.v3+json',
                ...form.getHeaders()
              }
            }
          );
        } catch (uploadErr) {
          console.error('Upload error:', uploadErr.message);
        }
      }
    }

    res.json({ success: true, display_id: displayId, id: requestId });

  } catch (err) {
    console.error('Error:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
