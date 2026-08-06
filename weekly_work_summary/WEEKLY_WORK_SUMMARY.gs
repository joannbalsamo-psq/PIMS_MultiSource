/**
 * === Weekly Wed-Tue work summary ==========================================
 *
 * Replaces the Claude Cowork workflow that could not reliably automate:
 *   Calendar (Wed-Tue) + Supernote PDF + Slack (12 channels + bookmarks) +
 *   Zoom Drive exports -> Claude synthesis -> Google Sheet + Wednesday email.
 *
 * Runs Wednesday 8:37 AM America/New_York (installWednesdayTrigger).
 * Sheet / learning writes are idempotent by week_key (Wednesday start date).
 *
 * Setup: SETUP.txt in this folder.
 */

// --- Defaults (override via Script Properties) -----------------------------
var DEFAULT_SHEET_ID = "1jsoHnje92Bb1M91G4S9oe4inhSaGvEi6JUUE3KE1C64"; // Work Tracking System [2026]
var DEFAULT_TZ = "America/New_York";
var DEFAULT_MODEL = "claude-sonnet-4-20250514";
var DEFAULT_CALENDAR_ID = "primary";

var DEFAULT_SLACK_CHANNELS = [
  "implementation-team",
  "summer2026_support-helpers",
  "ask_dsat",
  "ask-comms-product",
  "ask-implementation-comms",
  "ask-smart-sites-product",
  "attendance-plus-integrations",
  "remind-to-psq-bts-collaboration",
  "icc-implementation_command_center",
  "im-preassignment-requests",
  "incident-comms",
  "nyric_im"
];

var WEEKLY_SUMMARY_CATEGORIES = [
  "Strategic & Leadership",
  "Technical Execution",
  "Blockers & Risk",
  "Team & Collaboration",
  "Learning & Growth"
];

var SLACK_KEYWORDS = ["technical", "decision", "blocker", "milestone", "shipped", "launched"];

var TAB_HEADERS = {
  "Meetings Registry": [
    "week_key", "date", "time", "title", "attendees", "key_points",
    "action_items", "source_links", "projects"
  ],
  "Action Items": [
    "week_key", "date", "item", "owner", "due", "status", "priority", "project", "from_source"
  ],
  "Slack Bookmarks": [
    "week_key", "timestamp", "channel", "message", "category", "suggested_action", "status", "confidence"
  ],
  "Weekly Summary": [
    "week_key", "category", "date", "bullet", "citation", "approved"
  ],
  "Projects & Goals": [
    "week_key", "project", "previous_completion", "detected_activity",
    "suggested_new_completion", "confidence", "last_progress_date"
  ],
  "Learning Evidence": [
    "date", "note", "applies_to", "week_key"
  ],
  "Run Log": [
    "ran_at", "week_key", "window", "meetings", "actions", "bookmarks", "projects", "ok", "notes"
  ]
};

// === PUBLIC ENTRYPOINTS ====================================================

function verifyWeeklyAccess() {
  var cfg = loadConfig_(true);
  var window = previousWedTueWindow_(new Date(), cfg.timezone);
  var ss = SpreadsheetApp.openById(cfg.sheetId);
  var report = {
    sheet_id: cfg.sheetId,
    sheet_name: ss.getName(),
    sheet_url: ss.getUrl(),
    window: window,
    timezone: cfg.timezone,
    slack_token_set: !!cfg.slackToken,
    anthropic_key_set: !!cfg.anthropicKey,
    review_email: cfg.reviewEmail || "(missing)",
    supernote_folder: folderReport_(cfg.supernoteFolderId),
    zoom_folder: folderReport_(cfg.zoomFolderId),
    generated_folder: folderReport_(cfg.generatedFolderId),
    existing_tabs: ss.getSheets().map(function (s) { return s.getName(); })
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function previewWeekWindow() {
  var cfg = loadConfig_(true);
  var window = previousWedTueWindow_(new Date(), cfg.timezone);
  console.log(JSON.stringify(window, null, 2));
  return window;
}

function ensureSheetSkeleton() {
  var cfg = loadConfig_(true);
  var ss = SpreadsheetApp.openById(cfg.sheetId);
  var created = [];
  Object.keys(TAB_HEADERS).forEach(function (tab) {
    var sheet = ss.getSheetByName(tab);
    if (!sheet) {
      sheet = ss.insertSheet(tab);
      created.push(tab);
    }
    var headers = TAB_HEADERS[tab];
    var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var blank = existing.every(function (c) { return String(c || "").trim() === ""; });
    if (blank) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  });
  console.log(JSON.stringify({ ok: true, created_tabs: created }, null, 2));
  return { ok: true, created_tabs: created };
}

/** Full pipeline for the latest closed Wed-Tue week. */
function runWeeklyWorkSummary() {
  var cfg = loadConfig_(false);
  ensureSheetSkeleton();
  var window = previousWedTueWindow_(new Date(), cfg.timezone);
  var result = runWeeklyForWindow_(cfg, window);
  console.log(JSON.stringify({
    ok: result.ok,
    week_key: window.week_key,
    stats: result.stats,
    email_sent: result.email_sent
  }, null, 2));
  return result;
}

function installWednesdayTrigger() {
  removeWednesdayTrigger();
  ScriptApp.newTrigger("runWeeklyWorkSummary")
    .timeBased()
    .inTimezone(PropertiesService.getScriptProperties().getProperty("TIMEZONE") || DEFAULT_TZ)
    .onWeekDay(ScriptApp.WeekDay.WEDNESDAY)
    .atHour(8)
    .nearMinute(37)
    .create();
  console.log("Installed Wednesday 8:37 AM trigger for runWeeklyWorkSummary");
  return { ok: true };
}

function removeWednesdayTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "runWeeklyWorkSummary") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  return { ok: true };
}

// === PIPELINE ==============================================================

function runWeeklyForWindow_(cfg, window) {
  var calendarEvents = pullCalendarEvents_(cfg, window);
  var supernote = pullLatestSupernote_(cfg);
  var slackMessages = pullSlackChannelMessages_(cfg, window);
  var slackBookmarks = pullSlackBookmarks_(cfg);
  var zoomFiles = listZoomExports_(cfg);
  var learning = loadLearningCorpus_(cfg);

  var prompt = buildSynthesisPrompt_(window, calendarEvents, supernote.text, slackMessages, slackBookmarks, zoomFiles, learning);
  var raw = callClaudeJson_(cfg, prompt);
  var normalized = normalizeSynthesis_(raw, window.week_key);

  writeWeekToSheet_(cfg, normalized);
  maybeDumpJson_(cfg, window.week_key, { window: window, normalized: normalized, raw: raw });

  var emailSent = false;
  if (cfg.reviewEmail) {
    MailApp.sendEmail({
      to: cfg.reviewEmail,
      subject: "Your weekly work summary is ready for review (" + window.week_key + ")",
      body: buildEmailBody_(normalized, SpreadsheetApp.openById(cfg.sheetId).getUrl(), window)
    });
    emailSent = true;
  }

  appendRunLog_(cfg, window, normalized, true, "ok");

  return {
    ok: true,
    week_key: window.week_key,
    window: window,
    stats: normalized.stats,
    email_sent: emailSent,
    sources: {
      calendar_events: calendarEvents.length,
      supernote_file: supernote.name || null,
      slack_messages: slackMessages.length,
      slack_bookmarks: slackBookmarks.length,
      zoom_files: zoomFiles.length
    }
  };
}

// === CONFIG ================================================================

function loadConfig_(allowMissingSecrets) {
  var p = PropertiesService.getScriptProperties();
  var slack = p.getProperty("SLACK_USER_TOKEN");
  var anth = p.getProperty("ANTHROPIC_API_KEY");
  if (!allowMissingSecrets) {
    if (!slack) throw new Error("Missing Script Property: SLACK_USER_TOKEN");
    if (!anth) throw new Error("Missing Script Property: ANTHROPIC_API_KEY");
  }
  var channelsRaw = p.getProperty("SLACK_CHANNEL_NAMES");
  var channels = channelsRaw
    ? channelsRaw.split(",").map(function (s) { return s.trim().replace(/^#/, ""); }).filter(Boolean)
    : DEFAULT_SLACK_CHANNELS.slice();
  return {
    sheetId: p.getProperty("WORK_TRACKING_SHEET_ID") || DEFAULT_SHEET_ID,
    timezone: p.getProperty("TIMEZONE") || DEFAULT_TZ,
    model: p.getProperty("CLAUDE_MODEL") || DEFAULT_MODEL,
    calendarId: p.getProperty("CALENDAR_ID") || DEFAULT_CALENDAR_ID,
    slackToken: slack || "",
    anthropicKey: anth || "",
    reviewEmail: p.getProperty("REVIEW_EMAIL") || "",
    supernoteFolderId: p.getProperty("SUPERNOTE_FOLDER_ID") || "",
    zoomFolderId: p.getProperty("ZOOM_EXPORTS_FOLDER_ID") || "",
    generatedFolderId: p.getProperty("GENERATED_FOLDER_ID") || "",
    channels: channels
  };
}

function folderReport_(id) {
  if (!id) return { set: false };
  try {
    var f = DriveApp.getFolderById(id);
    return { set: true, id: id, name: f.getName(), url: f.getUrl() };
  } catch (e) {
    return { set: true, id: id, error: String(e) };
  }
}

// === WEEK WINDOW ===========================================================

function previousWedTueWindow_(asOf, timezone) {
  // Build date parts in the configured timezone.
  var iso = Utilities.formatDate(asOf, timezone, "yyyy-MM-dd");
  var parts = iso.split("-");
  var today = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var weekday = today.getDay(); // Sun=0 ... Sat=6. Wed=3, Tue=2.
  var end;
  if (weekday === 3) {
    end = addDays_(today, -1); // Tuesday
  } else {
    var daysSinceTue = (weekday - 2 + 7) % 7;
    end = addDays_(today, -daysSinceTue);
  }
  var start = addDays_(end, -6);
  return {
    start: formatYmd_(start),
    end: formatYmd_(end),
    week_key: formatYmd_(start),
    label: formatYmd_(start) + " -> " + formatYmd_(end) + " (Wed-Tue)",
    startDate: start,
    endDate: end
  };
}

function addDays_(d, n) {
  var x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function formatYmd_(d) {
  return Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
}

function dayBounds_(ymd, timezone) {
  // Local midnight -> next midnight in timezone, returned as Date objects.
  var start = Utilities.parseDate(ymd + " 00:00:00", timezone, "yyyy-MM-dd HH:mm:ss");
  var endDay = addDays_(Utilities.parseDate(ymd + " 00:00:00", "UTC", "yyyy-MM-dd HH:mm:ss"), 1);
  var endYmd = formatYmd_(endDay);
  var end = Utilities.parseDate(endYmd + " 00:00:00", timezone, "yyyy-MM-dd HH:mm:ss");
  return { start: start, end: end };
}

// === CALENDAR ==============================================================

function pullCalendarEvents_(cfg, window) {
  var cal = cfg.calendarId === "primary"
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(cfg.calendarId);
  var startBound = dayBounds_(window.start, cfg.timezone).start;
  // Inclusive end-of-Tuesday: start of next day after end
  var endBound = dayBounds_(window.end, cfg.timezone).end;
  var events = cal.getEvents(startBound, endBound);
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    out.push({
      date: Utilities.formatDate(e.getStartTime(), cfg.timezone, "yyyy-MM-dd"),
      time: e.isAllDayEvent()
        ? "all-day"
        : Utilities.formatDate(e.getStartTime(), cfg.timezone, "HH:mm") +
          "-" +
          Utilities.formatDate(e.getEndTime(), cfg.timezone, "HH:mm"),
      title: e.getTitle(),
      attendees: e.getGuestList().map(function (g) { return g.getEmail(); }),
      description: truncate_(e.getDescription() || "", 1500),
      location: e.getLocation() || ""
    });
  }
  return out;
}

// === DRIVE: SUPERNOTE + ZOOM ===============================================

function pullLatestSupernote_(cfg) {
  if (!cfg.supernoteFolderId) return { name: "", text: "" };
  var folder = DriveApp.getFolderById(cfg.supernoteFolderId);
  var files = folder.getFiles();
  var newest = null;
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName().toLowerCase();
    if (!(name.indexOf(".pdf") !== -1 || f.getMimeType() === MimeType.PDF ||
          f.getMimeType().indexOf("text") !== -1 || name.indexOf(".md") !== -1 ||
          name.indexOf(".txt") !== -1)) {
      continue;
    }
    if (!newest || f.getLastUpdated().getTime() > newest.getLastUpdated().getTime()) {
      newest = f;
    }
  }
  if (!newest) return { name: "", text: "" };
  return { name: newest.getName(), text: extractDriveText_(newest) };
}

function listZoomExports_(cfg) {
  if (!cfg.zoomFolderId) return [];
  var folder = DriveApp.getFolderById(cfg.zoomFolderId);
  var files = folder.getFiles();
  var out = [];
  while (files.hasNext()) {
    var f = files.next();
    out.push({
      name: f.getName(),
      id: f.getId(),
      url: f.getUrl(),
      mimeType: f.getMimeType(),
      updated: f.getLastUpdated().toISOString()
    });
  }
  return out;
}

function extractDriveText_(file) {
  var mime = file.getMimeType();
  try {
    if (mime === MimeType.PDF || /\.pdf$/i.test(file.getName())) {
      // Best-effort: convert via Drive advanced service when available
      if (typeof Drive !== "undefined" && Drive.Files) {
        var resource = {
          title: file.getName() + " (ocr-temp)",
          mimeType: MimeType.GOOGLE_DOCS
        };
        var blob = file.getBlob();
        var docFile = Drive.Files.insert(resource, blob, { convert: true, ocr: true });
        var doc = DocumentApp.openById(docFile.id);
        var text = doc.getBody().getText();
        DriveApp.getFileById(docFile.id).setTrashed(true);
        return truncate_(text, 80000);
      }
      return "(PDF present: " + file.getName() + " - enable Drive advanced service + OCR for text extraction)";
    }
    return truncate_(file.getBlob().getDataAsString("UTF-8"), 80000);
  } catch (e) {
    return "(Could not extract text from " + file.getName() + ": " + e + ")";
  }
}

// === SLACK =================================================================

function pullSlackChannelMessages_(cfg, window) {
  if (!cfg.slackToken) return [];
  var oldest = String(Math.floor(dayBounds_(window.start, cfg.timezone).start.getTime() / 1000));
  var latest = String(Math.floor(dayBounds_(window.end, cfg.timezone).end.getTime() / 1000));
  var channelMap = resolveSlackChannels_(cfg.slackToken, cfg.channels);
  var all = [];
  Object.keys(channelMap).forEach(function (name) {
    var id = channelMap[name];
    var msgs = conversationsHistory_(cfg.slackToken, id, oldest, latest);
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.subtype && m.subtype !== "thread_broadcast") continue;
      var text = m.text || "";
      if (!text) continue;
      var lower = text.toLowerCase();
      var hit = SLACK_KEYWORDS.some(function (k) { return lower.indexOf(k) !== -1; });
      // Keep keyword hits; also keep a light sample of other messages (first 30/channel)
      if (!hit && i > 30) continue;
      all.push({
        channel: name,
        ts: m.ts,
        datetime: slackTsToIso_(m.ts),
        user: m.user || "",
        text: text,
        keyword_hit: hit
      });
    }
  });
  return all;
}

function pullSlackBookmarks_(cfg) {
  if (!cfg.slackToken) return [];
  // Prefer saved items / bookmarks; fall back to stars.
  var out = [];
  try {
    var data = slackGet_(cfg.slackToken, "https://slack.com/api/bookmarks.list?channel_id=");
    // workspace bookmarks.list needs a channel; try stars.list instead for user saved items
  } catch (e) {}
  try {
    var stars = slackGet_(cfg.slackToken, "https://slack.com/api/stars.list?limit=100");
    if (stars.ok) {
      var items = stars.items || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var msg = (it.message && it.message.text) || (it.file && it.file.name) || "";
        var channel = (it.channel) || (it.message && it.message.channel) || "";
        out.push({
          timestamp: it.message && it.message.ts ? slackTsToIso_(it.message.ts) : "",
          channel: channel,
          message: msg,
          category_hint: categorizeBookmark_(msg)
        });
      }
    }
  } catch (e2) {}
  return out;
}

function resolveSlackChannels_(token, names) {
  var map = {};
  var cursor = "";
  var wanted = {};
  names.forEach(function (n) { wanted[n.replace(/^#/, "")] = true; });
  do {
    var url = "https://slack.com/api/conversations.list?limit=200&types=public_channel,private_channel";
    if (cursor) url += "&cursor=" + encodeURIComponent(cursor);
    var data = slackGet_(token, url);
    if (!data.ok) throw new Error("conversations.list failed: " + (data.error || "unknown"));
    (data.channels || []).forEach(function (ch) {
      if (wanted[ch.name]) map[ch.name] = ch.id;
    });
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || "";
  } while (cursor && Object.keys(map).length < names.length);
  return map;
}

function conversationsHistory_(token, channelId, oldest, latest) {
  var messages = [];
  var cursor = "";
  do {
    var url =
      "https://slack.com/api/conversations.history?channel=" +
      encodeURIComponent(channelId) +
      "&oldest=" + encodeURIComponent(oldest) +
      "&latest=" + encodeURIComponent(latest) +
      "&limit=200";
    if (cursor) url += "&cursor=" + encodeURIComponent(cursor);
    var data = slackGet_(token, url);
    if (!data.ok) break;
    messages = messages.concat(data.messages || []);
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || "";
  } while (cursor);
  return messages;
}

function slackGet_(token, url) {
  var resp = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + token },
    muteHttpExceptions: true
  });
  return JSON.parse(resp.getContentText());
}

function slackTsToIso_(ts) {
  if (!ts) return "";
  var seconds = parseFloat(String(ts).split(".")[0]);
  if (!seconds) return String(ts);
  return new Date(seconds * 1000).toISOString();
}

function categorizeBookmark_(text) {
  var t = String(text || "").toLowerCase();
  if (/(todo|action|please|need to|follow up|follow-up|assign)/.test(t)) return "Action Item";
  if (/(block|stuck|blocked|risk|sev|incident)/.test(t)) return "Blocker";
  if (/(ship|launch|milestone|progress|deploy|release)/.test(t)) return "Project Update";
  if (/(team|collab|sync|huddle|offsite)/.test(t)) return "Team News";
  return "FYI / Reference";
}

// === LEARNING ==============================================================

function loadLearningCorpus_(cfg) {
  var ss = SpreadsheetApp.openById(cfg.sheetId);
  var lines = ["# Learning examples (mimic tone, citation style, category mix)", ""];
  var summary = ss.getSheetByName("Weekly Summary");
  if (summary && summary.getLastRow() > 1) {
    var values = summary.getDataRange().getValues();
    var headers = values[0].map(function (h) { return String(h).toLowerCase(); });
    var idx = {
      week: headers.indexOf("week_key"),
      cat: headers.indexOf("category"),
      bullet: headers.indexOf("bullet"),
      cite: headers.indexOf("citation"),
      approved: headers.indexOf("approved")
    };
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var approved = String(row[idx.approved] || "").toUpperCase();
      if (approved !== "TRUE" && approved !== "YES" && approved !== "Y" && approved !== "1") continue;
      lines.push(
        "- [" + (row[idx.cat] || "") + "] (" + (row[idx.week] || "") + ") " +
          (row[idx.bullet] || "") + " - cite: " + (row[idx.cite] || "")
      );
    }
  }
  var evidence = ss.getSheetByName("Learning Evidence");
  if (evidence && evidence.getLastRow() > 1) {
    lines.push("", "# Explicit evidence / corrections from the human", "");
    var ev = evidence.getDataRange().getValues();
    for (var i = 1; i < ev.length; i++) {
      if (!String(ev[i][1] || "").trim()) continue;
      lines.push(
        "- " + (ev[i][0] || "") + ": " + (ev[i][1] || "") +
          " (applies to: " + (ev[i][2] || "general") + ")"
      );
    }
  }
  return lines.join("\n") + "\n";
}

// === CLAUDE ================================================================

function buildSynthesisPrompt_(window, calendarEvents, supernoteText, slackMessages, slackBookmarks, zoomFiles, learningCorpus) {
  return (
    "You are a professional work synthesis and project tracking AI for a ParentSquare product/implementation leader.\n\n" +
    "WEEK WINDOW (Wed-Tue): " + window.label + "\n" +
    "WEEK_KEY: " + window.week_key + "\n\n" +
    "CHANNELS MONITORED: " + DEFAULT_SLACK_CHANNELS.map(function (c) { return "#" + c; }).join(", ") + "\n\n" +
    "LEARN FROM THESE PRIOR APPROVED EXAMPLES AND CORRECTIONS - match tone, category balance, citation specificity, and what the human keeps vs deletes:\n" +
    learningCorpus + "\n" +
    "ANALYZE THIS WEEK'S DATA AND RETURN STRICT JSON WITH KEYS:\n" +
    "1. meetings_registry: [{date, time, title, attendees, key_points, action_items, source_links, projects_mentioned}]\n" +
    "2. action_items: [{date, item, owner, due, status, priority, project, from_source}]\n" +
    "3. slack_bookmarks_categorized: [{timestamp, channel, message, category, suggested_action, confidence}]\n" +
    "4. project_progress: [{project, previous_completion, detected_activity, suggested_new_completion, confidence}]\n" +
    "5. weekly_synthesis: [{category, date, bullet, citation}] categories: " +
      WEEKLY_SUMMARY_CATEGORIES.join(" | ") + "\n" +
    "6. stats: {total_meetings, total_action_items, bookmarks_categorized, projects_with_progress}\n\n" +
    "Every weekly_synthesis bullet MUST include a dated, citable reference. Do not invent sources.\n" +
    "RETURN ONLY VALID JSON. NO MARKDOWN OR PREAMBLE.\n\n" +
    "CALENDAR EVENTS:\n" + JSON.stringify(calendarEvents).slice(0, 100000) + "\n\n" +
    "SUPERNOTE MEETING NOTES:\n" + (supernoteText || "(none)") + "\n\n" +
    "SLACK MESSAGES:\n" + JSON.stringify(slackMessages).slice(0, 100000) + "\n\n" +
    "SLACK BOOKMARKS:\n" + JSON.stringify(slackBookmarks).slice(0, 50000) + "\n\n" +
    "ZOOM FILES:\n" + JSON.stringify(zoomFiles).slice(0, 20000) + "\n"
  );
}

function callClaudeJson_(cfg, userPrompt) {
  var resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": cfg.anthropicKey,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify({
      model: cfg.model,
      max_tokens: 8192,
      temperature: 0.2,
      messages: [{ role: "user", content: userPrompt + "\n\nRespond with JSON only." }]
    }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var raw = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error("Claude API HTTP " + code + ": " + truncate_(raw, 1000));
  }
  var data = JSON.parse(raw);
  var text = "";
  (data.content || []).forEach(function (c) {
    if (c.type === "text") text += c.text;
  });
  return parseJsonLoose_(text);
}

function parseJsonLoose_(text) {
  var s = String(text || "").trim();
  var fenceTicks = String.fromCharCode(96, 96, 96);
  var fence = s.match(new RegExp(fenceTicks + "(?:json)?\\s*([\\s\\S]*?)" + fenceTicks, "i"));
  if (fence) s = fence[1].trim();
  var start = s.indexOf("{");
  var end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1) s = s.substring(start, end + 1);
  return JSON.parse(s);
}

function normalizeSynthesis_(obj, weekKey) {
  obj = obj || {};
  var meetings = (obj.meetings_registry || []).map(function (m) {
    m = m || {};
    return {
      week_key: weekKey,
      date: m.date || "",
      time: m.time || "",
      title: m.title || "",
      attendees: join_(m.attendees),
      key_points: join_(m.key_points),
      action_items: join_(m.action_items),
      source_links: join_(m.source_links),
      projects: join_(m.projects_mentioned || m.projects)
    };
  });
  var actions = (obj.action_items || []).map(function (a) {
    a = a || {};
    return {
      week_key: weekKey,
      date: a.date || "",
      item: a.item || a.task || "",
      owner: a.owner || "",
      due: a.due || "",
      status: a.status || "open",
      priority: a.priority || "",
      project: a.project || "",
      from_source: a.from_source || a.source || ""
    };
  });
  var bookmarks = (obj.slack_bookmarks_categorized || []).map(function (b) {
    b = b || {};
    var msg = b.message || b.text || "";
    return {
      week_key: weekKey,
      timestamp: b.timestamp || b.date || "",
      channel: String(b.channel || "").replace(/^#/, ""),
      message: msg,
      category: b.category || categorizeBookmark_(msg),
      suggested_action: b.suggested_action || "",
      confidence: b.confidence || "",
      status: b.status || "new"
    };
  });
  var synthesis = (obj.weekly_synthesis || []).map(function (s) {
    s = s || {};
    var cat = s.category || "Technical Execution";
    if (WEEKLY_SUMMARY_CATEGORIES.indexOf(cat) === -1) cat = "Technical Execution";
    return {
      week_key: weekKey,
      category: cat,
      date: s.date || weekKey,
      bullet: s.bullet || s.text || "",
      citation: s.citation || s.source || "",
      approved: ""
    };
  });
  var projects = (obj.project_progress || []).map(function (p) {
    p = p || {};
    return {
      week_key: weekKey,
      project: p.project || p.name || "",
      previous_completion: p.previous_completion || "",
      detected_activity: join_(p.detected_activity),
      suggested_new_completion: p.suggested_new_completion || "",
      confidence: p.confidence || "",
      last_progress_date: weekKey
    };
  });
  var stats = obj.stats || {};
  return {
    week_key: weekKey,
    meetings_registry: meetings,
    action_items: actions,
    slack_bookmarks: bookmarks,
    weekly_synthesis: synthesis,
    project_progress: projects,
    stats: {
      total_meetings: stats.total_meetings != null ? stats.total_meetings : meetings.length,
      total_action_items: stats.total_action_items != null ? stats.total_action_items : actions.length,
      bookmarks_categorized: stats.bookmarks_categorized != null ? stats.bookmarks_categorized : bookmarks.length,
      projects_with_progress: stats.projects_with_progress != null ? stats.projects_with_progress : projects.length
    }
  };
}

// === SHEET WRITES (idempotent by week_key) =================================

function writeWeekToSheet_(cfg, normalized) {
  var ss = SpreadsheetApp.openById(cfg.sheetId);
  replaceWeekRows_(ss, "Meetings Registry", normalized.week_key, normalized.meetings_registry.map(meetingRow_));
  replaceWeekRows_(ss, "Action Items", normalized.week_key, normalized.action_items.map(actionRow_));
  replaceWeekRows_(ss, "Slack Bookmarks", normalized.week_key, normalized.slack_bookmarks.map(bookmarkRow_));
  replaceWeekRows_(ss, "Weekly Summary", normalized.week_key, normalized.weekly_synthesis.map(summaryRow_));
  replaceWeekRows_(ss, "Projects & Goals", normalized.week_key, normalized.project_progress.map(projectRow_));
}

function meetingRow_(r) {
  return [r.week_key, r.date, r.time, r.title, r.attendees, r.key_points, r.action_items, r.source_links, r.projects];
}
function actionRow_(r) {
  return [r.week_key, r.date, r.item, r.owner, r.due, r.status, r.priority, r.project, r.from_source];
}
function bookmarkRow_(r) {
  return [r.week_key, r.timestamp, r.channel, r.message, r.category, r.suggested_action, r.status, r.confidence];
}
function summaryRow_(r) {
  return [r.week_key, r.category, r.date, r.bullet, r.citation, r.approved];
}
function projectRow_(r) {
  return [r.week_key, r.project, r.previous_completion, r.detected_activity, r.suggested_new_completion, r.confidence, r.last_progress_date];
}

function replaceWeekRows_(ss, tabName, weekKey, rows) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return;
  var width = Math.max(sheet.getLastColumn(), (TAB_HEADERS[tabName] || []).length, 1);
  var lastRow = sheet.getLastRow();
  var keep = [];
  if (lastRow >= 2) {
    // getRange(row, column, lastRow, lastColumn) - corner form
    var data = sheet.getRange(2, 1, lastRow, width).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) !== String(weekKey)) keep.push(data[i]);
    }
    sheet.getRange(2, 1, lastRow, width).clearContent();
  }
  var out = keep.concat(rows || []);
  if (out.length) {
    sheet.getRange(2, 1, 1 + out.length, out[0].length).setValues(out);
  }
}

function appendRunLog_(cfg, window, normalized, ok, notes) {
  var ss = SpreadsheetApp.openById(cfg.sheetId);
  var sheet = ss.getSheetByName("Run Log");
  if (!sheet) return;
  sheet.appendRow([
    Utilities.formatDate(new Date(), cfg.timezone, "yyyy-MM-dd HH:mm:ss"),
    window.week_key,
    window.label,
    normalized.stats.total_meetings,
    normalized.stats.total_action_items,
    normalized.stats.bookmarks_categorized,
    normalized.stats.projects_with_progress,
    ok ? "TRUE" : "FALSE",
    notes || ""
  ]);
}

function maybeDumpJson_(cfg, weekKey, payload) {
  if (!cfg.generatedFolderId) return;
  try {
    var folder = DriveApp.getFolderById(cfg.generatedFolderId);
    var name = "weekly-summary-" + weekKey + ".json";
    var blob = Utilities.newBlob(JSON.stringify(payload, null, 2), "application/json", name);
    var existing = folder.getFilesByName(name);
    while (existing.hasNext()) existing.next().setTrashed(true);
    folder.createFile(blob);
  } catch (e) {
    // non-fatal
  }
}

function buildEmailBody_(normalized, sheetUrl, window) {
  var stats = normalized.stats || {};
  return (
    "Your weekly work summary is ready for review.\n\n" +
    "Window: " + window.label + "\n" +
    "Meetings: " + (stats.total_meetings || 0) + "\n" +
    "Action items: " + (stats.total_action_items || 0) + "\n" +
    "Bookmarks categorized: " + (stats.bookmarks_categorized || 0) + "\n" +
    "Projects with progress: " + (stats.projects_with_progress || 0) + "\n\n" +
    "Sheet: " + sheetUrl + "\n\n" +
    "Please review the Weekly Summary tab. Mark approved=TRUE on bullets you keep, " +
    "edit freely, and add notes to Learning Evidence - next week will learn from those.\n"
  );
}

// === UTILS =================================================================

function join_(value) {
  if (value == null) return "";
  if (Object.prototype.toString.call(value) === "[object Array]") {
    return value.map(function (v) { return String(v).trim(); }).filter(Boolean).join("; ");
  }
  return String(value).trim();
}

function truncate_(s, n) {
  s = String(s || "");
  return s.length > n ? s.substring(0, n) + "..." : s;
}
