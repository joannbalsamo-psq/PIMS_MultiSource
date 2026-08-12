/**
 * === PIMS Slack -> Obsidian vault ==========================================
 *
 * Automates the Cowork flow that kept losing files when the vault folder was
 * renamed (PSQ IMP -> PIMS) or when Drive created "(1)" duplicates:
 *
 *   Phase 1  - pull #implementation-team history -> analysis markdown
 *   Phase 2  - build/update topic notes into the Obsidian vault on Drive
 *   Cleanup  - trash duplicate "(1)" files/folders + optional stale roots
 *
 * Critical reliability rules:
 *   1. Vault root is ALWAYS resolved by Drive folder ID (Script Property),
 *      never by folder name - renames are safe.
 *   2. Notes are upserted by exact filename. Re-runs update in place and
 *      never create "Note (1).md".
 *   3. cleanupVaultDuplicates() repairs prior Cowork/Drive mishaps.
 *
 * Setup: SETUP.txt in this folder.
 */

// --- Defaults (override via Script Properties) -----------------------------
// Obsidian vault root on Drive. Pinned by ID so renaming the folder
// (PSQ IMP -> PIMS) never breaks the automation.
var DEFAULT_VAULT_FOLDER_ID = "1SVDcQubc8NcWYHAxLhjSHnchdOS5wZoz"; // PIMS
var DEFAULT_CHANNEL_ID = "C04CZ6CVD2B"; // #implementation-team
var DEFAULT_CHANNEL_NAME = "implementation-team";
var DEFAULT_TZ = "America/New_York";
var DEFAULT_MODEL = "claude-sonnet-4-20250514";
var DEFAULT_MAX_MESSAGES = 5000;
var DEFAULT_CHUNK_CHARS = 90000;
var DEFAULT_STALE_ROOTS = "PSQ IMP,PSQ IMP (1),PIMS (1)";

// Mirrors the live PIMS vault. The vault on Drive is the source of truth —
// if a folder is renamed there, change it here too or the script will create
// a parallel folder instead of writing into the existing one.
var DEFAULT_FOLDER_TREE = [
  "00 - Start Here",
  "01 - SIS Integrations",
  "02 - SFTP & File Format Reference",
  "03 - SSO & Authentication",
  "04 - Core Product Features",
  "05 - Data & Sync Troubleshooting",
  "06 - Implementation Process & Playbooks",
  "07 - Known Issues & Tribal Knowledge Register",
  "08 - Internal Tools",
  "09 - Glossary & FAQ",
  "10 - Regional & Regulatory Specifics",
  "11 - Subject Matter Experts Directory",
  "12 - Raw Source Materials"
];

// Where generated notes land when Claude does not name a valid folder.
var FOLDER_DEFAULT = "07 - Known Issues & Tribal Knowledge Register";
var FOLDER_SME = "11 - Subject Matter Experts Directory";
var FOLDER_DOC_GAPS = "07 - Known Issues & Tribal Knowledge Register";
var FOLDER_SLACK_DIGESTS = "07 - Known Issues & Tribal Knowledge Register/Slack Channel Digests";

// === PUBLIC ENTRYPOINTS ====================================================

/**
 * Run this first. Confirms the vault ID resolves and the tokens are present,
 * without writing anything.
 */
function verifyVaultAccess() {
  var p = PropertiesService.getScriptProperties();
  var vaultId = p.getProperty("PIMS_VAULT_FOLDER_ID") || DEFAULT_VAULT_FOLDER_ID;
  var report = {
    vault_folder_id: vaultId,
    used_default: !p.getProperty("PIMS_VAULT_FOLDER_ID"),
    slack_token_set: !!p.getProperty("SLACK_USER_TOKEN"),
    anthropic_key_set: !!p.getProperty("ANTHROPIC_API_KEY")
  };
  var folder = DriveApp.getFolderById(vaultId);
  report.vault_folder_name = folder.getName();
  report.vault_url = folder.getUrl();

  var subfolders = [];
  var it = folder.getFolders();
  while (it.hasNext()) subfolders.push(it.next().getName());
  subfolders.sort();
  report.existing_subfolders = subfolders;

  var files = [];
  var fit = folder.getFiles();
  while (fit.hasNext()) files.push(fit.next().getName());
  files.sort();
  report.root_files = files;

  console.log(JSON.stringify(report, null, 2));
  return report;
}

/** Phase 1 only - analysis note, no topic articles. */
function runPhase1Analysis() {
  var result = runPhase1_({});
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Phase 2 - ensure skeleton + write/update topic notes from Phase 1 corpus. */
function runPhase2BuildVault() {
  var result = runPhase2_({});
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Full pipeline: Phase 1 then Phase 2. */
function runFullPimsPipeline() {
  var p1 = runPhase1_({});
  var p2 = runPhase2_({ reuseMessages: p1.messages || null, analysis: p1.analysis || null });
  var out = { ok: true, phase1: p1, phase2: p2 };
  console.log(JSON.stringify({ ok: true, phase1_stats: p1.stats, phase2_stats: p2.stats }, null, 2));
  return out;
}

/**
 * Trash Drive/Finder-style duplicates inside the vault (and optional stale
 * sibling folders next to the vault, e.g. leftover "PSQ IMP" after rename).
 */
function cleanupVaultDuplicates() {
  var cfg = loadConfig_();
  var vault = DriveApp.getFolderById(cfg.vaultFolderId);
  var report = { trashed: [], kept_roots: [], scanned_folders: 0 };

  trashDuplicatesInFolderRecursive_(vault, report);

  if (cfg.cleanupParentId) {
    var parent = DriveApp.getFolderById(cfg.cleanupParentId);
    var stale = cfg.staleRootNames;
    var folders = parent.getFolders();
    while (folders.hasNext()) {
      var f = folders.next();
      var name = f.getName();
      if (isDuplicateName_(name) || stale.indexOf(name) !== -1) {
        // Never trash the live vault itself.
        if (f.getId() === cfg.vaultFolderId) continue;
        f.setTrashed(true);
        report.trashed.push("sibling-folder:" + name);
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  return report;
}

/** Create folder tree + Welcome / Vault Guide / empty Source Register. */
function bootstrapVaultSkeleton() {
  var cfg = loadConfig_();
  var vault = DriveApp.getFolderById(cfg.vaultFolderId);
  ensureFolderTree_(vault);
  var start = ensureChildFolder_(vault, "00 - Start Here");
  var register = [];
  register.push(upsertMarkdown_(start, "Welcome.md", welcomeMarkdown_(), "bootstrap"));
  register.push(upsertMarkdown_(start, "Vault Guide.md", vaultGuideMarkdown_(), "bootstrap"));
  register.push(
    upsertMarkdown_(
      start,
      "Source Register.md",
      sourceRegisterMarkdown_([] , cfg.channelName),
      "bootstrap"
    )
  );
  console.log("Vault skeleton ready under folder " + cfg.vaultFolderId);
  return { ok: true, register: register };
}

// === PHASE IMPLEMENTATIONS =================================================

function runPhase1_(opts) {
  opts = opts || {};
  var cfg = loadConfig_();
  var vault = DriveApp.getFolderById(cfg.vaultFolderId);
  ensureFolderTree_(vault);
  var start = ensureChildFolder_(vault, "00 - Start Here");
  var raw = ensureChildFolder_(vault, "12 - Raw Source Materials");

  var messages =
    opts.reuseMessages ||
    pullChannelHistory_(cfg.slackToken, cfg.channelId, cfg.maxMessages);
  var analysis = opts.analysis || analyzeChannelPhase1_(cfg, messages);

  var md = renderPhase1Markdown_(analysis, cfg);
  var write = upsertMarkdown_(start, "Phase 1 Analysis - Implementation Intelligence.md", md, "phase1");

  // Compact corpus snapshot for audit (not the full dump if huge).
  var corpusPreview = formatMessageCorpus_(messages.slice(-200));
  upsertMarkdown_(
    raw,
    "implementation-team-corpus-tail.md",
    "# Corpus tail (latest 200 messages)\n\n```\n" + corpusPreview + "\n```\n",
    "phase1-raw"
  );

  appendSourceRegister_(start, cfg.channelName, [
    {
      path: "00 - Start Here/Phase 1 Analysis - Implementation Intelligence.md",
      updated: Utilities.formatDate(new Date(), cfg.timezone, "yyyy-MM-dd HH:mm"),
      action: write.action,
      notes: "messages=" + messages.length
    }
  ]);

  return {
    ok: true,
    stats: {
      messages: messages.length,
      topics: (analysis.topics || []).length,
      action: write.action
    },
    analysis: analysis,
    messages: messages,
    write: write
  };
}

function runPhase2_(opts) {
  opts = opts || {};
  var cfg = loadConfig_();
  var vault = DriveApp.getFolderById(cfg.vaultFolderId);
  ensureFolderTree_(vault);
  var start = ensureChildFolder_(vault, "00 - Start Here");

  // Prefer bootstrap notes present.
  bootstrapVaultSkeleton();

  var messages =
    opts.reuseMessages ||
    pullChannelHistory_(cfg.slackToken, cfg.channelId, cfg.maxMessages);
  var analysis = opts.analysis || readExistingPhase1JsonHint_(start) || analyzeChannelPhase1_(cfg, messages);
  var notes = generatePhase2Notes_(cfg, messages, analysis);

  var registerEntries = [];
  var created = 0;
  var updated = 0;
  for (var i = 0; i < notes.length; i++) {
    var n = notes[i];
    var folderPath = n.folder || FOLDER_DEFAULT;
    var folder = ensureFolderPath_(vault, folderPath);
    var fileName = noteFilename_(n.title);
    var body = renderTopicNoteMarkdown_(n, cfg.channelName);
    var w = upsertMarkdown_(folder, fileName, body, "phase2");
    if (w.action === "create") created++;
    else updated++;
    registerEntries.push({
      path: folderPath + "/" + fileName,
      updated: Utilities.formatDate(new Date(), cfg.timezone, "yyyy-MM-dd HH:mm"),
      action: w.action,
      notes: n.confidence || ""
    });
  }

  appendSourceRegister_(start, cfg.channelName, registerEntries);

  return {
    ok: true,
    stats: { notes: notes.length, created: created, updated: updated },
    register: registerEntries
  };
}

// === CONFIG ================================================================

function loadConfig_() {
  var p = PropertiesService.getScriptProperties();
  var vaultId = p.getProperty("PIMS_VAULT_FOLDER_ID") || DEFAULT_VAULT_FOLDER_ID;
  var staleRaw = p.getProperty("STALE_ROOT_NAMES") || DEFAULT_STALE_ROOTS;
  return {
    vaultFolderId: vaultId,
    cleanupParentId: p.getProperty("VAULT_PARENT_FOLDER_ID") || "",
    staleRootNames: staleRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean),
    slackToken: requiredProp_("SLACK_USER_TOKEN"),
    anthropicKey: requiredProp_("ANTHROPIC_API_KEY"),
    channelId: p.getProperty("SLACK_CHANNEL_ID") || DEFAULT_CHANNEL_ID,
    channelName: (p.getProperty("SLACK_CHANNEL_NAME") || DEFAULT_CHANNEL_NAME).replace(/^#/, ""),
    timezone: p.getProperty("TIMEZONE") || DEFAULT_TZ,
    model: p.getProperty("CLAUDE_MODEL") || DEFAULT_MODEL,
    maxMessages: parseInt(p.getProperty("MAX_MESSAGES") || String(DEFAULT_MAX_MESSAGES), 10),
    chunkChars: parseInt(p.getProperty("CHUNK_CHARS") || String(DEFAULT_CHUNK_CHARS), 10),
    phase2NoteLimit: parseInt(p.getProperty("PHASE2_NOTE_LIMIT") || "40", 10)
  };
}

function requiredProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error("Missing Script Property: " + key);
  return v;
}

// === SLACK HISTORY =========================================================

function pullChannelHistory_(token, channelId, maxMessages) {
  var messages = [];
  var cursor = "";
  do {
    var url =
      "https://slack.com/api/conversations.history?channel=" +
      encodeURIComponent(channelId) +
      "&limit=200";
    if (cursor) url += "&cursor=" + encodeURIComponent(cursor);
    var data = slackGet_(token, url);
    if (!data.ok) {
      throw new Error("conversations.history failed: " + (data.error || "unknown"));
    }
    var batch = data.messages || [];
    for (var i = 0; i < batch.length; i++) {
      var m = batch[i];
      if (m.subtype && m.subtype !== "thread_broadcast") continue;
      messages.push({
        ts: m.ts,
        user: m.user || m.bot_id || "",
        text: m.text || "",
        thread_ts: m.thread_ts || ""
      });
      if (messages.length >= maxMessages) break;
    }
    cursor = (data.response_metadata && data.response_metadata.next_cursor) || "";
  } while (cursor && messages.length < maxMessages);

  // conversations.history is newest-first; reverse to chronological.
  messages.reverse();

  // Resolve user ids -> display names (best-effort).
  var userMap = slackUserMap_(token, messages);
  for (var j = 0; j < messages.length; j++) {
    messages[j].user_name = userMap[messages[j].user] || messages[j].user || "unknown";
    messages[j].datetime = slackTsToIso_(messages[j].ts);
  }
  return messages;
}

function slackUserMap_(token, messages) {
  var ids = {};
  for (var i = 0; i < messages.length; i++) {
    if (messages[i].user) ids[messages[i].user] = true;
  }
  var map = {};
  var keys = Object.keys(ids);
  for (var k = 0; k < keys.length; k++) {
    var id = keys[k];
    if (id.indexOf("B") === 0 || id.indexOf("U") !== 0) continue;
    try {
      var data = slackGet_(token, "https://slack.com/api/users.info?user=" + encodeURIComponent(id));
      if (data.ok && data.user) {
        map[id] =
          (data.user.profile && (data.user.profile.display_name || data.user.profile.real_name)) ||
          data.user.name ||
          id;
      }
    } catch (e) {
      // ignore individual lookup failures
    }
  }
  return map;
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

// === CLAUDE ================================================================

function analyzeChannelPhase1_(cfg, messages) {
  var batches = chunkMessages_(messages, cfg.chunkChars);
  var partials = [];
  for (var i = 0; i < batches.length; i++) {
    var corpus = formatMessageCorpus_(batches[i]);
    var prompt =
      "You are analyzing ParentSquare Implementation Manager Slack channel #" +
      cfg.channelName +
      " (batch " +
      (i + 1) +
      "/" +
      batches.length +
      ").\n" +
      "Extract durable technical acumen - troubleshooting, SIS knowledge, best practices, tips, " +
      "recurring questions, tribal knowledge, doc gaps, SMEs.\n" +
      "Ignore pure social chatter and one-off scheduling.\n" +
      "Return STRICT JSON with keys:\n" +
      "topics (array of {title, why_it_matters, confidence}),\n" +
      "recurring_questions (array of {question, context}),\n" +
      "struggles (array of {area, why}),\n" +
      "tribal_knowledge (array of {title, detail}),\n" +
      "doc_gaps (array of {gap, detail}),\n" +
      "smes (array of {name, specialty, evidence}),\n" +
      "product_sis_frequency (array of {name, count, notes}),\n" +
      "executive_summary (string).\n\n" +
      "MESSAGES:\n" +
      corpus;
    partials.push(callClaudeJson_(cfg, prompt));
  }
  if (partials.length === 1) {
    partials[0].channel = cfg.channelName;
    partials[0].generated = Utilities.formatDate(new Date(), cfg.timezone, "yyyy-MM-dd");
    partials[0].folder_structure = DEFAULT_FOLDER_TREE.slice();
    return partials[0];
  }
  var mergePrompt =
    "Merge these partial JSON analyses of the same Slack channel into ONE consolidated Phase 1 report.\n" +
    "Dedupe topics, rank the top ~50 topics by implementation value, keep ~25 recurring questions,\n" +
    "union SMEs, sum product/SIS counts where possible, keep confidence honest.\n" +
    "Return STRICT JSON with the same keys as the inputs plus folder_structure " +
    "(array of suggested Obsidian folder names).\n\n" +
    "PARTIALS:\n" +
    JSON.stringify(partials);
  var merged = callClaudeJson_(cfg, mergePrompt);
  merged.channel = cfg.channelName;
  merged.generated = Utilities.formatDate(new Date(), cfg.timezone, "yyyy-MM-dd");
  if (!merged.folder_structure || !merged.folder_structure.length) {
    merged.folder_structure = DEFAULT_FOLDER_TREE.slice();
  }
  return merged;
}

function generatePhase2Notes_(cfg, messages, analysis) {
  var batches = chunkMessages_(messages, cfg.chunkChars);
  // Use analysis topics as the outline; ask Claude for notes in batches of topics.
  var topics = (analysis && analysis.topics) || [];
  var notes = [];
  var topicChunkSize = 8;
  for (var t = 0; t < topics.length && notes.length < cfg.phase2NoteLimit; t += topicChunkSize) {
    var slice = topics.slice(t, t + topicChunkSize);
    // Attach a sample of corpus (latest batch) - full history already shaped Phase 1.
    var corpus = formatMessageCorpus_(batches[batches.length - 1] || []);
    var prompt =
      "Write Obsidian markdown topic notes for a ParentSquare Implementation knowledge vault (PIMS).\n" +
      "Use the topic list below. Prefer durable how-to / troubleshooting / SIS guidance.\n" +
      "Each note must map to ONE folder from this tree:\n" +
      JSON.stringify(DEFAULT_FOLDER_TREE) +
      "\n" +
      "Return STRICT JSON: { notes: [ { title, folder, summary, body, tags, sources, related, confidence } ] }\n" +
      "body should be markdown sections (What / Steps / Gotchas). sources may be empty if unknown.\n" +
      "Do not invent Slack permalinks.\n\n" +
      "TOPICS:\n" +
      JSON.stringify(slice) +
      "\n\nSAMPLE MESSAGES:\n" +
      corpus +
      "\n\nPHASE1 STRUGGLES/TRIBAL/GAPS (context):\n" +
      JSON.stringify({
        struggles: (analysis && analysis.struggles) || [],
        tribal_knowledge: (analysis && analysis.tribal_knowledge) || [],
        doc_gaps: (analysis && analysis.doc_gaps) || []
      });
    var obj = callClaudeJson_(cfg, prompt);
    var batchNotes = obj.notes || obj.topic_notes || [];
    for (var i = 0; i < batchNotes.length; i++) {
      notes.push(normalizeNote_(batchNotes[i], cfg.channelName));
      if (notes.length >= cfg.phase2NoteLimit) break;
    }
  }

  // Always materialize SME + doc-gap index notes even if topic generation is thin.
  if (analysis && analysis.smes && analysis.smes.length) {
    notes.push(
      normalizeNote_(
        {
          title: "SME directory",
          folder: FOLDER_SME,
          summary: "People who repeatedly unblocked IMs in-channel.",
          body: renderListBody_(analysis.smes, "name", "specialty"),
          tags: ["sme"],
          confidence: "high"
        },
        cfg.channelName
      )
    );
  }
  if (analysis && analysis.doc_gaps && analysis.doc_gaps.length) {
    notes.push(
      normalizeNote_(
        {
          title: "Documentation gaps",
          folder: FOLDER_DOC_GAPS,
          summary: "Gaps surfaced from channel history.",
          body: renderListBody_(analysis.doc_gaps, "gap", "detail"),
          tags: ["gaps"],
          confidence: "medium"
        },
        cfg.channelName
      )
    );
  }
  return dedupeNotesByPath_(notes).slice(0, cfg.phase2NoteLimit + 5);
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
  var content = data.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === "text") text += content[i].text;
  }
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

// === DRIVE / OBSIDIAN WRITES ===============================================

function ensureFolderTree_(vault) {
  for (var i = 0; i < DEFAULT_FOLDER_TREE.length; i++) {
    ensureChildFolder_(vault, DEFAULT_FOLDER_TREE[i]);
  }
}

/** Resolve (creating as needed) a slash-separated path under the vault. */
function ensureFolderPath_(vault, path) {
  var parts = String(path || "").split("/");
  var current = vault;
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;
    current = ensureChildFolder_(current, part);
  }
  return current;
}

function ensureChildFolder_(parent, name) {
  var matches = [];
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) matches.push(it.next());

  // Trash duplicate-suffixed siblings that canonicalize to this name.
  var all = parent.getFolders();
  while (all.hasNext()) {
    var f = all.next();
    var n = f.getName();
    if (isDuplicateName_(n) && canonicalName_(n) === name) {
      f.setTrashed(true);
    }
  }

  if (matches.length) {
    for (var i = 1; i < matches.length; i++) matches[i].setTrashed(true);
    return matches[0];
  }
  return parent.createFolder(name);
}

/**
 * Idempotent markdown write. Never creates "name (1).md".
 * Uses Advanced Drive service when available to update binary/text files;
 * falls back to trash+create.
 */
function upsertMarkdown_(folder, fileName, content, reason) {
  fileName = String(fileName || "").trim();
  if (!fileName) throw new Error("fileName required");

  var exact = [];
  var it = folder.getFilesByName(fileName);
  while (it.hasNext()) exact.push(it.next());

  // Trash Drive-style duplicates for this canonical name.
  var all = folder.getFiles();
  while (all.hasNext()) {
    var f = all.next();
    var n = f.getName();
    if (isDuplicateName_(n) && canonicalName_(n) === fileName) {
      f.setTrashed(true);
    }
  }

  var blob = Utilities.newBlob(content, "text/markdown", fileName);

  if (exact.length) {
    var target = exact[0];
    for (var i = 1; i < exact.length; i++) exact[i].setTrashed(true);
    updateFileContent_(target, blob);
    return { action: "update", id: target.getId(), name: fileName, reason: reason || "" };
  }

  var created;
  if (typeof Drive !== "undefined" && Drive.Files) {
    // Drive advanced service (v2)
    var resource = {
      title: fileName,
      mimeType: "text/markdown",
      parents: [{ id: folder.getId() }]
    };
    created = Drive.Files.insert(resource, blob, { convert: false });
    return { action: "create", id: created.id, name: fileName, reason: reason || "" };
  }

  var file = folder.createFile(blob);
  // Ensure extension/name stick
  if (file.getName() !== fileName) file.setName(fileName);
  return { action: "create", id: file.getId(), name: fileName, reason: reason || "" };
}

function updateFileContent_(file, blob) {
  if (typeof Drive !== "undefined" && Drive.Files) {
    Drive.Files.update({ mimeType: "text/markdown", title: file.getName() }, file.getId(), blob);
    return;
  }
  // Fallback: trash + recreate in same parent (path-stable for Obsidian).
  var parents = file.getParents();
  var parent = parents.hasNext() ? parents.next() : null;
  var name = file.getName();
  file.setTrashed(true);
  if (parent) {
    var created = parent.createFile(blob);
    if (created.getName() !== name) created.setName(name);
  }
}

function appendSourceRegister_(startFolder, channelName, entries) {
  var existingText = "";
  var files = startFolder.getFilesByName("Source Register.md");
  if (files.hasNext()) {
    existingText = readTextFile_(files.next());
  }
  var merged = mergeRegisterEntries_(existingText, entries, channelName);
  upsertMarkdown_(startFolder, "Source Register.md", merged, "register");
}

function readTextFile_(file) {
  try {
    return file.getBlob().getDataAsString("UTF-8");
  } catch (e) {
    return "";
  }
}

function mergeRegisterEntries_(existingText, entries, channelName) {
  var rows = [];
  var seen = {};
  // Keep prior rows (simple table parse).
  var lines = String(existingText || "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("| `") === 0) {
      var cells = line.split("|").map(function (c) { return c.trim(); });
      // ['', path, updated, action, notes, '']
      if (cells.length >= 5 && cells[1]) {
        var path = cells[1].replace(/^`/, "").replace(/`$/, "");
        seen[path] = {
          path: path,
          updated: cells[2] || "",
          action: cells[3] || "",
          notes: cells[4] || ""
        };
      }
    }
  }
  for (var j = 0; j < (entries || []).length; j++) {
    var e = entries[j];
    seen[e.path] = e;
  }
  var keys = Object.keys(seen).sort();
  for (var k = 0; k < keys.length; k++) rows.push(seen[keys[k]]);
  return sourceRegisterMarkdown_(rows, channelName);
}

function trashDuplicatesInFolderRecursive_(folder, report) {
  report.scanned_folders++;
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (isDuplicateName_(file.getName())) {
      file.setTrashed(true);
      report.trashed.push(folder.getName() + "/" + file.getName());
    }
  }
  var folders = folder.getFolders();
  while (folders.hasNext()) {
    var child = folders.next();
    if (isDuplicateName_(child.getName())) {
      child.setTrashed(true);
      report.trashed.push(folder.getName() + "/" + child.getName() + "/");
      continue;
    }
    trashDuplicatesInFolderRecursive_(child, report);
  }
}

function readExistingPhase1JsonHint_(startFolder) {
  // We don't persist JSON separately; returning null forces re-analysis unless caller passes it.
  return null;
}

// === RENDERERS (keep in sync with vault_helpers.py) ========================

function renderPhase1Markdown_(analysis, cfg) {
  var a = analysis || {};
  var parts = [];
  parts.push("---");
  parts.push("type: phase1-analysis");
  parts.push("channel: " + (a.channel || cfg.channelName));
  parts.push("generated: " + (a.generated || Utilities.formatDate(new Date(), cfg.timezone, "yyyy-MM-dd")));
  parts.push("---");
  parts.push("");
  parts.push("# Phase 1 Analysis - Implementation Intelligence");
  parts.push("");
  parts.push(String(a.executive_summary || "").trim());
  parts.push("");
  parts.push("## Top topics (ranked)");
  parts.push("");
  var topics = a.topics || [];
  for (var i = 0; i < topics.length; i++) {
    var t = topics[i] || {};
    var conf = t.confidence ? " _(confidence: " + t.confidence + ")_" : "";
    parts.push((i + 1) + ". **" + (t.title || t.name || "Topic") + "** - " + (t.why_it_matters || t.summary || "") + conf);
  }
  parts.push("");
  parts.push("## Recurring questions");
  parts.push("");
  appendBulletDicts_(parts, a.recurring_questions, "question", "context");
  parts.push("## Where IMs struggle (and why)");
  parts.push("");
  appendBulletDicts_(parts, a.struggles, "area", "why");
  parts.push("## Tribal knowledge");
  parts.push("");
  appendBulletDicts_(parts, a.tribal_knowledge, "title", "detail");
  parts.push("## Documentation gaps");
  parts.push("");
  appendBulletDicts_(parts, a.doc_gaps, "gap", "detail");
  parts.push("## SMEs / who to ask");
  parts.push("");
  var smes = a.smes || [];
  for (var s = 0; s < smes.length; s++) {
    var sm = smes[s] || {};
    parts.push(
      "- **" +
        (sm.name || sm.person || "SME") +
        "** - " +
        (sm.specialty || sm.topics || "") +
        " (" +
        (sm.evidence || "channel activity") +
        ")"
    );
  }
  parts.push("");
  parts.push("## Product / SIS frequency");
  parts.push("");
  var freq = a.product_sis_frequency || a.sis_frequency || [];
  for (var p = 0; p < freq.length; p++) {
    var item = freq[p] || {};
    parts.push(
      "- **" +
        (item.name || item.product || "Item") +
        "** - mentions: " +
        (item.count || item.mentions || "?") +
        " - " +
        (item.notes || "")
    );
  }
  parts.push("");
  parts.push("## Candidate Obsidian folder structure");
  parts.push("");
  var folders = a.folder_structure && a.folder_structure.length ? a.folder_structure : DEFAULT_FOLDER_TREE;
  for (var f = 0; f < folders.length; f++) parts.push("- `" + folders[f] + "`");
  parts.push("");
  return parts.join("\n");
}

function renderTopicNoteMarkdown_(note, channelName) {
  var n = note || {};
  var tags = n.tags || [];
  var tagLine = "";
  if (typeof tags === "string") tagLine = tags;
  else {
    var bits = [];
    for (var i = 0; i < tags.length; i++) {
      var t = String(tags[i] || "").trim();
      if (t) bits.push("#" + t.replace(/^#/, ""));
    }
    tagLine = bits.join(" ");
  }
  var parts = [];
  parts.push("---");
  parts.push("type: " + (n.type || "implementation-knowledge"));
  parts.push("folder: " + (n.folder || ""));
  parts.push("confidence: " + (n.confidence || ""));
  parts.push("channel: " + (n.channel || channelName));
  parts.push("---");
  parts.push("");
  parts.push("# " + sanitizeNoteTitle_(n.title));
  parts.push("");
  if (tagLine) {
    parts.push(tagLine);
    parts.push("");
  }
  if (n.summary) {
    parts.push(String(n.summary).trim());
    parts.push("");
  }
  parts.push(String(n.body || "").trim());
  parts.push("");
  var sources = n.sources || [];
  if (sources.length) {
    parts.push("## Sources");
    parts.push("");
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      if (src && typeof src === "object") {
        parts.push(
          "- [" +
            (src.label || "Slack") +
            "](" +
            (src.url || "") +
            ") - " +
            (src.quote || "")
        );
      } else {
        parts.push("- " + src);
      }
    }
    parts.push("");
  }
  var related = n.related || [];
  if (related.length) {
    parts.push("## Related");
    parts.push("");
    for (var r = 0; r < related.length; r++) {
      if (String(related[r] || "").trim()) parts.push("- [[" + related[r] + "]]");
    }
    parts.push("");
  }
  return parts.join("\n");
}

function sourceRegisterMarkdown_(entries, channelName) {
  var parts = [];
  parts.push("---");
  parts.push("type: source-register");
  parts.push("channel: " + channelName);
  parts.push("---");
  parts.push("");
  parts.push("# Source Register");
  parts.push("");
  parts.push(
    "Tracks what the automation wrote into this vault. Safe to re-run - notes are upserted by exact path, never duplicated as `(1)` copies."
  );
  parts.push("");
  parts.push("| Path | Updated | Action | Notes |");
  parts.push("|---|---|---|---|");
  for (var i = 0; i < (entries || []).length; i++) {
    var e = entries[i];
    parts.push(
      "| `" +
        (e.path || "") +
        "` | " +
        (e.updated || "") +
        " | " +
        (e.action || "") +
        " | " +
        (e.notes || "") +
        " |"
    );
  }
  parts.push("");
  return parts.join("\n");
}

function vaultGuideMarkdown_() {
  var parts = [];
  parts.push("---");
  parts.push("type: vault-guide");
  parts.push("---");
  parts.push("");
  parts.push("# Vault Guide - PIMS");
  parts.push("");
  parts.push("This vault is maintained by the `pims_slack_to_obsidian` Apps Script.");
  parts.push("");
  parts.push("## Rules that prevent Claude/Cowork file loss");
  parts.push("");
  parts.push(
    "1. The vault root is pinned by **Google Drive folder ID**, not folder name. Renaming `PSQ IMP` -> `PIMS` is safe."
  );
  parts.push(
    "2. Notes are **upserted** by exact filename inside each folder. Re-runs update in place and never create `Note (1).md`."
  );
  parts.push("3. Run `cleanupVaultDuplicates` after any manual Drive copy/paste mishap.");
  parts.push("4. Phase 1 writes analysis only; Phase 2 builds/updates topic notes.");
  parts.push("");
  parts.push("## Folder map");
  parts.push("");
  for (var i = 0; i < DEFAULT_FOLDER_TREE.length; i++) {
    parts.push("- `" + DEFAULT_FOLDER_TREE[i] + "/`");
  }
  parts.push("");
  return parts.join("\n");
}

function welcomeMarkdown_() {
  return [
    "---",
    "type: welcome",
    "---",
    "",
    "# Welcome - ParentSquare Implementation Knowledge (PIMS)",
    "",
    "Technical acumen distilled from `#implementation-team` and related IM channels, organized for Obsidian.",
    "",
    "Start at [[Phase 1 Analysis - Implementation Intelligence]] and the [[Source Register]].",
    ""
  ].join("\n");
}

// === SMALL UTILS ===========================================================

function sanitizeNoteTitle_(name) {
  var cleaned = String(name || "")
    .replace(/[\/\\:\*\?"<>\|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  return cleaned || "Untitled note";
}

function noteFilename_(title) {
  return sanitizeNoteTitle_(title) + ".md";
}

function isDuplicateName_(name) {
  name = String(name || "").trim();
  return /^.+?\s+\(\d+\)(?:\.[A-Za-z0-9]+)?$/.test(name);
}

function canonicalName_(name) {
  name = String(name || "").trim();
  var m = name.match(/^(.*?)(?:\s+\((\d+)\))(\.[A-Za-z0-9]+)?$/);
  if (!m) return name;
  return (m[1] || "").replace(/\s+$/, "") + (m[3] || "");
}

function chunkMessages_(messages, maxChars) {
  var batches = [];
  var current = [];
  var size = 0;
  for (var i = 0; i < messages.length; i++) {
    var piece = String((messages[i] && messages[i].text) || "").length + 48;
    if (current.length && size + piece > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(messages[i]);
    size += piece;
  }
  if (current.length) batches.push(current);
  return batches;
}

function formatMessageCorpus_(messages) {
  var lines = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i] || {};
    var text = String(m.text || "").replace(/\n/g, " ").trim();
    if (!text) continue;
    lines.push(
      "[" +
        (m.datetime || m.ts || "") +
        "] " +
        (m.user_name || m.user || "unknown") +
        ": " +
        text
    );
  }
  return lines.join("\n");
}

function normalizeNote_(n, channelName) {
  n = n || {};
  var title = sanitizeNoteTitle_(n.title || n.name);
  var folder = String(n.folder || FOLDER_DEFAULT).trim();
  return {
    title: title,
    folder: folder,
    type: n.type || "implementation-knowledge",
    confidence: n.confidence || "",
    summary: n.summary || "",
    body: n.body || n.content || "",
    tags: n.tags || [],
    sources: n.sources || [],
    related: n.related || [],
    channel: n.channel || channelName
  };
}

function dedupeNotesByPath_(notes) {
  var seen = {};
  var out = [];
  for (var i = 0; i < notes.length; i++) {
    var key = (notes[i].folder || "") + "/" + noteFilename_(notes[i].title);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(notes[i]);
  }
  return out;
}

function renderListBody_(items, titleKey, detailKey) {
  var lines = [];
  for (var i = 0; i < (items || []).length; i++) {
    var it = items[i] || {};
    if (typeof it === "string") {
      lines.push("- " + it);
    } else {
      lines.push("- **" + (it[titleKey] || it.title || "Item") + "** - " + (it[detailKey] || it.detail || ""));
    }
  }
  return lines.join("\n");
}

function appendBulletDicts_(parts, items, titleKey, detailKey) {
  items = items || [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (typeof it === "string") parts.push("- " + it);
    else
      parts.push(
        "- **" +
          ((it && (it[titleKey] || it.title || it.q)) || "Item") +
          "** - " +
          ((it && (it[detailKey] || it.detail || it.notes || it.context)) || "")
      );
  }
  parts.push("");
}

function truncate_(s, n) {
  s = String(s || "");
  return s.length > n ? s.substring(0, n) + "..." : s;
}
