// ---------------------------------------------------------------------------
// Reads the cover letter's per-application details straight out of the
// pasted ad (2 Oct 2026). Derin, verbatim: "I don't want to manually fill
// the details in the cover letter... I will only paste the job description
// and that will mostly have all the info you'll need. In case you don't
// find, alert... that you didn't find the company name or any other
// similar information."
//
// Pure: text in, findings out. Never touches the DOM - js/app.js fills the
// form fields from this and raises the "not found" alerts. Every finding
// carries `from`, the ad's own text it was read from, so the UI can show
// where each value came from instead of asking to be trusted.
//
// Two strictness levels, matching how js/letterbuild.js already treats the
// fields:
//
//   company, role, city - the letter's free-entry slots. Read from the ad,
//     then tidied for use inside a sentence: "WTW (Willis Towers Watson)"
//     -> "WTW", "Ornua Co-operative Limited" -> "Ornua", "Pensions
//     administrator" -> "Pensions Administrator", "Customer Service
//     Representative (Night shift)" -> "Customer Service Representative",
//     "Dublin, County Dublin, Ireland" -> "Dublin". `raw` keeps the ad's
//     untidied text. These are slot values typed per application, not
//     claims about Derin - the same values he used to type by hand.
//
//   team, recipientName, startDate - must appear word for word in the ad
//     (validateTeam / validateRecipientName / validateStartDate block the
//     download otherwise), so each is only ever returned as an exact
//     substring of the ad, never tidied or reworded.
//
// Nothing found means null - never a guess. Ambiguity resolves to null too
// (e.g. a "contact" phrase followed by something that isn't clearly a
// person's name), because a wrong auto-filled value costs more than an
// empty field with an alert next to it.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  // --- Vocabulary ------------------------------------------------------------
  // Words that make a short line look like a job title. Whole-word,
  // case-insensitive. Deliberately broad: a title line is only ever chosen
  // from the short header lines at the top of an ad, never from prose.
  var ROLE_NOUNS = [
    "accountant", "administrator", "admin", "adviser", "advisor", "agent", "analyst",
    "apprentice", "apprenticeship", "architect", "assessor", "assistant", "associate",
    "attendant", "auditor", "banker", "barista", "bookkeeper", "buyer", "cashier",
    "chef", "clerk", "coach", "consultant", "controller", "coordinator", "co-ordinator",
    "counsel", "crew", "designer", "developer", "director", "driver", "economist",
    "editor", "engineer", "executive", "fellow", "graduate", "graduates", "handler",
    "head", "inspector", "intern", "internship", "investigator", "lead", "lawyer",
    "lecturer", "manager", "marketer", "mechanic", "nurse", "officer", "operative",
    "operator", "paralegal", "partner", "placement", "planner", "porter", "processor",
    "producer", "programme", "program", "receptionist", "recruiter", "representative",
    "researcher", "scientist", "secretary", "solicitor", "specialist", "staff",
    "steward", "strategist", "student", "supervisor", "support", "teacher", "technician",
    "teller", "tester", "trainee", "underwriter", "worker", "writer"
  ];
  // Not after a hyphen: "Co-operative" is not an "operative".
  var ROLE_NOUN_RE = new RegExp("(?<![\\w-])(" + ROLE_NOUNS.map(escapeRe).join("|") + ")(?![\\w-])", "i");

  // Ireland first (where Derin applies), then the larger cities an ad from
  // an international employer is likely to name. Canonical spelling is what
  // ends up in the letter's City line.
  var CITIES = [
    "Dublin", "Cork", "Galway", "Limerick", "Waterford", "Kilkenny", "Drogheda",
    "Dundalk", "Swords", "Bray", "Navan", "Ennis", "Tralee", "Carlow", "Naas",
    "Athlone", "Letterkenny", "Sligo", "Wexford", "Clonmel", "Mullingar", "Portlaoise",
    "Newbridge", "Balbriggan", "Celbridge", "Maynooth", "Leixlip", "Shannon",
    "Killarney", "Castlebar", "Tullamore", "Arklow", "Cobh", "Midleton", "Mallow",
    "Ballina", "Longford", "Cavan", "Monaghan", "Dungarvan", "Wicklow", "Greystones",
    "Ashbourne", "Blanchardstown", "Tallaght", "Sandyford", "Dun Laoghaire",
    "Dún Laoghaire", "Citywest", "Clonee", "Carrigtwohill", "Ringaskiddy", "Belfast",
    "Derry", "Londonderry", "Newry", "Lisburn",
    "London", "Manchester", "Birmingham", "Leeds", "Glasgow", "Edinburgh", "Bristol",
    "Liverpool", "Cardiff", "Amsterdam", "Rotterdam", "Brussels", "Luxembourg", "Paris",
    "Berlin", "Munich", "Frankfurt", "Hamburg", "Madrid", "Barcelona", "Lisbon",
    "Milan", "Rome", "Zurich", "Geneva", "Vienna", "Warsaw", "Krakow", "Prague",
    "Copenhagen", "Stockholm", "Oslo", "Helsinki", "Dubai", "Abu Dhabi", "Singapore",
    "Sydney", "Melbourne", "Toronto", "New York", "Boston", "San Francisco", "Chicago"
  ];
  // Longest first so "Dun Laoghaire" wins over a shorter overlapping name.
  var CITY_RE = new RegExp("\\b(" + CITIES.slice().sort(function (a, b) { return b.length - a.length; }).map(escapeRe).join("|") + ")\\b");
  var CITY_CANON = {};
  CITIES.forEach(function (c) { CITY_CANON[c.toLowerCase()] = c; });
  CITY_CANON["dún laoghaire"] = "Dún Laoghaire";
  CITY_CANON["londonderry"] = "Derry";

  // Header lines that are site furniture, not information about the job.
  var JUNK_LINE_RE = new RegExp("^(?:" + [
    "skip to (?:main )?content", "apply(?: now)?(?: for this job)?(?: \\W)?", "easy apply", "quick apply",
    "save(?: job| this job)?", "saved", "share(?: this job| job)?", "back(?: to (?:search|jobs|results|all jobs))?",
    "sign in", "sign up", "log ?in", "register", "menu", "home", "careers?", "jobs", "search(?: for)? jobs", "job search",
    "find (?:a )?jobs?", "job openings", "open positions", "all jobs", "jobs for you", "candidate home",
    "join (?:our )?talent (?:community|network)", "introduce yourself",
    "view all jobs", "see all (?:jobs|roles)", "similar jobs", "report (?:this )?job", "print", "email(?: this job)?",
    "apply on company (?:site|website)", "i'?m interested", "show (?:more|less)", "see (?:more|less)",
    "message", "follow", "following", "promoted(?: by hirer)?", "reposted.*", "posted.*", "actively (?:recruiting|hiring)",
    "be an early applicant", ".*\\bapplicants?", "new", "featured", "urgent(?:ly hiring)?", "hiring", "job details",
    "create (?:job )?alert", "get job alerts", "my profile", "how we hire", "our benefits", "our group",
    "career streams", "see all roles", "job alert.*", "select how often.*", "modify cookie preferences",
    "(?:reject|accept) all cookies", "cookie (?:settings|preferences)", "manage cookies", "close"
  ].join("|") + ")\\s*[»›>]*$", "i");
  var COOKIE_RE = /\bcookies?\b|\bconsent\b|privacy (?:policy|notice|settings)/i;

  // Lines that open the description proper - the header block (title,
  // company, location) sits above the first of these.
  var DESCRIPTION_HEADING_RE = /^(?:about (?:the )?(?:job|role|position|opportunity|vacancy)|(?:full )?job description|description|role description|overview|position overview|role overview|job summary|summary|the role|the opportunity|responsibilities|key responsibilities|requirements|qualifications|about you|who we are|what you(?:'|’)ll do|your role)\s*:?$/i;

  // A line that only states the contract/schedule/pay, not a title or name.
  var META_LINE_RE = /^(?:full[- ]?time|part[- ]?time|permanent|temporary|contract|fixed[- ]term|internship|hybrid|remote|on-?site|in[- ]office|flexible|graduate|entry[- ]level|mid[- ]senior level|associate|not applicable|ref\b.*|reference\b.*|req(?:uisition)?\b.*|job (?:id|ref|number)\b.*|salary\b.*|negotiable|competitive|day shift|night shift|shift work|\d+ (?:days|weeks|months) ago|today|yesterday|closing date\b.*|.*\b(?:per annum|per year|a year|an hour|per hour|p\.a\.)\b.*|[€£$].*)$/i;

  var LABEL_TITLE_RE = /^(?:job title|title|position|position title|role|role title|vacancy|job)\s*:\s*(.+)$/i;
  var LABEL_TITLE_ALONE_RE = /^(?:job title|position title|role title)\s*:?$/i;
  var LABEL_COMPANY_RE = /^(?:company|company name|employer|organi[sz]ation|hiring (?:company|organi[sz]ation)|client)\s*:\s*(.+)$/i;
  var LABEL_COMPANY_ALONE_RE = /^(?:company|company name|employer|organi[sz]ation|hiring (?:company|organi[sz]ation))\s*:?$/i;
  var LABEL_LOCATION_RE = /^(?:locations?|job location|work location|office location|location\(s\)|city|based in|workplace location|primary location)\s*:\s*(.+)$/i;
  var LABEL_LOCATION_ALONE_RE = /^(?:locations?|job location|work location|office location|location\(s\)|city|primary location)\s*:?$/i;
  var LABEL_START_RE = /^(?:start date|starting date|commencement date|expected start date|anticipated start date|start)\s*:\s*(.+)$/i;
  var LABEL_START_ALONE_RE = /^(?:start date|starting date|commencement date|expected start date|anticipated start date)\s*:?$/i;
  var LABEL_CONTACT_RE = /^(?:recruiter|contact|contact person|contact name|hiring manager|recruitment contact|talent (?:acquisition )?(?:partner|specialist|contact)|point of contact)\s*:\s*(.+)$/i;

  var LEGAL_SUFFIX_RE = /(?:,?\s+(?:limited|ltd\.?|dac|d\.a\.c\.|plc|p\.l\.c\.|inc\.?|incorporated|llc|llp|lp|gmbh|ag|s\.a\.|sa|se|n\.v\.|nv|b\.v\.|bv|unlimited company|designated activity company|uc|co-operative society limited))+\s*$/i;
  // Parenthetical qualifiers that belong to the listing, not the job title.
  var TITLE_QUALIFIER_RE = /\b(?:shift|nights?|days|hybrid|remote|on-?site|office|full[- ]?time|part[- ]?time|temp(?:orary)?|contract|ftc|fixed|months?|maternity|paternity|cover|permanent|m\/f|f\/m|w\/m|m\/w|d\/f|f\/d|x\/f|intake|start|20\d\d|fy\d\d|immediate|weekend|weekday|flexible|\d+\s*hours?)\b/i;
  var SMALL_WORDS = { a: 1, an: 1, and: 1, as: 1, at: 1, but: 1, by: 1, for: 1, in: 1, of: 1, on: 1, or: 1, the: 1, to: 1, with: 1, via: 1, per: 1 };
  var NOT_A_COMPANY = /^(?:us|our|the company|company|the team|team|the role|role|you|your|job|the job|position|this role|this position|description|overview|benefits|careers|the group|group|the firm|firm|hiring team|ireland|europe)$/i;
  var NOT_A_NAME_WORD = /^(?:the|our|your|team|talent|acquisition|recruitment|recruiting|human|resources|hr|people|careers?|hiring|manager|customer|service|services|support|sales|dublin|cork|ireland|irish|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|us|me|apply|now|today|top|decision|executives?|clients?|candidates?|information|details|more|further)$/i;
  var HR_TEAM_WORD = /\b(?:recruit\w*|talent|acquisition|hr|human resources|people|careers?|hiring|candidate|accessibility|resourcing|onboarding|payroll)\b/i;
  var TEAM_AFTER_STOP = /^(?:lead|leader|leads|leaders|manager|managers|member|members|player|players|building|vision|spirit|environment|culture|meetings?|events?|structure|size|working|work|based|located|leadership|management)\b/i;

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // --- Text preparation ------------------------------------------------------
  // Analysis runs on a de-HTML'd, entity-decoded copy (some job sites paste
  // raw markup). Verbatim fields are always re-checked against the ORIGINAL
  // text before being returned, so this copy can never leak a value that
  // isn't really in what Derin pasted.
  function decodeEntities(s) {
    return String(s)
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
      .replace(/&ldquo;|&rdquo;/gi, '"')
      .replace(/&ndash;/gi, "–")
      .replace(/&mdash;/gi, "—")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); });
  }
  function toPlain(raw) {
    var s = String(raw || "");
    if (/<\/?(?:p|div|br|li|ul|ol|span|strong|b|i|em|h\d|section|table|tr|td)\b/i.test(s)) {
      s = s.replace(/<\s*(?:br|\/p|\/div|\/li|\/h\d|\/tr|li|p|div|h\d)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
    }
    return decodeEntities(s).replace(/\r\n?/g, "\n").replace(/[ \t ]+/g, " ");
  }
  function linesOf(plain) {
    return plain.split("\n").map(function (l) { return l.trim(); });
  }
  function isJunk(line) {
    if (!line) return true;
    if (JUNK_LINE_RE.test(line)) return true;
    if (COOKIE_RE.test(line) && line.length > 25) return true;
    return false;
  }
  function wordCount(line) {
    return line.split(/\s+/).filter(Boolean).length;
  }
  function inAd(raw, value) {
    return !!value && String(raw).toLowerCase().indexOf(String(value).toLowerCase()) !== -1;
  }
  function countWord(plain, phrase) {
    if (!phrase) return 0;
    var re = new RegExp("(^|[^\\w])" + escapeRe(phrase) + "(?![\\w])", "g");
    var n = 0;
    while (re.exec(plain)) n++;
    return n;
  }

  // The short lines above the first description heading - where job sites
  // put the title, company and location. Capped, so a long ad's body is
  // never mistaken for a header.
  function headerZone(lines) {
    var out = [];
    for (var i = 0; i < lines.length && out.length < 40; i++) {
      var l = lines[i];
      if (!l) continue;
      if (DESCRIPTION_HEADING_RE.test(l) && out.length) break;
      if (l.length > 160) {
        if (out.length >= 3) break;
        continue;
      }
      out.push({ text: l, index: i });
    }
    return out;
  }

  // Label on its own line, value on the next real line ("Location:" then
  // "Dublin, IE") - Workday/SuccessFactors layout - or "Label: value".
  function findLabelled(lines, sameLineRe, aloneRe) {
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l) continue;
      var m = sameLineRe.exec(l);
      if (m && m[1] && m[1].trim()) return { value: m[1].trim(), line: l };
      if (aloneRe && aloneRe.test(l)) {
        for (var j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          if (lines[j]) return { value: lines[j], line: l + " " + lines[j] };
        }
      }
    }
    return null;
  }
  function findAllLabelled(lines, sameLineRe, aloneRe) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l) continue;
      var m = sameLineRe.exec(l);
      if (m && m[1] && m[1].trim()) { out.push({ value: m[1].trim(), line: l, index: i }); continue; }
      if (aloneRe && aloneRe.test(l)) {
        for (var j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          if (lines[j]) { out.push({ value: lines[j], line: l + " " + lines[j], index: j }); break; }
        }
      }
    }
    return out;
  }

  // --- City ------------------------------------------------------------------
  function cityIn(text) {
    var s = String(text || "");
    if (/\bD\d{2}\s?[A-Z0-9]{4}\b/.test(s) || /\bDublin\s+\d{1,2}\b/.test(s)) return "Dublin";
    var m = CITY_RE.exec(s);
    if (!m) {
      // Case-insensitive second pass ("DUBLIN", "dublin, ie").
      var lower = s.toLowerCase();
      for (var i = 0; i < CITIES.length; i++) {
        var re = new RegExp("\\b" + escapeRe(CITIES[i].toLowerCase()) + "\\b");
        if (re.test(lower)) return CITY_CANON[CITIES[i].toLowerCase()] || CITIES[i];
      }
      return null;
    }
    return CITY_CANON[m[1].toLowerCase()] || m[1];
  }
  function looksLikeLocationLine(line) {
    var first = line.split(/\s+·\s+|\s+\|\s+/)[0];
    if (wordCount(first) > 8) return false;
    if (!cityIn(first)) return false;
    // "Dublin", "Cork, Ireland", "Galway, Republic of Ireland",
    // "Dublin, County Dublin, Ireland", "Dublin, IE, D02 H638",
    // "Dublin (Hybrid)", "Dublin or Cork".
    return /^[A-Za-zÀ-ÿ'’. -]+(?:\s*(?:,|\/|or|and|\(|-)\s*[A-Za-zÀ-ÿ0-9'’. ()-]+)*\)?$/.test(first);
  }
  function citiesMentioned(plain) {
    var seen = {};
    var out = [];
    var re = new RegExp(CITY_RE.source, "g");
    var m;
    while ((m = re.exec(plain)) !== null) {
      // Where the company is headquartered, or its list of offices round
      // the world, says nothing about where this job is.
      // Same sentence only; "U.S., U.K., Finland" is not a sentence break.
      var windowStart = Math.max(plain.lastIndexOf("\n", m.index) + 1, m.index - 300);
      var lead = plain.slice(windowStart, m.index).split(/[.!?]\s+(?=[A-Z])/).pop();
      if (/\b(?:headquartered|headquarters|head office|HQ|parent company|offices (?:in|across|around)|locations (?:in|across)|founded)\b/i.test(lead)) continue;
      var c = CITY_CANON[m[1].toLowerCase()] || m[1];
      if (!seen[c]) { seen[c] = true; out.push(c); }
    }
    if (!seen.Dublin && (/\bD\d{2}\s?[A-Z0-9]{4}\b/.test(plain))) out.push("Dublin");
    return out;
  }
  function findCity(lines, header, plain) {
    var labelled = findAllLabelled(lines, LABEL_LOCATION_RE, LABEL_LOCATION_ALONE_RE);
    for (var i = 0; i < labelled.length; i++) {
      var c = cityIn(labelled[i].value);
      if (c) return { value: c, from: labelled[i].line, how: "label" };
      if (/remote/i.test(labelled[i].value)) return { value: null, from: labelled[i].line, how: "remote" };
    }
    for (var h = 0; h < header.length; h++) {
      var l = header[h].text;
      if (looksLikeLocationLine(l)) return { value: cityIn(l.split(/\s+·\s+|\s+\|\s+/)[0]), from: l, how: "header" };
    }
    var body = [
      /\b(?:based|located) (?:in|at|out of) (?:our |the )?((?:[A-Z][\w'’-]+[ ,]*){1,4})/,
      /\b(?:in|at|from|into|join) our ((?:[A-Z][\w'’-]+ ){1,3})(?:office|offices|hub|headquarters|HQ|site|campus|city centre)\b/,
      /\b((?:[A-Z][\w'’-]+ ){1,3})(?:office|offices|headquarters|HQ|city centre)\b/,
      /\b(?:office|offices) in ((?:[A-Z][\w'’-]+[ ,]*){1,3})/
    ];
    for (var b = 0; b < body.length; b++) {
      var re = new RegExp(body[b].source, "g");
      var m;
      while ((m = re.exec(plain)) !== null) {
        var city = cityIn(m[1]);
        if (city) return { value: city, from: m[0].trim(), how: "body" };
      }
    }
    // Last resort: the ad names exactly one city anywhere. Two or more and
    // there is no telling which is the office - left empty, and the UI
    // says which cities were seen.
    var all = citiesMentioned(plain);
    if (all.length === 1) {
      var at = plain.search(new RegExp("\\b" + escapeRe(all[0]) + "\\b"));
      var from = at >= 0 ? plain.slice(Math.max(0, at - 40), at + all[0].length + 30).replace(/\s+/g, " ").trim() : all[0];
      return { value: all[0], from: "…" + from + "…", how: "mentioned" };
    }
    if (all.length > 1) return { value: null, from: all.join(", "), how: "several", cities: all };
    return null;
  }

  // --- Role title --------------------------------------------------------------
  function titleCase(s) {
    var words = s.split(" ");
    return words.map(function (w, i) {
      if (!w) return w;
      if (/[A-Z]/.test(w) || /\d/.test(w)) return w; // keep "FP&A", "iOS", "FY28"
      var lw = w.toLowerCase();
      if (i > 0 && SMALL_WORDS[lw]) return lw;
      return w.replace(/^([("'‘“]?)([a-zà-ÿ])/, function (m, p, c) { return p + c.toUpperCase(); })
              .replace(/-([a-z])/g, function (m, c) { return "-" + c.toUpperCase(); });
    }).join(" ");
  }
  function tidyRole(raw) {
    var t = decodeEntities(String(raw || "")).replace(/\s+/g, " ").trim();
    t = t.replace(/^(?:job title|title|position|role|vacancy)\s*:\s*/i, "");
    t = t.split(/\s+·\s+/)[0];
    // Trailing parentheticals that describe the listing (shift, contract,
    // location, intake year), repeatedly: "Analyst (Hybrid) (12 Month FTC)".
    var guard = 0;
    while (guard++ < 4) {
      var pm = /\s*\(([^()]*)\)\s*$/.exec(t);
      if (!pm) break;
      if (TITLE_QUALIFIER_RE.test(pm[1]) || cityIn(pm[1])) t = t.slice(0, pm.index).trim();
      else break;
    }
    // " - Corporate Insurance", " – Dublin", " | Hybrid": the core title is
    // what comes before the first spaced separator. Hyphenated words
    // ("Co-ordinator") have no spaces round the hyphen and are untouched.
    var sep = /\s+[-–—|]\s+|\s*[|]\s*/.exec(t);
    if (sep && sep.index > 2) t = t.slice(0, sep.index).trim();
    // "Pensions Administrator Role" -> the letter already says "the ... role".
    t = t.replace(/\s+(?:role|position|vacancy|job|opportunity)$/i, "");
    t = t.replace(/[\s,;:.]+$/, "");
    if (/[a-z]/.test(t) && t === t.toLowerCase() || /\b[a-z]{3,}\b/.test(t)) t = titleCase(t);
    return t;
  }
  function titleScore(line, index, plain) {
    var t = line;
    if (t.length < 3 || t.length > 100) return -1;
    if (wordCount(t) > 12) return -1;
    if (/[.!?]$/.test(t) && !/\b(?:Inc|Ltd|Co|Jr|Sr)\.$/.test(t)) return -1;
    if (META_LINE_RE.test(t) || isJunk(t)) return -1;
    if (/^(?:about|join|we are|we're|our|at|why|how|what|who|the company)\b/i.test(t)) return -1;
    if (looksLikeLocationLine(t)) return -1;
    if (LABEL_LOCATION_RE.test(t) || LABEL_COMPANY_RE.test(t) || LABEL_START_RE.test(t)) return -1;
    if (/:\s*\S/.test(t) && !LABEL_TITLE_RE.test(t)) return -1;
    if (!/[A-Za-z]/.test(t)) return -1;
    var score = 0;
    if (ROLE_NOUN_RE.test(t)) score += 6;
    else return -1;
    if (index < 3) score += 2;
    else if (index < 8) score += 1;
    var core = tidyRole(t);
    if (core && countWord(plain, core) + countWord(plain.toLowerCase(), core.toLowerCase()) > 2) score += 2;
    return score;
  }
  function findRole(lines, header, plain) {
    var labelled = findLabelled(lines, LABEL_TITLE_RE, LABEL_TITLE_ALONE_RE);
    if (labelled && ROLE_NOUN_RE.test(labelled.value) && wordCount(labelled.value) <= 14) {
      return { value: tidyRole(labelled.value), raw: labelled.value, from: labelled.line, how: "label", headerIndex: -1 };
    }
    var best = null;
    header.forEach(function (h, i) {
      var s = titleScore(h.text, i, plain);
      if (s > 0 && (!best || s > best.score)) best = { score: s, text: h.text, i: i };
    });
    if (best) return { value: tidyRole(best.text), raw: best.text, from: best.text, how: "header", headerIndex: best.i };
    // Prose fallback: "Join us as a Pension Administrator in our Dublin
    // office", "We are looking for a Document Processing Administrator to".
    var re = /\b(?:join (?:us|our team|the team) as an?|we are (?:looking for|seeking|recruiting|hiring) an?|we're (?:looking for|seeking|recruiting|hiring) an?|looking to recruit an?|(?:the|this) role of|(?:the|this) position of|as (?:an?|our) )\s*((?:[A-Z][\w&'’\/.-]*)(?:\s+(?:(?:of|and|&|for)\s+)?[A-Z][\w&'’\/.-]*){0,6})/g;
    var m;
    while ((m = re.exec(plain)) !== null) {
      if (ROLE_NOUN_RE.test(m[1])) return { value: tidyRole(m[1]), raw: m[1], from: m[0].trim(), how: "body", headerIndex: -1 };
    }
    // Last resort: a heading-shaped line anywhere that ends in a role noun
    // ("Document Processing Administrator - Your role:").
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l || l.length > 90) continue;
      var head = l.split(/\s+[-–—|]\s+/)[0];
      if (wordCount(head) <= 6 && /^[A-Z]/.test(head) && ROLE_NOUN_RE.test(head) && !/[.!?]$/.test(head) &&
          new RegExp("\\b(?:" + ROLE_NOUNS.map(escapeRe).join("|") + ")$", "i").test(head.replace(/[:\s]+$/, ""))) {
        return { value: tidyRole(head), raw: l, from: l, how: "heading", headerIndex: -1 };
      }
    }
    return null;
  }

  // --- Company -------------------------------------------------------------------
  function tidyCompany(raw, plain) {
    var t = decodeEntities(String(raw || "")).replace(/\s+/g, " ").trim();
    t = t.replace(/^(?:company|employer|organi[sz]ation)\s*:\s*/i, "");
    t = t.split(/\s+·\s+|\s+\|\s+/)[0];
    t = t.replace(/[\s:,;.]+$/, "");
    var guard = 0;
    while (guard++ < 3 && /\s*\([^()]*\)\s*$/.test(t)) t = t.replace(/\s*\([^()]*\)\s*$/, "").trim();
    t = t.replace(LEGAL_SUFFIX_RE, "").trim();
    // "Ornua Co-operative" -> "Ornua", "Irish Life Financial Services" ->
    // "Irish Life", "Davy Group" -> "Davy": a shorter leading form the ad
    // itself uses on its own more often than the full name wins. The full
    // name is kept whenever the ad never shortens it.
    var words = t.split(" ");
    if (words.length >= 2 && plain) {
      var fullCount = countWord(plain, t);
      var best = t;
      var bestCount = fullCount;
      for (var n = words.length - 1; n >= 1; n--) {
        var shorter = words.slice(0, n).join(" ");
        if (shorter.length < 3 || /^(?:the|a|an)$/i.test(shorter) || SMALL_WORDS[shorter.toLowerCase()]) continue;
        if (CITY_CANON[shorter.toLowerCase()]) continue;
        var standalone = countWord(plain, shorter) - countWord(plain, words.slice(0, n + 1).join(" "));
        if (standalone >= 3 && standalone > bestCount) { best = shorter; bestCount = standalone; }
      }
      t = best;
    }
    return t;
  }
  function companyShaped(line) {
    if (!line || line.length > 70) return false;
    var w = wordCount(line);
    if (w < 1 || w > 7) return false;
    if (!/^[A-Z0-9]/.test(line)) return false;
    if (/[.!?]$/.test(line) && !/\b(?:Inc|Ltd|Co|plc)\.$/i.test(line)) return false;
    if (META_LINE_RE.test(line) || isJunk(line)) return false;
    if (looksLikeLocationLine(line)) return false;
    if (/:\s*\S/.test(line)) return false;
    if (NOT_A_COMPANY.test(line.replace(/[:\s]+$/, ""))) return false;
    if (DESCRIPTION_HEADING_RE.test(line)) return false;
    return true;
  }
  function findCompany(lines, header, plain, role) {
    var cands = [];
    function add(raw, from, how, weight) {
      var clean = tidyCompany(raw, plain);
      if (!clean || clean.length < 2 || NOT_A_COMPANY.test(clean) || CITY_CANON[clean.toLowerCase()]) return;
      if (role && clean.toLowerCase() === String(role.value || "").toLowerCase()) return;
      var freq = countWord(plain, clean);
      cands.push({ value: clean, raw: raw, from: from, how: how, score: weight + Math.min(freq, 6), order: cands.length });
    }
    findAllLabelled(lines, LABEL_COMPANY_RE, LABEL_COMPANY_ALONE_RE).forEach(function (l) {
      if (companyShaped(l.value) || /^[A-Z0-9]/.test(l.value)) add(l.value, l.line, "label", 10);
    });
    // Next to the title in the header block (job boards: Title / Company /
    // Location, or LinkedIn's Company / Title).
    if (role && role.headerIndex >= 0) {
      [role.headerIndex + 1, role.headerIndex - 1, role.headerIndex + 2].forEach(function (k) {
        var h = header[k];
        if (!h) return;
        var at = /^at\s+([A-Z0-9].{1,60})$/.exec(h.text);
        if (at && companyShaped(at[1])) add(at[1], h.text, "header", 7);
        else if (companyShaped(h.text) && !ROLE_NOUN_RE.test(h.text)) add(h.text, h.text, "header", 6);
      });
    }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l) continue;
      var about = /^about\s+(?!the\b|us\b|you\b|your\b|our\b|this\b|me\b|it\b)(.{2,60}?)\s*[:?]?$/i.exec(l);
      if (about && /^[A-Z0-9]/.test(about[1]) && !/\b(?:role|job|position|team|department|opportunity|you)\b/i.test(about[1])) {
        add(about[1], l, "about", 7);
      }
      if (/^about the (?:company|employer|organi[sz]ation)\s*:?$/i.test(l)) {
        for (var j = i + 1; j < Math.min(lines.length, i + 3); j++) {
          if (lines[j] && companyShaped(lines[j])) { add(lines[j], l + " " + lines[j], "about", 7); break; }
        }
      }
    }
    var bodyRes = [
      /(?:^|\n)\s*At ((?:[A-Z][\w&'’.-]*)(?:\s+[A-Z][\w&'’.-]*){0,3})(?:,| we\b| our\b| you\b)/g,
      /\bJoin ((?:[A-Z][\w&'’.-]*)(?:\s+[A-Z][\w&'’.-]*){0,3})(?:[,.!]| as\b| and\b| in\b)/g,
      /(?:^|\n)\s*((?:[A-Z][\w&'’.-]*)(?:\s+[A-Z][\w&'’.-]*){0,3}) (?:is|are) (?:a|an|one of|the|Ireland's|Europe's|the world's) /g
    ];
    bodyRes.forEach(function (re) {
      var m;
      while ((m = re.exec(plain)) !== null) {
        var name = m[1];
        if (/^(?:Us|Our|The|This|We|You|It|Join|Working|Being)\b/.test(name)) continue;
        if (ROLE_NOUN_RE.test(name) && !/\b(?:Group|Bank|Insurance|Partners|Life)\b/.test(name)) continue;
        if (countWord(plain, name) < 2) continue;
        add(name, m[0].trim(), "body", 4);
      }
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.score !== a.score ? b.score - a.score : a.order - b.order; });
    var top = cands[0];
    return { value: top.value, raw: top.raw, from: top.from, how: top.how };
  }

  // --- Team (verbatim) -------------------------------------------------------------
  // "NetApp's Financial Planning & Analysis team", "The Dublin Corporate &
  // Regulatory Insurance team", "in Commercial Team / Davy Private Clients".
  // Walks back from each "team" over Capitalised words (and &/and/of/for
  // between them); stops at a possessive, a lowercase word or punctuation.
  function findTeam(raw, plain, role, company) {
    var sentenceInfo = null;
    if (global.CVSegment && global.CVSegment.classifySentences) {
      try { sentenceInfo = global.CVSegment.classifySentences(plain).sentences; } catch (e) { sentenceInfo = null; }
    }
    function matchableAt(offset) {
      if (!sentenceInfo) return true;
      for (var i = 0; i < sentenceInfo.length; i++) {
        if (offset >= sentenceInfo[i].start && offset < sentenceInfo[i].end) return sentenceInfo[i].matchable;
      }
      return true;
    }
    var re = /\b(team)\b/gi;
    var m;
    var found = [];
    while ((m = re.exec(plain)) !== null) {
      var before = plain.slice(Math.max(0, m.index - 120), m.index);
      var after = plain.slice(m.index + m[0].length, m.index + m[0].length + 30).replace(/^\s+/, "");
      if (TEAM_AFTER_STOP.test(after)) continue;
      var tokens = before.split(/(\s+)/);
      var words = [];
      var stoppedBy = "";
      for (var k = tokens.length - 1; k >= 0; k--) {
        var tok = tokens[k];
        if (!tok || /^\s+$/.test(tok)) { if (/\n/.test(tok)) { stoppedBy = "\n"; break; } continue; }
        if (/['’]s$/.test(tok)) { stoppedBy = tok; break; }
        if (/^[A-Z][\w&'’\/-]*$/.test(tok) && !/[,.;:!?)]$/.test(tok)) { words.unshift(tok); continue; }
        if (/^(?:&|and|of|for)$/.test(tok) && words.length) { words.unshift(tok); continue; }
        stoppedBy = tok;
        break;
      }
      while (words.length && /^(?:&|and|of|for)$/.test(words[0])) words.shift();
      if (!words.length) continue;
      if (/^(?:The|Our|A|An|This|Your|Their)$/.test(words[0])) words.shift();
      if (!words.length) continue;
      var lead = (stoppedBy || "").toLowerCase();
      var goodLead = /^(?:the|our|a|an|their|your|in|with|join|joining|to|into|within|of|on|\n|)$/.test(lead) || /['’]s$/.test(stoppedBy) ||
        /^(?:The|Our)$/.test(before.trim().split(/\s+/).slice(-words.length - 1, -words.length)[0] || "");
      if (!goodLead) continue;
      var phrase = words.join(" ");
      if (HR_TEAM_WORD.test(phrase)) continue;
      if (company && phrase.toLowerCase() === company.toLowerCase()) continue;
      if (words.length === 1 && CITY_CANON[phrase.toLowerCase()]) continue;
      if (/^(?:One|Team|Global|Great|Strong|Dynamic|Small|Large|Wider|Whole|Same|New)$/.test(phrase)) continue;
      var value = phrase + " " + m[1];
      if (!inAd(raw, value)) continue;
      if (role && role.value && role.value.toLowerCase().indexOf(phrase.toLowerCase()) !== -1) continue;
      found.push({ value: value, offset: m.index, matchable: matchableAt(m.index) });
    }
    if (!found.length) return null;
    var pick = found.filter(function (f) { return f.matchable; })[0] || null;
    if (!pick) return null;
    var sentence = plain.slice(Math.max(0, plain.lastIndexOf("\n", pick.offset) + 1), Math.min(plain.length, pick.offset + 80)).split("\n")[0];
    return { value: pick.value, from: sentence.trim(), how: "body" };
  }

  // --- Recipient (verbatim) ----------------------------------------------------------
  var NAME_RE_SRC = "([A-Z][a-z'’]+(?:-[A-Z][a-z'’]+)?(?:\\s+(?:O['’]|Mc|Mac)?[A-Z][a-z'’]+(?:-[A-Z][a-z'’]+)?){1,2})";
  function plausibleName(n) {
    var parts = n.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) return false;
    return parts.every(function (p) { return p.length >= 2 && !NOT_A_NAME_WORD.test(p.replace(/['’]s$/, "")); });
  }
  function findRecipient(raw, lines, plain) {
    var labelled = findLabelled(lines, LABEL_CONTACT_RE, null);
    if (labelled) {
      var lm = new RegExp("^" + NAME_RE_SRC).exec(labelled.value);
      if (lm && plausibleName(lm[1]) && inAd(raw, lm[1])) return { value: lm[1], from: labelled.line, how: "label" };
    }
    for (var i = 0; i < lines.length; i++) {
      if (/^meet the hiring team$/i.test(lines[i] || "")) {
        for (var j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          var cand = (lines[j] || "").replace(/\s*[•·].*$/, "").trim();
          if (!cand) continue;
          var nm = new RegExp("^" + NAME_RE_SRC + "$").exec(cand);
          if (nm && plausibleName(nm[1]) && inAd(raw, nm[1])) return { value: nm[1], from: "Meet the hiring team: " + cand, how: "hiring-team" };
          break;
        }
      }
    }
    var re = new RegExp("\\b(?:please )?(?:contact|e-?mail|call|phone|reach out to|speak (?:to|with)|apply to|send (?:your )?(?:cv|application|resume) to|forward (?:your )?(?:cv|application|resume) to|questions to)\\s+" + NAME_RE_SRC + "\\b", "g");
    var m;
    while ((m = re.exec(plain)) !== null) {
      if (plausibleName(m[1]) && inAd(raw, m[1])) return { value: m[1], from: m[0].trim(), how: "body" };
    }
    return null;
  }

  // --- Start date (verbatim) ------------------------------------------------------------
  var MONTH_YEAR_SRC = "((?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?)?((?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{4}))";
  function findStartDate(raw, lines, plain) {
    var labelled = findLabelled(lines, LABEL_START_RE, LABEL_START_ALONE_RE);
    if (labelled) {
      var lm = new RegExp(MONTH_YEAR_SRC, "i").exec(labelled.value);
      if (lm && inAd(raw, lm[2])) return { value: lm[2], full: lm[1], from: labelled.line, how: "label" };
      return { value: null, from: labelled.line, how: "label-unparsed" };
    }
    var re = new RegExp("\\b(?:start(?:ing)?(?: date)?(?: is| of)?(?: in| on| from)?|commenc(?:e|es|ing)(?: in| on)?|intake(?: in)?|join(?:ing)? us (?:in|on|from))\\s+" + MONTH_YEAR_SRC, "gi");
    var m = re.exec(plain);
    if (m && inAd(raw, m[2])) return { value: m[2], full: m[1], from: m[0].trim(), how: "body" };
    var re2 = new RegExp("\\b(?:an?\\s+)" + MONTH_YEAR_SRC + "\\s+(?:start|intake)\\b", "gi");
    m = re2.exec(plain);
    if (m && inAd(raw, m[2])) return { value: m[2], full: m[1], from: m[0].trim(), how: "body" };
    return null;
  }

  // --- Public ----------------------------------------------------------------------------
  // Returns { company, role, city, team, recipientName, startDate, notes }.
  // Each field is null or { value, from, how, raw? }. `notes` carries
  // things worth saying that are not values ("the ad says Remote").
  function extract(rawJD) {
    var raw = String(rawJD || "");
    var empty = { company: null, role: null, city: null, team: null, recipientName: null, startDate: null, notes: [] };
    if (!raw.trim()) return empty;
    var plain = toPlain(raw);
    var lines = linesOf(plain);
    var header = headerZone(lines).filter(function (h) { return !isJunk(h.text); });
    var role = findRole(lines, header, plain);
    var company = findCompany(lines, header, plain, role);
    var cityHit = findCity(lines, header, plain);
    var notes = [];
    var city = null;
    if (cityHit && cityHit.value) city = { value: cityHit.value, from: cityHit.from, how: cityHit.how };
    else if (cityHit && cityHit.how === "remote") notes.push("The ad gives the location as remote.");
    else if (cityHit && cityHit.how === "several") notes.push("The ad names several cities (" + cityHit.from + ") without saying which office the role is in.");
    var team = findTeam(raw, plain, role, company && company.value);
    var recipient = findRecipient(raw, lines, plain);
    var start = findStartDate(raw, lines, plain);
    if (start && !start.value) {
      notes.push('The ad\'s start date ("' + start.from.replace(/^[^:]*:\s*/, "") + '") is not a month and year, so it was not used.');
      start = null;
    }
    if (role) delete role.headerIndex;
    return { company: company, role: role, city: city, team: team, recipientName: recipient, startDate: start, notes: notes };
  }

  global.CVAdInfo = {
    extract: extract,
    // exposed for tests
    tidyRole: tidyRole,
    tidyCompany: tidyCompany,
    cityIn: cityIn
  };
})(typeof window !== "undefined" ? window : globalThis);
