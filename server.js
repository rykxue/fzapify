import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 11001;
const app = express();
const SESSION_FILE = 'sessions.json';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize sessions storage
async function initializeSessionStore() {
  try {
    await fs.access(SESSION_FILE);
  } catch {
    await fs.writeFile(SESSION_FILE, JSON.stringify({}));
  }
}

// Read sessions from file
async function readSessions() {
  try {
    const data = await fs.readFile(SESSION_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading sessions:', error);
    return {};
  }
}

// Write sessions to file
async function writeSessions(sessions) {
  try {
    await fs.writeFile(SESSION_FILE, JSON.stringify(sessions, null, 2));
  } catch (error) {
    console.error('Error writing sessions:', error);
  }
}

// Save sharing progress
async function saveProgress(sessionId, progress) {
  const sessions = await readSessions();
  sessions[sessionId] = {
    ...sessions[sessionId],
    ...progress,
    lastUpdated: new Date().toISOString()
  };
  await writeSessions(sessions);
}

function parseCookiesFromJSON(cookieArray) {
  return cookieArray
    .map(cookie => `${cookie.key}=${cookie.value}`)
    .join("; ");
}

// Fetch Facebook Token
async function getFacebookToken(cookie) {
  const headers = {
    "authority": "business.facebook.com",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    "cookie": cookie,
    "referer": "https://www.facebook.com/",
    "sec-ch-ua": '".Not/A)Brand";v="99", "Google Chrome";v="103", "Chromium";v="103"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };

  try {
    const response = await axios.get("https://business.facebook.com/content_management", { headers });
    const token = response.data.split("EAAG")[1].split('","')[0];
    return `${cookie}|EAAG${token}`;
  } catch (error) {
    console.error("Failed to retrieve token:", error.message);
    return null;
  }
}

// Check Cookie Validity
async function isCookieAlive(cookie) {
  const headers = {
    "authority": "business.facebook.com",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    "cookie": cookie,
    "referer": "https://www.facebook.com/",
    "sec-ch-ua": '".Not/A)Brand";v="99", "Google Chrome";v="103", "Chromium";v="103"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };

  try {
    const response = await axios.get("https://business.facebook.com/content_management", { headers });
    return response.status === 200;
  } catch (error) {
    console.error("Cookie validation failed:", error.message);
    return false;
  }
}

// Get Post ID
async function getPostId(postLink) {
  try {
    const response = await axios.post(
      "https://id.traodoisub.com/api.php",
      new URLSearchParams({ link: postLink })
    );
    return response.data.id || null;
  } catch (error) {
    console.error("Error getting post ID:", error.message);
    return null;
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post("/submit", async (req, res) => {
  const { cookie, url, amount, interval } = req.body;
  const sessionId = Date.now().toString();

  if (!cookie || !url || !amount || !interval) {
    return res.status(400).json({ detail: "Missing required parameters." });
  }

  // Initialize session
  await saveProgress(sessionId, {
    status: 'started',
    totalShares: parseInt(amount),
    completedShares: 0,
    url,
    interval
  });

  let cookieString = "";
  if (Array.isArray(cookie)) {
    cookieString = parseCookiesFromJSON(cookie);
  } else if (typeof cookie === "string") {
    try {
      const cookieJSON = JSON.parse(cookie);
      if (typeof cookieJSON === "object" && cookieJSON !== null) {
        cookieString = Object.entries(cookieJSON)
          .map(([key, value]) => `${key}=${value}`)
          .join("; ");
      } else {
        cookieString = cookie;
      }
    } catch (e) {
      cookieString = cookie;
    }
  } else {
    return res.status(400).json({ detail: "Invalid cookie format." });
  }

  res.json({ session_id: sessionId });

  // Start the sharing process in the background
  shareInBackground(sessionId, cookieString, url, parseInt(amount), parseFloat(interval));
});

async function performShareWithRetries(cookie, token, postId, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const headers = {
        "authority": "graph.facebook.com",
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://www.facebook.com",
        "referer": "https://www.facebook.com/",
        "sec-ch-ua": '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
        "x-fb-friendly-name": "feed_story_share_mutation"
      };

      const data = {
        "av": cookie.split("c_user=")[1].split(";")[0],
        "__user": cookie.split("c_user=")[1].split(";")[0],
        "__a": "1",
        "__dyn": "7AzHxqU5a5Q1ryaxG4VuC0BVU98nwgU765QdwSwAyU8EW0CEboG4E762S1DwUx60gu0BU2_CxS320om78bbwto88422y11xmfz81s8hwGwQw9m1YwBgK7o884y0Mo5W3S1lwlE-UqwsUkxe2GewGwkUtxGm2SUbElxm3y11xfxmu3W2i4U72m7-8wywfCm2Sq2-azo2NwwwOg2cwMwhF8-4UdUcojxK2B0oobo8o",
        "__csr": "g8Ind5IgZijlcHtL9leCGdnVaHSIB4tq8KQl4bhd8vkGGpWF7xCGKWl4GiKQBCHQKKQfQlbHy8KbKFVEGulWxOuqKUy-KFKmFo_yp8yUC3G4UhwoU5-1Jw0Dpo0xS0y88320cU0emw0eG0qo0j-007l3w",
        "__req": "n",
        "__hs": "19568.HYP:comet_pkg.2.1..2.1",
        "dpr": "1",
        "__ccg": "EXCELLENT",
        "__rev": "1007150578",
        "__s": "xc8bz4:5gfr17:2hb4os",
        "__hsi": "7252293332903336015",
        "__comet_req": "15",
        "fb_dtsg": token,
        "jazoest": "25533",
        "lsd": "ZM7FAk5rTz0P5h9lzQIy8j",
        "__aaid": "710580363942837",
        "__spin_r": "1007150578",
        "__spin_b": "trunk",
        "__spin_t": "1685382944",
        "fb_api_caller_class": "RelayModern",
        "fb_api_req_friendly_name": "feed_story_share_mutation",
        "variables": JSON.stringify({
          "input": {
            "attachments": [{"link": {"share_scrape_data": `{"share_type":22,"share_params":[${postId}]}`}}],
            "audiences": {"undirected": {"privacy": {"allow": [], "base_state": "EVERYONE", "deny": [], "tag_expansion_state": "UNSPECIFIED"}}},
            "message": {"ranges": [], "text": ""},
            "is_tracking_encrypted": true,
            "navigation_data": {"attribution_id_v2": "CometSinglePostRoot.react,comet.post.single,via_cold_start,1685382945057,908007,,"},
            "source": "www",
            "tracking": [],
            "actor_id": cookie.split("c_user=")[1].split(";")[0],
            "client_mutation_id": "1"
          },
          "renderLocation": "homepage_stream",
          "scale": 1,
          "privacySelectorRenderLocation": "COMET_STREAM",
          "useDefaultActor": false,
          "displayCommentsPageSize": 3,
          "feedLocation": "NEWSFEED",
          "displayCommentsFeedbackContext": null,
          "feedbackSource": 1,
          "focusCommentID": null,
          "UFI2CommentsProvider_commentsKey": "CometModernHomeFeedQuery"
        }),
        "server_timestamps": "true",
        "doc_id": "5624054241022832"
      };

      const response = await axios.post("https://graph.facebook.com/v21.0/me/feed", new URLSearchParams(data), { headers });
      if (response.data && response.data.data && response.data.data.story_create) {
        return true;
      }
    } catch (error) {
      console.error(`Share attempt ${i + 1} failed:`, error.message);
      if (i === maxRetries - 1) {
        throw error;
      }
    }
  }
  return false;
}

async function shareInBackground(sessionId, cookieString, url, amount, interval) {
  try {
    const isAlive = await isCookieAlive(cookieString);
    if (!isAlive) {
      await saveProgress(sessionId, { status: 'failed', error: 'Invalid cookie' });
      return;
    }

    const facebookToken = await getFacebookToken(cookieString);
    if (!facebookToken) {
      await saveProgress(sessionId, { status: 'failed', error: 'Token retrieval failed' });
      return;
    }
    const [retrievedCookie, token] = facebookToken.split("|");

    const postId = await getPostId(url);
    if (!postId) {
      await saveProgress(sessionId, { status: 'failed', error: 'Invalid post ID' });
      return;
    }

    let successCount = 0;

    for (let i = 0; i < amount; i++) {
      await new Promise(resolve => setTimeout(resolve, interval * 1000));
      const success = await performShareWithRetries(retrievedCookie, token, postId);
      if (success) {
        successCount++;
        await saveProgress(sessionId, {
          status: 'in_progress',
          completedShares: successCount
        });
      }
    }

    await saveProgress(sessionId, {
      status: 'completed',
      completedShares: successCount
    });
  } catch (error) {
    await saveProgress(sessionId, {
      status: 'failed',
      error: error.message
    });
  }
}

app.get("/total-sessions", async (req, res) => {
  try {
    const sessions = await readSessions();
    const activeSessions = Object.entries(sessions)
      .filter(([_, session]) => session.status === 'in_progress' || session.status === 'started')
      .map(([id, session]) => ({
        id: id,
        session: id.slice(-4),
        url: session.url,
        count: session.completedShares,
        target: session.totalShares
      }));
    res.json(activeSessions);
  } catch (error) {
    res.status(500).json({ detail: "Error fetching sessions" });
  }
});

// Initialize session store and start server
initializeSessionStore().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});