// ---------------------------------------------------------------------------
// Derives "years of experience" figures from data.facts.roles[].employment at
// scan time, rather than storing a single frozen number. Replaces Phase 6's
// original data.facts.yearsExperience.value=1 - Derin's own instruction,
// 14 Sept 2026: "hard-coding 1 means the number is a lie the day it changes
// and nothing will tell you... store the employment rows with start date,
// end date, full/part-time, and a counts_as_relevant flag, and compute the
// figure at scan time. Same principle as everything else on the site:
// recompute from the source, don't carry a frozen answer."
//
// Three separate figures, not one - a job ad asks three different questions
// and a single field answers all three identically, so it will be wrong on
// at least two of them (Derin's own framing):
//   - yearsRelevant: full-time AND countsAsRelevant employment only -
//     "X years in a data/analyst role" / "X years in financial services".
//   - yearsProfessional: full-time employment of any kind, relevant or not -
//     identical to yearsRelevant today (TCS is the only full-time role on
//     file) but diverges the day a full-time role that isn't analytics work
//     is added.
//   - monthsOtherEmployment: part-time, non-relevant months - never added
//     into either years figure above, kept available for a JD asking about
//     "customer-facing experience" or similar.
// See data.facts.experienceRule for the full definitions as Derin gave them.
// ---------------------------------------------------------------------------
(function (global) {
  "use strict";

  // Inclusive whole-month count between two ISO "YYYY-MM-DD" dates: calendar
  // month difference, +1 if the end day is on/after the start day (captures
  // a full final month) - matches how Derin described "twelve months" for
  // TCS's 16 Aug 2024 - 14 Aug 2025 span (12 months exactly, by this rule).
  // Deliberately simple, no date library: this only ever runs on
  // data.facts.roles[].employment dates, which are either a real confirmed
  // date or a documented month-only convention (see each employment entry's
  // own _note) - never arbitrary user input.
  function monthsBetween(startISO, endISO) {
    var start = new Date(startISO + "T00:00:00Z");
    var end = new Date(endISO + "T00:00:00Z");
    var months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      (end.getUTCMonth() - start.getUTCMonth());
    if (end.getUTCDate() >= start.getUTCDate()) months += 1;
    return months;
  }

  // Returns { yearsRelevant, yearsProfessional, monthsOtherEmployment }.
  // A role with no `employment` object is excluded from all three figures,
  // not silently guessed into one - same "never guess a fact" rule as
  // everything else in this app.
  function computeExperience(data) {
    var monthsRelevant = 0;
    var monthsProfessional = 0;
    var monthsOther = 0;
    (data.facts.roles || []).forEach(function (role) {
      var emp = role.employment;
      if (!emp) return;
      var months = monthsBetween(emp.startDate, emp.endDate);
      if (emp.fullTime) {
        monthsProfessional += months;
        if (emp.countsAsRelevant) monthsRelevant += months;
      } else if (!emp.countsAsRelevant) {
        monthsOther += months;
      }
      // A part-time role that DID count as relevant (none exist today)
      // would land in none of the three totals above, deliberately: Derin's
      // own definition of "relevant" is scoped to full-time employment
      // ("professional analyst/data/financial-services experience"), so a
      // part-time analyst role isn't a case this app has a rule for yet. If
      // that ever happens, that's a real policy question to ask about, not
      // one to silently resolve here.
    });
    return {
      yearsRelevant: monthsRelevant / 12,
      yearsProfessional: monthsProfessional / 12,
      monthsOtherEmployment: monthsOther
    };
  }

  global.CVExperience = { computeExperience: computeExperience, monthsBetween: monthsBetween };
})(typeof window !== "undefined" ? window : globalThis);
