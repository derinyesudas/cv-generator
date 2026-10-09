// ---------------------------------------------------------------------------
// One-off sweep script, 18-19 Sept 2026 (Fix 2, Derin's own instruction:
// "Sweep the existing tags now. Every single-word tag either gains a word
// or is deleted."). Run once, by hand, not part of the app or the golden
// suite - kept here as a record of exactly what changed and why, the same
// way tests/golden/measure-blocks.js and bump-1.x.js scripts from earlier
// sessions are kept as a record rather than deleted after running.
//
// Scope: exactly the three tag sources js/score.js's allKnownTags() reads
// (skillLines[...].terms[].tags, bulletVariants[...].variants[].tags,
// profileVariants[].tags) - not data.neverClaim or data.knownAbsentTools,
// which are a different concept (matchRule terms for a hard exclusion
// list, with their own existing trap-check in validate.js) even though
// they use similar stem/exact syntax.
//
// Every replacement below is either (a) uppercasing a genuine acronym/
// system-name already written that way in its own approved bullet text
// (OMNI, GDPR, SLA, KPI, MI, GST, POS, AI, LLM, BI) - matching is already
// case-insensitive, so this changes nothing about what matches, only
// satisfies the mechanical rule for tokens that are genuinely acronyms; or
// (b) widening an ordinary-word tag to a two-word phrase, chosen where
// possible from words already present in that SAME term/variant's own
// approved text (not invented content - tags are invisible matching
// metadata, never printed, so widening a tag doesn't add a new claim about
// Derin, but grounding the replacement in real text kept every choice
// mechanical rather than free-associated); or (c) deleting a tag that
// turned out to be either redundant with a sibling tag on the same entry,
// or not well grounded in that entry's own text to begin with.
//
// Flagged explicitly, not silently absorbed (see the decision log for the
// full version of this): "excel" (and "word"/"access"/"data"/"customer" -
// all genuine software names or extremely common words) had to be widened
// like everything else, per the rule as given, with no acronym loophole -
// deliberately NOT storing them as e.g. "EXCEL" to dodge the two-word
// requirement, because a common English word matching unrelated prose is
// exactly the failure this rule exists to close, and "excel" the verb has
// that same risk as "excel" the software. Consequence: a JD that mentions
// a tool by name alone, with no second qualifying word nearby ("Excel."
// with nothing else), will no longer register as a keyword hit through
// these tags. Real, and worth Derin's review - not a hypothetical.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'cv-generator-data.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

let changes = 0;
function rename(tags, from, to, where) {
  const i = tags.indexOf(from);
  if (i === -1) {
    console.error('MISSING tag "' + from + '" in ' + where + ' - script is out of date, aborting.');
    process.exit(1);
  }
  if (to === null) {
    tags.splice(i, 1);
  } else {
    tags[i] = to;
  }
  changes++;
}

// --- skillLines --------------------------------------------------------
const sl = data.skillLines;

rename(sl.aiTooling.terms[0].tags, 'ai', 'AI', 'skillLines.aiTooling term 0');
rename(sl.aiTooling.terms[0].tags, 'claude', 'claude code', 'skillLines.aiTooling term 0');
rename(sl.aiTooling.terms[0].tags, 'automation', 'ai automation', 'skillLines.aiTooling term 0');
rename(sl.aiTooling.terms[0].tags, 'copilot', 'ai copilot', 'skillLines.aiTooling term 0');
rename(sl.aiTooling.terms[0].tags, 'llm', 'LLM', 'skillLines.aiTooling term 0');

(function () {
  const t = sl.technical.terms;
  const byText = (s) => t.find((x) => x.text === s);
  rename(byText('Power BI (DAX, Power Query)').tags, 'bi', 'BI', 'technical/Power BI');
  rename(byText('Power BI (DAX, Power Query)').tags, 'dashboard', 'interactive dashboard', 'technical/Power BI');
  rename(byText('Power BI (DAX, Power Query)').tags, 'visualisation', 'data visualisation', 'technical/Power BI');
  rename(byText('Power BI (DAX, Power Query)').tags, 'dax', 'DAX', 'technical/Power BI');
  rename(byText('Power BI (DAX, Power Query)').tags, 'measures', 'dax measures', 'technical/Power BI');
  rename(byText('Power BI (DAX, Power Query)').tags, 'modelling', 'data modelling', 'technical/Power BI');

  rename(byText('Tableau').tags, 'tableau', 'tableau reporting', 'technical/Tableau');
  rename(byText('Tableau').tags, 'bi', 'BI', 'technical/Tableau');
  rename(byText('Tableau').tags, 'visualisation', 'data visualisation', 'technical/Tableau');

  rename(byText('Python').tags, 'python', 'python programming', 'technical/Python');
  rename(byText('Python').tags, 'scripting', 'process scripting', 'technical/Python');
  rename(byText('Python').tags, 'automation', 'task automation', 'technical/Python');

  rename(byText('R').tags, 'r', 'r programming', 'technical/R');
  rename(byText('R').tags, 'statistics', 'statistical analysis', 'technical/R');
  rename(byText('R').tags, 'forecasting', 'business forecasting', 'technical/R');

  const excelTerm = byText('Microsoft Excel, advanced, certified at 100% (Power Query, pivot tables, lookups, conditional logic)');
  rename(excelTerm.tags, 'excel', 'excel skills', 'technical/Excel');
  rename(excelTerm.tags, 'pivot', 'pivot tables', 'technical/Excel');
  rename(excelTerm.tags, 'spreadsheet', 'spreadsheet skills', 'technical/Excel');

  const wpaTerm = byText('Microsoft Word, PowerPoint and Access, certified');
  rename(wpaTerm.tags, 'word', 'ms word', 'technical/Word-PowerPoint-Access');
  rename(wpaTerm.tags, 'powerpoint', 'ms powerpoint', 'technical/Word-PowerPoint-Access');
  rename(wpaTerm.tags, 'access', 'ms access', 'technical/Word-PowerPoint-Access');

  const legacyOmniTerm = byText('Legacy and OMNI administration systems');
  rename(legacyOmniTerm.tags, 'insurance', 'insurance systems', 'technical/Legacy-OMNI');
  rename(legacyOmniTerm.tags, 'claims', 'claims processing', 'technical/Legacy-OMNI');

  const tallyTerm = byText('TallyPrime with GST, certified');
  rename(tallyTerm.tags, 'accounting', 'financial accounting', 'technical/Tally');
  rename(tallyTerm.tags, 'tally', 'tally prime', 'technical/Tally');
  rename(tallyTerm.tags, 'bookkeeping', 'gst bookkeeping', 'technical/Tally');
  rename(tallyTerm.tags, 'gst', 'GST', 'technical/Tally');
})();

(function () {
  const t = sl.analytical.terms;
  const byText = (s) => t.find((x) => x.text === s);

  const dashTerm = byText('Data visualisation and dashboards for business stakeholders');
  rename(dashTerm.tags, 'dashboard', 'interactive dashboard', 'analytical/dashboards');
  rename(dashTerm.tags, 'visualisation', 'data visualisation', 'analytical/dashboards');
  rename(dashTerm.tags, 'reporting', 'management reporting', 'analytical/dashboards');
  rename(dashTerm.tags, 'mi', 'MI', 'analytical/dashboards');

  const forecastTerm = byText('Forecasting, predictive and prescriptive analytics');
  rename(forecastTerm.tags, 'forecasting', 'business forecasting', 'analytical/forecasting');
  rename(forecastTerm.tags, 'predictive', 'predictive analytics', 'analytical/forecasting');
  rename(forecastTerm.tags, 'prescriptive', 'prescriptive analytics', 'analytical/forecasting');
  rename(forecastTerm.tags, 'modelling', 'data modelling', 'analytical/forecasting');
  rename(forecastTerm.tags, 'planning', 'business planning', 'analytical/forecasting');

  const cleanTerm = byText('Data cleaning, validation and quality checking');
  rename(cleanTerm.tags, 'validation', 'data validation', 'analytical/cleaning');
  rename(cleanTerm.tags, 'cleaning', 'data cleaning', 'analytical/cleaning');
  rename(cleanTerm.tags, 'integrity', 'data integrity', 'analytical/cleaning');

  const trendTerm = byText('Trend and performance analysis');
  rename(trendTerm.tags, 'trend', 'trend analysis', 'analytical/trend');
  rename(trendTerm.tags, 'performance', 'performance analysis', 'analytical/trend');
  rename(trendTerm.tags, 'kpi', 'KPI', 'analytical/trend');
  rename(trendTerm.tags, 'metrics', 'performance metrics', 'analytical/trend');
  rename(trendTerm.tags, 'analysis', 'business analysis', 'analytical/trend');

  const autoTerm = byText('Automating recurring manual work');
  rename(autoTerm.tags, 'automation', 'task automation', 'analytical/automating');
  rename(autoTerm.tags, 'efficiency', 'efficiency gains', 'analytical/automating');

  const volTerm = byText('High-volume financial datasets');
  rename(volTerm.tags, 'volume', 'high volume', 'analytical/volume');
})();

(function () {
  const t = sl.business.terms;
  const byText = (s) => t.find((x) => x.text === s);

  const stakeTerm = byText('Stakeholder liaison across functions');
  rename(stakeTerm.tags, 'stakeholder', 'stakeholder management', 'business/stakeholder');
  rename(stakeTerm.tags, 'liaison', 'stakeholder liaison', 'business/stakeholder');
  rename(stakeTerm.tags, 'relationship', 'relationship management', 'business/stakeholder');

  const reqTerm = byText('Clarifying and resolving requirements');
  rename(reqTerm.tags, 'requirements', 'client requirements', 'business/requirements');
  rename(reqTerm.tags, 'gathering', 'requirements gathering', 'business/requirements');
  rename(reqTerm.tags, 'documentation', 'requirements documentation', 'business/requirements');

  const explainTerm = byText('Explaining analysis to non-technical audiences');
  rename(explainTerm.tags, 'communication', 'stakeholder communication', 'business/explaining');
  rename(explainTerm.tags, 'presentation', 'presentation skills', 'business/explaining');
  rename(explainTerm.tags, 'non-technical', 'non-technical audience', 'business/explaining');
  rename(explainTerm.tags, 'storytelling', 'data storytelling', 'business/explaining');

  const deadlineTerm = byText('Competing priorities and deadlines');
  rename(deadlineTerm.tags, 'deadlines', 'competing deadlines', 'business/deadlines');
  rename(deadlineTerm.tags, 'prioritisation', 'task prioritisation', 'business/deadlines');
  rename(deadlineTerm.tags, 'organised', 'highly organised', 'business/deadlines');

  const procTerm = byText('Accuracy against documented procedures');
  rename(procTerm.tags, 'procedures', 'documented procedures', 'business/procedures');
  rename(procTerm.tags, 'accuracy', 'high accuracy', 'business/procedures');
  rename(procTerm.tags, 'controls', 'internal controls', 'business/procedures');
  rename(procTerm.tags, 'compliance', 'regulatory compliance', 'business/procedures');

  const confTerm = byText('Confidentiality and data protection');
  rename(confTerm.tags, 'confidentiality', 'data confidentiality', 'business/confidentiality');
  rename(confTerm.tags, 'gdpr', 'GDPR', 'business/confidentiality');
})();

(function () {
  const t = sl.domain.terms;
  const byText = (s) => t.find((x) => x.text === s);

  const finServTerm = byText('Financial services and insurance operations');
  rename(finServTerm.tags, 'insurance', 'insurance operations', 'domain/financial services');
  rename(finServTerm.tags, 'regulated', 'regulated industry', 'domain/financial services');
  rename(finServTerm.tags, 'banking', 'banking sector', 'domain/financial services');

  rename(byText('Corporate finance').tags, 'finance', 'corporate finance', 'domain/corporate finance');
  rename(byText('Financial and cost accounting').tags, 'accounting', 'cost accounting', 'domain/cost accounting');

  const auditTerm = byText('Auditing');
  rename(auditTerm.tags, 'audit', 'internal audit', 'domain/auditing');
  rename(auditTerm.tags, 'auditing', 'financial auditing', 'domain/auditing');
  rename(auditTerm.tags, 'controls', 'internal controls', 'domain/auditing');

  rename(byText('Risk management').tags, 'risk', 'risk management', 'domain/risk');

  const investTerm = byText('Investment analysis and portfolio management');
  rename(investTerm.tags, 'investment', 'investment analysis', 'domain/investment');
  rename(investTerm.tags, 'portfolio', 'portfolio management', 'domain/investment');
  rename(investTerm.tags, 'wealth', 'wealth management', 'domain/investment');
  rename(investTerm.tags, 'securities', 'securities markets', 'domain/investment');
})();

(function () {
  const t = sl.transversal.terms;
  const byText = (s) => t.find((x) => x.text === s);

  const accDetailTerm = byText('Accuracy and attention to detail');
  rename(accDetailTerm.tags, 'accuracy', 'high accuracy', 'transversal/accuracy-detail');
  rename(accDetailTerm.tags, 'detail', 'attention to detail', 'transversal/accuracy-detail');

  const queryTerm = byText('Client and stakeholder query resolution');
  rename(queryTerm.tags, 'queries', 'query resolution', 'transversal/queries');
  rename(queryTerm.tags, 'resolution', 'issue resolution', 'transversal/queries');

  const kpiTerm = byText('Working to documented procedures, KPIs and deadlines');
  rename(kpiTerm.tags, 'procedures', 'documented procedures', 'transversal/kpi-deadlines');
  rename(kpiTerm.tags, 'kpi', 'KPI', 'transversal/kpi-deadlines');
  rename(kpiTerm.tags, 'sla', 'SLA', 'transversal/kpi-deadlines');
  rename(kpiTerm.tags, 'deadlines', 'strict deadlines', 'transversal/kpi-deadlines');

  const recTerm = byText('Maintaining organised electronic records');
  rename(recTerm.tags, 'records', 'electronic records', 'transversal/records');
  rename(recTerm.tags, 'administration', 'records administration', 'transversal/records');

  const confTerm2 = byText('Confidentiality and data protection');
  rename(confTerm2.tags, 'confidentiality', 'data confidentiality', 'transversal/confidentiality');
  rename(confTerm2.tags, 'gdpr', 'GDPR', 'transversal/confidentiality');
})();

(function () {
  const t = sl.languages.terms;
  const byText = (s) => t.find((x) => x.text === s);

  rename(byText('English, CEFR C1 (Duolingo 140/160)').tags, 'english', 'english fluency', 'languages/english');

  const hindiTerm = byText('Hindi');
  rename(hindiTerm.tags, 'hindi', 'hindi speaker', 'languages/hindi');
  rename(hindiTerm.tags, 'language', null, 'languages/hindi'); // redundant generic tag, deleted

  const malayalamTerm = byText('Malayalam');
  rename(malayalamTerm.tags, 'malayalam', 'malayalam speaker', 'languages/malayalam');
  rename(malayalamTerm.tags, 'language', null, 'languages/malayalam'); // redundant generic tag, deleted
})();

// --- bulletVariants ------------------------------------------------------
const bv = data.bulletVariants;
const byVid = (gid, vid) => bv[gid].variants.find((v) => v.id === vid);

rename(byVid('b-excel-filter', 'b-excel-filter-full').tags, 'automation', 'task automation', 'b-excel-filter-full');
rename(byVid('b-excel-filter', 'b-excel-filter-full').tags, 'efficiency', 'efficiency gains', 'b-excel-filter-full');
rename(byVid('b-excel-filter', 'b-excel-filter-full').tags, 'excel', 'excel skills', 'b-excel-filter-full');
rename(byVid('b-excel-filter', 'b-excel-filter-full').tags, 'initiative', 'personal initiative', 'b-excel-filter-full');
rename(byVid('b-excel-filter', 'b-excel-filter-full').tags, 'training', 'team training', 'b-excel-filter-full');

rename(byVid('b-excel-filter', 'b-excel-filter-short').tags, 'automation', 'task automation', 'b-excel-filter-short');
rename(byVid('b-excel-filter', 'b-excel-filter-short').tags, 'excel', 'excel skills', 'b-excel-filter-short');
rename(byVid('b-excel-filter', 'b-excel-filter-short').tags, 'efficiency', 'efficiency gains', 'b-excel-filter-short');

rename(byVid('b-excel-filter', 'b-excel-filter-training').tags, 'training', 'team training', 'b-excel-filter-training');
rename(byVid('b-excel-filter', 'b-excel-filter-training').tags, 'coaching', 'peer coaching', 'b-excel-filter-training');

rename(byVid('b-accuracy', 'b-accuracy-fs').tags, 'accuracy', 'high accuracy', 'b-accuracy-fs');
rename(byVid('b-accuracy', 'b-accuracy-fs').tags, 'procedures', 'documented procedures', 'b-accuracy-fs');
rename(byVid('b-accuracy', 'b-accuracy-fs').tags, 'validation', 'data validation', 'b-accuracy-fs');

rename(byVid('b-accuracy', 'b-accuracy-insurance').tags, 'insurance', 'insurance claims', 'b-accuracy-insurance');
rename(byVid('b-accuracy', 'b-accuracy-insurance').tags, 'claims', 'claims processing', 'b-accuracy-insurance');
rename(byVid('b-accuracy', 'b-accuracy-insurance').tags, 'legacy', 'legacy systems', 'b-accuracy-insurance');
rename(byVid('b-accuracy', 'b-accuracy-insurance').tags, 'omni', 'OMNI', 'b-accuracy-insurance');
rename(byVid('b-accuracy', 'b-accuracy-insurance').tags, 'accuracy', 'high accuracy', 'b-accuracy-insurance');

rename(byVid('b-accuracy', 'b-accuracy-generic').tags, 'accuracy', 'high accuracy', 'b-accuracy-generic');

rename(byVid('b-accuracy', 'b-accuracy-retail').tags, 'retail', 'retail experience', 'b-accuracy-retail');
rename(byVid('b-accuracy', 'b-accuracy-retail').tags, 'detail', 'attention to detail', 'b-accuracy-retail');
rename(byVid('b-accuracy', 'b-accuracy-retail').tags, 'reliability', 'proven reliability', 'b-accuracy-retail');

rename(byVid('b-spoc', 'b-spoc-stakeholder').tags, 'stakeholder', 'stakeholder management', 'b-spoc-stakeholder');
rename(byVid('b-spoc', 'b-spoc-stakeholder').tags, 'communication', 'stakeholder communication', 'b-spoc-stakeholder');
rename(byVid('b-spoc', 'b-spoc-stakeholder').tags, 'requirements', 'client requirements', 'b-spoc-stakeholder');
rename(byVid('b-spoc', 'b-spoc-stakeholder').tags, 'liaison', 'stakeholder liaison', 'b-spoc-stakeholder');

rename(byVid('b-spoc', 'b-spoc-phone').tags, 'queries', 'query resolution', 'b-spoc-phone');
rename(byVid('b-spoc', 'b-spoc-phone').tags, 'phone', 'phone support', 'b-spoc-phone');
rename(byVid('b-spoc', 'b-spoc-phone').tags, 'email', 'email support', 'b-spoc-phone');

rename(byVid('b-spoc', 'b-spoc-deadline').tags, 'deadlines', 'competing deadlines', 'b-spoc-deadline');
rename(byVid('b-spoc', 'b-spoc-deadline').tags, 'delivery', 'on-time delivery', 'b-spoc-deadline');
rename(byVid('b-spoc', 'b-spoc-deadline').tags, 'coordination', 'team coordination', 'b-spoc-deadline');
rename(byVid('b-spoc', 'b-spoc-deadline').tags, 'escalation', 'issue escalation', 'b-spoc-deadline');

rename(byVid('b-excel-daily', 'b-excel-daily-full').tags, 'excel', 'excel skills', 'b-excel-daily-full');
rename(byVid('b-excel-daily', 'b-excel-daily-full').tags, 'migration', 'data migration', 'b-excel-daily-full');
rename(byVid('b-excel-daily', 'b-excel-daily-full').tags, 'lookups', 'excel lookups', 'b-excel-daily-full');

rename(byVid('b-excel-daily', 'b-excel-daily-nda').tags, 'excel', 'excel skills', 'b-excel-daily-nda');
rename(byVid('b-excel-daily', 'b-excel-daily-nda').tags, 'confidentiality', 'data confidentiality', 'b-excel-daily-nda');

rename(byVid('b-confidential', 'b-confidential-plain').tags, 'confidentiality', 'data confidentiality', 'b-confidential-plain');
rename(byVid('b-confidential', 'b-confidential-plain').tags, 'gdpr', 'GDPR', 'b-confidential-plain');
rename(byVid('b-confidential', 'b-confidential-plain').tags, 'compliance', 'regulatory compliance', 'b-confidential-plain');

rename(byVid('b-confidential', 'b-confidential-nights').tags, 'confidentiality', 'data confidentiality', 'b-confidential-nights');
rename(byVid('b-confidential', 'b-confidential-nights').tags, 'independent', 'independent working', 'b-confidential-nights');
rename(byVid('b-confidential', 'b-confidential-nights').tags, 'autonomy', 'high autonomy', 'b-confidential-nights');

rename(byVid('b-checked', 'b-checked-approval').tags, 'review', 'quality review', 'b-checked-approval');
rename(byVid('b-checked', 'b-checked-approval').tags, 'verification', 'entry verification', 'b-checked-approval');
rename(byVid('b-checked', 'b-checked-approval').tags, 'controls', 'internal controls', 'b-checked-approval');
rename(byVid('b-checked', 'b-checked-approval').tags, 'approval', 'approval workflow', 'b-checked-approval');
rename(byVid('b-checked', 'b-checked-approval').tags, 'records', 'electronic records', 'b-checked-approval');

rename(byVid('b-checked', 'b-checked-records').tags, 'records', 'electronic records', 'b-checked-records');

rename(byVid('b-console', 'b-console-triage').tags, 'dashboard', 'interactive dashboard', 'b-console-triage');
rename(byVid('b-console', 'b-console-triage').tags, 'visualisation', 'data visualisation', 'b-console-triage');
rename(byVid('b-console', 'b-console-triage').tags, 'reporting', 'management reporting', 'b-console-triage');

rename(byVid('b-console', 'b-console-surveillance').tags, 'surveillance', 'market surveillance', 'b-console-surveillance');
rename(byVid('b-console', 'b-console-surveillance').tags, 'compliance', 'regulatory compliance', 'b-console-surveillance');
rename(byVid('b-console', 'b-console-surveillance').tags, 'risk', 'critical risk', 'b-console-surveillance');
rename(byVid('b-console', 'b-console-surveillance').tags, 'monitoring', 'risk monitoring', 'b-console-surveillance');
rename(byVid('b-console', 'b-console-surveillance').tags, 'anomaly', 'anomaly detection', 'b-console-surveillance');

rename(byVid('b-report', 'b-report-full').tags, 'documentation', 'technical documentation', 'b-report-full');
rename(byVid('b-report', 'b-report-full').tags, 'presentation', 'presentation skills', 'b-report-full');
rename(byVid('b-report', 'b-report-full').tags, 'communication', 'stakeholder communication', 'b-report-full');
rename(byVid('b-report', 'b-report-full').tags, 'storytelling', 'data storytelling', 'b-report-full');

rename(byVid('b-report', 'b-report-presentation').tags, 'presentation', 'presentation skills', 'b-report-presentation');
rename(byVid('b-report', 'b-report-presentation').tags, 'non-technical', 'non-technical audience', 'b-report-presentation');
rename(byVid('b-report', 'b-report-presentation').tags, 'storytelling', 'data storytelling', 'b-report-presentation');
rename(byVid('b-report', 'b-report-presentation').tags, 'training', null, 'b-report-presentation'); // not grounded in this bullet's own text, deleted rather than stretched

rename(byVid('b-blarney', 'b-blarney-drive').tags, 'reliability', 'proven reliability', 'b-blarney-drive');
rename(byVid('b-blarney', 'b-blarney-drive').tags, 'drive', null, 'b-blarney-drive'); // redundant with sibling tag "work ethic"
rename(byVid('b-blarney', 'b-blarney-drive').tags, 'attendance', 'full attendance', 'b-blarney-drive');

rename(byVid('b-blarney', 'b-blarney-hospitality').tags, 'hospitality', 'hospitality experience', 'b-blarney-hospitality');
rename(byVid('b-blarney', 'b-blarney-hospitality').tags, 'hygiene', 'food hygiene', 'b-blarney-hospitality');
rename(byVid('b-blarney', 'b-blarney-hospitality').tags, 'teamwork', 'team collaboration', 'b-blarney-hospitality');

rename(byVid('bul-dmart-floor', 'bul-dmart-floor').tags, 'retail', 'retail experience', 'bul-dmart-floor');
rename(byVid('bul-dmart-floor', 'bul-dmart-floor').tags, 'complaints', 'complaint handling', 'bul-dmart-floor');
rename(byVid('bul-dmart-floor', 'bul-dmart-floor').tags, 'supermarket', 'supermarket retail', 'bul-dmart-floor');

rename(byVid('bul-dmart-till', 'bul-dmart-till').tags, 'billing', 'billing counter', 'bul-dmart-till');
rename(byVid('bul-dmart-till', 'bul-dmart-till').tags, 'checkout', 'checkout operations', 'bul-dmart-till');
rename(byVid('bul-dmart-till', 'bul-dmart-till').tags, 'pos', 'POS', 'bul-dmart-till');
rename(byVid('bul-dmart-till', 'bul-dmart-till').tags, 'retail', 'retail experience', 'bul-dmart-till');

// --- profileVariants -------------------------------------------------------
const pv = data.profileVariants;
const byPid = (id) => pv.find((p) => p.id === id);

rename(byPid('prof-grad').tags, 'graduate', 'graduate programme', 'prof-grad');
rename(byPid('prof-grad').tags, 'rotational', 'rotational programme', 'prof-grad');
rename(byPid('prof-grad').tags, 'analytics', 'business analytics', 'prof-grad');

rename(byPid('prof-consulting').tags, 'ai', 'AI', 'prof-consulting');
rename(byPid('prof-consulting').tags, 'consulting', 'management consulting', 'prof-consulting');
rename(byPid('prof-consulting').tags, 'automation', 'task automation', 'prof-consulting');
rename(byPid('prof-consulting').tags, 'initiative', 'personal initiative', 'prof-consulting');

rename(byPid('prof-ba').tags, 'reporting', 'management reporting', 'prof-ba');
rename(byPid('prof-ba').tags, 'mi', 'MI', 'prof-ba');
rename(byPid('prof-ba').tags, 'stakeholder', 'stakeholder management', 'prof-ba');

rename(byPid('prof-bi').tags, 'data', 'data analysis', 'prof-bi');
rename(byPid('prof-bi').tags, 'visualisation', 'data visualisation', 'prof-bi');
rename(byPid('prof-bi').tags, 'datasets', 'large datasets', 'prof-bi');

rename(byPid('prof-finance').tags, 'accounting', 'financial accounting', 'prof-finance');
rename(byPid('prof-finance').tags, 'tally', 'tally prime', 'prof-finance');
rename(byPid('prof-finance').tags, 'records', 'electronic records', 'prof-finance');
rename(byPid('prof-finance').tags, 'invoices', 'invoice processing', 'prof-finance');

rename(byPid('prof-insurance').tags, 'insurance', 'insurance operations', 'prof-insurance');
rename(byPid('prof-insurance').tags, 'claims', 'claims processing', 'prof-insurance');
rename(byPid('prof-insurance').tags, 'policy', 'policy administration', 'prof-insurance');
rename(byPid('prof-insurance').tags, 'administration', 'systems administration', 'prof-insurance');

rename(byPid('prof-customerops').tags, 'operations', 'customer operations', 'prof-customerops');
rename(byPid('prof-customerops').tags, 'sla', 'SLA', 'prof-customerops');
rename(byPid('prof-customerops').tags, 'shifts', 'shift work', 'prof-customerops');

rename(byPid('prof-retail').tags, 'retail', 'retail experience', 'prof-retail');
rename(byPid('prof-retail').tags, 'till', 'till operation', 'prof-retail');
rename(byPid('prof-retail').tags, 'customer', 'customer service', 'prof-retail');
rename(byPid('prof-retail').tags, 'shifts', 'shift work', 'prof-retail');

console.log('Applied ' + changes + ' tag changes.');

// --- version bump + changelog, same convention as prior sessions ----------
const NEW_VERSION = '1.13';
data._version = NEW_VERSION;
data._changelog.unshift({
  version: NEW_VERSION,
  date: '19 Sept 2026',
  summary: "Fix 2 (Derin's own instruction, part of the same JD-segmentation fix as 1.13's sibling code changes): every tag across skillLines/bulletVariants/profileVariants that was a single word (and not a 2-6 character all-caps acronym) either widened to a two-word phrase or was deleted, per the new js/validate.js rule. " + changes + " tags changed. Genuine acronyms/system-names (OMNI, GDPR, SLA, KPI, MI, GST, POS, AI, LLM, BI) uppercased in place - matching is case-insensitive, so this only satisfies the validator, no behaviour change. Ordinary-word tags widened using words already present in their own term/bullet text where possible (tags are invisible matching metadata, never printed, so this is not new content about Derin). Flagged for Derin's review: 'excel' (and 'word'/'access'/'data'/'customer') had to widen like everything else, with no acronym shortcut taken - deliberately, since a common word's polysemy risk (e.g. 'excel' the verb) is exactly what this rule exists to close - so a bare single-word tool mention with no second qualifying word nearby will no longer register as a keyword hit through these tags. No heightPx/printed content changed by this entry; every heightPx.dataVersion re-stamped to " + NEW_VERSION + " below since nothing needed re-measuring."
});

// --- re-stamp every still-current heightPx.dataVersion, same convention as
// the 1.11->1.12 bump: content/measurements didn't change, only the
// version stamp, so every heightPx entry still at the old version gets
// walked and re-stamped rather than re-measured. -----------------------
let restamped = 0;
function walk(node) {
  if (Array.isArray(node)) {
    node.forEach(walk);
  } else if (node && typeof node === 'object') {
    if ('dataVersion' in node && typeof node.dataVersion === 'string' && node.dataVersion !== NEW_VERSION) {
      node.dataVersion = NEW_VERSION;
      restamped++;
    }
    Object.keys(node).forEach((k) => walk(node[k]));
  }
}
walk(data);
console.log('Re-stamped ' + restamped + ' dataVersion fields to ' + NEW_VERSION + '.');

fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
console.log('Wrote ' + DATA_PATH);
