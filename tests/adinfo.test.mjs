// ---------------------------------------------------------------------------
// js/adinfo.js - reading the cover letter's details out of a pasted ad
// (2 Oct 2026). Plain Node, no browser: the extractor is pure.
//
//   node tests/adinfo.test.mjs
//
// Two kinds of input:
//  - the real ads already tracked in tests/fixtures/jd/ and
//    tests/golden/real-jds/ (verbatim, never edited here);
//  - SYNTHETIC strings written below to stand in for the page layouts of
//    common job sites (LinkedIn, Workday, Indeed, IrishJobs, Greenhouse).
//    They are test strings only, deliberately not saved as fixtures - no
//    real ad's text is reconstructed. Every person's name in them is made up.
// ---------------------------------------------------------------------------
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require(path.join(ROOT, 'js/matcher.js'));
require(path.join(ROOT, 'js/segment.js'));
require(path.join(ROOT, 'js/adinfo.js'));
const { extract, tidyRole, tidyCompany } = globalThis.CVAdInfo;

let failures = 0;
let passes = 0;
function check(label, cond, detail) {
  if (cond) { passes++; console.log('PASS - ' + label); }
  else { failures++; console.log('FAIL - ' + label + (detail !== undefined ? '\n       ' + detail : '')); }
}
const v = (r, k) => (r[k] ? r[k].value : null);
function expectFields(label, r, want) {
  Object.keys(want).forEach((k) => {
    check(`${label}: ${k} = ${JSON.stringify(want[k])}`, v(r, k) === want[k], JSON.stringify(r[k]));
  });
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

console.log('\n--- Real ads (tests/fixtures/jd) ---');
const FIXTURES = {
  'wtw-pensions-administrator': { company: 'WTW', role: 'Pensions Administrator', city: 'Dublin', team: null, recipientName: null, startDate: null },
  'netapp-fpa-intern': { company: 'NetApp', role: 'FP&A Intern', city: 'Cork', team: 'Financial Planning & Analysis team', startDate: 'January 2027' },
  'ornua-graduate-trainee': { company: 'Ornua', role: 'Graduate Trainee', city: 'Dublin', team: null },
  'sigmar-customer-service-representative-night': { company: 'Sigmar Recruitment', role: 'Customer Service Representative', city: 'Galway', team: null, recipientName: null },
  'standard-life-pensions-investments-administrator': { company: 'Standard Life', role: 'Pensions and Investments Administrator', city: null },
  'alphasense-associate-expert-call-services': { company: 'AlphaSense', role: 'Associate, Expert Call Services', city: null, team: null },
  'clydeco-junior-associate-corporate-insurance': { company: 'Clyde & Co', role: 'Junior Associate', city: 'Dublin', team: 'Dublin Corporate & Regulatory Insurance team' },
  'softco-document-processing-administrator': { company: 'SoftCo', role: 'Document Processing Administrator', city: 'Dublin' }
};
for (const [name, want] of Object.entries(FIXTURES)) {
  expectFields(name, extract(read(`tests/fixtures/jd/${name}.txt`)), want);
}
check('alphasense: an HQ city and a list of global offices are not taken as the job\'s city',
  v(extract(read('tests/fixtures/jd/alphasense-associate-expert-call-services.txt')), 'city') === null);
check('alphasense: team already named in the role title is not repeated as TEAM',
  v(extract(read('tests/fixtures/jd/alphasense-associate-expert-call-services.txt')), 'team') === null);
check('sigmar: "Customer Service Team Lead" is a job, not a team',
  v(extract(read('tests/fixtures/jd/sigmar-customer-service-representative-night.txt')), 'team') === null);

console.log('\n--- Real ads (tests/golden/real-jds) ---');
const REAL = {
  'business-analyst__Davy_Group': { company: 'Davy', role: 'Business Analyst', team: 'Commercial Team', city: null },
  'analyst-bi__Davy_Group': { company: 'Davy', role: 'MI & Reporting Data Analyst' },
  'consulting-tech__Accenture_Ireland': { company: 'Accenture Ireland', role: 'Business & Technology Consulting Graduate Programme FY28' },
  'finance-ops__Allianz_Insurance': { company: 'Allianz', role: 'Reinsurance Finance Analyst', city: 'Dublin' },
  'graduate-programme__Allianz_Insurance': { company: 'Allianz', role: 'Data Analytics Graduate Programme', city: 'Dublin' },
  'insurance-pensions__Canada_Life_Group_Services_(Irish_Life_Group)': { company: 'Irish Life', role: 'Claims Assessor', city: 'Dublin' }
};
for (const [name, want] of Object.entries(REAL)) {
  expectFields(name, extract(read(`tests/golden/real-jds/${name}.txt`)), want);
}

console.log('\n--- Synthetic page layouts (test strings only) ---');
const LINKEDIN = [
  'Acme Pensions', 'Pensions Administrator', 'Dublin, County Dublin, Ireland · 3 days ago · 87 applicants',
  'Promoted by hirer · Actively reviewing applicants', 'Hybrid', 'Full-time', 'Easy Apply', 'Save',
  'About the job', 'Join us as a Pensions Administrator in our Dublin office. You will process joiners and leavers.',
  'At Acme Pensions, we look after 200 schemes.', 'Meet the hiring team', 'Aoife Testperson', 'Talent Acquisition Partner at Acme Pensions', 'Message',
  'About the company', 'Acme Pensions', '12,345 followers'
].join('\n');
expectFields('LinkedIn layout (company above title)', extract(LINKEDIN), { company: 'Acme Pensions', role: 'Pensions Administrator', city: 'Dublin', recipientName: 'Aoife Testperson' });

const WORKDAY = [
  'Skip to main content', 'Careers', 'Search for Jobs', 'Claims Handler', 'Apply', 'locations', 'Cork, Ireland', 'time type', 'Full time',
  'posted on', 'Posted 5 Days Ago', 'job requisition id', 'R0012345',
  'At Brightwater Insurance, we put customers first. Brightwater Insurance is one of Ireland\'s largest insurers.',
  'Responsibilities', '- Handle claims end to end.', 'Start date: September 2027'
].join('\n');
expectFields('Workday layout (labels on their own lines)', extract(WORKDAY), { company: 'Brightwater Insurance', role: 'Claims Handler', city: 'Cork', startDate: 'September 2027' });

const INDEED = [
  'Data Analyst – Operations', 'Northwind Logistics', 'Limerick', '€38,000 - €42,000 a year - Full-time', 'Apply now',
  'Full job description', 'Northwind Logistics is a growing logistics company. You will build reports in Power BI.',
  'For more information please contact Ciara Testname on 061 000 000.'
].join('\n');
const indeed = extract(INDEED);
expectFields('Indeed layout', indeed, { company: 'Northwind Logistics', role: 'Data Analyst', city: 'Limerick', recipientName: 'Ciara Testname' });
check('Indeed: en-dash suffix dropped from the role (the Dash scan gate would fail it)', !/[–—]/.test(v(indeed, 'role')), v(indeed, 'role'));

const GREENHOUSE = ['Operations Associate', 'at Lumen Payments', 'Dublin', 'Apply', 'About Lumen Payments', 'Lumen Payments is a payments company.'].join('\n');
expectFields('Greenhouse layout ("at Company" line)', extract(GREENHOUSE), { company: 'Lumen Payments', role: 'Operations Associate', city: 'Dublin' });

const REMOTE = ['Customer Support Agent', 'Harbour Software', 'Location: Remote', 'About the role', 'Answer customer tickets by email.'].join('\n');
const remote = extract(REMOTE);
check('Location: Remote -> no city, and a note saying so', v(remote, 'city') === null && remote.notes.some((n) => /remote/i.test(n)), JSON.stringify(remote));

const ASAP = ['Accounts Assistant', 'Kestrel Foods', 'Galway', 'Start date: ASAP', 'Responsibilities', 'Process invoices.'].join('\n');
const asap = extract(ASAP);
check('Start date: ASAP -> no start date (not a month and year), with a note', v(asap, 'startDate') === null && asap.notes.some((n) => /ASAP/.test(n)), JSON.stringify(asap));

const SEPT = 'Graduate Analyst\nOrbit Bank\nDublin\n\nThis is a September 2027 start, joining our graduate intake.';
expectFields('prose start date ("a September 2027 start")', extract(SEPT), { startDate: 'September 2027' });

const HTML = 'Title: Junior Analyst\n<div><p><strong>About Quill Analytics:</strong></p><p>Quill Analytics is a data firm. At Quill Analytics, you will join our Risk &amp; Pricing team in Dublin.</p></div>';
const html = extract(HTML);
expectFields('raw HTML paste', html, { company: 'Quill Analytics', role: 'Junior Analyst', city: 'Dublin' });
check('raw HTML paste: a team spelled "&amp;" in the paste is not returned as "&" (would fail the verbatim check)', v(html, 'team') === null, JSON.stringify(html.team));

const NOTHING = 'We are a friendly bunch. Apply today and tell us about yourself. Great benefits and a lovely office.';
const none = extract(NOTHING);
check('an ad with no title, company or place yields nulls, not guesses',
  ['company', 'role', 'city', 'team', 'recipientName', 'startDate'].every((k) => none[k] === null), JSON.stringify(none));
check('empty input', Object.values(extract('')).every((x) => x === null || (Array.isArray(x) && !x.length)));

console.log('\n--- Tidying ---');
check('tidyRole: sentence case -> title case', tidyRole('Pensions administrator') === 'Pensions Administrator', tidyRole('Pensions administrator'));
check('tidyRole: keeps acronyms', tidyRole('FP&A Intern') === 'FP&A Intern');
check('tidyRole: drops listing qualifiers in brackets', tidyRole('Customer Service Representative (Night shift)') === 'Customer Service Representative');
check('tidyRole: keeps a bracket that is part of the title', tidyRole('Reinsurance Finance Analyst (P&C)') === 'Reinsurance Finance Analyst (P&C)', tidyRole('Reinsurance Finance Analyst (P&C)'));
check('tidyRole: drops a trailing "role"', tidyRole('Business Analyst Role') === 'Business Analyst');
check('tidyRole: hyphenated words untouched', tidyRole('Office Co-ordinator') === 'Office Co-ordinator', tidyRole('Office Co-ordinator'));
check('tidyCompany: drops brackets and legal suffixes', tidyCompany('WTW (Willis Towers Watson)', '') === 'WTW' && tidyCompany('Kestrel Foods Limited', '') === 'Kestrel Foods');
check('tidyCompany: keeps "& Co"', tidyCompany('Clyde & Co', '') === 'Clyde & Co');

console.log('\n--- Invariants over every input above ---');
const ALL = [
  ...Object.keys(FIXTURES).map((n) => read(`tests/fixtures/jd/${n}.txt`)),
  ...Object.keys(REAL).map((n) => read(`tests/golden/real-jds/${n}.txt`)),
  LINKEDIN, WORKDAY, INDEED, GREENHOUSE, REMOTE, ASAP, SEPT, HTML, NOTHING
];
let verbatimOk = true;
let cleanOk = true;
const bad = [];
for (const text of ALL) {
  const r = extract(text);
  for (const k of ['team', 'recipientName', 'startDate']) {
    if (r[k] && text.toLowerCase().indexOf(r[k].value.toLowerCase()) === -1) { verbatimOk = false; bad.push(k + ': ' + r[k].value); }
  }
  for (const k of ['company', 'role', 'city', 'team']) {
    const val = r[k] && r[k].value;
    if (val && (/[–—]/.test(val) || /\s{2,}/.test(val) || /^\s|\s$/.test(val) || /[{}<>]/.test(val))) { cleanOk = false; bad.push(k + ': ' + val); }
  }
  for (const k of ['company', 'role', 'city', 'team', 'recipientName', 'startDate']) {
    if (r[k] && !r[k].from) { cleanOk = false; bad.push(k + ' has no "from"'); }
  }
}
check('team, recipient name and start date are always word-for-word substrings of the ad (what the validators require)', verbatimOk, bad.join(' | '));
check('no value carries an en/em dash, a double space, stray whitespace or markup; every value says where it came from', cleanOk, bad.join(' | '));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
