JD FIXTURE CORPUS - CV Generator
Eight real job ads, verbatim, with expected results recorded before any run.

These are the only ads for which the exact pasted text survives. Ads from
earlier in the project (Davy, Accenture, Bank of Ireland, Stripe, US Bank,
Stryker, Abbott) do not have recoverable text and must NOT be reconstructed
from memory or from their output documents - a reconstructed ad is a guess
fed into a test, which makes the result unfalsifiable. Fixture 8 itself was
nearly lost to the same rule for a different reason (a context-compaction
boundary, not a missing upload) - see its own entry below.

Drop these at tests/fixtures/jd/.

====================================================================
RUN ORDER FOR THE FIRST END-TO-END
====================================================================

  1. ornua-graduate-trainee                  archetype exists, refs in zip
  2. netapp-fpa-intern                       archetype exists, refs in zip,
                                             tightest CV in the set
  3. standard-life-pensions-investments-administrator
  4. wtw-pensions-administrator
  5. sigmar-customer-service-representative-night
  6. alphasense-associate-expert-call-services   expect archetype gap
  7. clydeco-junior-associate-corporate-insurance  MUST REFUSE
  8. softco-document-processing-administrator   the ad that motivated
                                                 close-match mode - see below,
                                                 it does NOT trigger it

Run 1 and 2 first. They are the cleanest signal on the renderer and the gates
because an archetype exists for both and hand-built reference documents exist
for both. (Those reference documents, in reference/, are earlier versions of
Derin's own CVs and letters: kept on his computer, not in the repository. No
test reads them.)

====================================================================
EXPECTED RESULTS, PER FIXTURE
====================================================================

--- ornua-graduate-trainee ---
Archetype: graduate-programme.
Years extractor: no experience requirement present. Must report "no experience
  requirement detected", not silence.
Eligibility: "completed their degree no earlier than 2025" - the MSc completed
  September 2026, so this PASSES. A naive reader might fail it on the 2024 BMS.
Segmentation: "Why these roles are valuable", "Key Benefits" and "Accessibility
  at Ornua" to IGNORED.
Watch for: "2:2 or higher" must not be parsed as a years figure.

--- netapp-fpa-intern ---
Archetype: finance-ops.
Years extractor: none present.
Eligibility: unrestricted right to work for six months, no sponsorship - PASSES.
  Cork office 3 days a week is a location flag, not an eligibility bar.
Never-claim: the ad says "supporting reconciliations" and "SQL". Neither may
  appear in any output. This is the strongest never-claim test in the corpus.
Segmentation: "Why You'll Thrive at NetApp", "Our culture", "Equal Opportunity
  Employer", "Submitting an Application", "AI Disclosure" to IGNORED.

--- standard-life-pensions-investments-administrator ---
Archetype: insurance-pensions.
Years extractor: none present.
Gap: QFA not held. Must surface.
Segmentation: "Introduction and Background" and "Why choose us?" to IGNORED.
  Note the intro paragraph is marketing copy sitting above the responsibilities
  - a heading-only segmenter will wrongly include it.

--- wtw-pensions-administrator ---
Archetype: insurance-pensions.
Years extractor: none present.
Gaps: QFA, and Irish pensions legislation. Both must surface.
Never-claim: the ad says "Reconcile contributions". Must not appear in output.
Segmentation: "What we offer", "Equal Opportunity Employer", "Unsolicited
  Contact", "Our Offices" to IGNORED.

--- sigmar-customer-service-representative-night ---
Archetype: customer-ops.
Years extractor: "2+ years' experience in a Call Centre or Customer Service
  environment" must extract MINIMUM 2 and report a GAP (one year held).
  That sentence must also be EXCLUDED from the ECHO pick-list.
Segmentation: "About Your New Employer", "What's on Offer", "What's Next",
  "Accessibility", "Reasonable Accommodations" to IGNORED.
TEAM: no team named. Recipient block must collapse to company and city, or use
  the named recruiter. No prompt to invent one.

--- alphasense-associate-expert-call-services ---
Archetype: EXPECT A GAP. sales-sourcing does not exist yet. Either the score
  falls below threshold and the app refuses, or it picks something ill-fitting.
  Both are the CORRECT result for this input. Record it as a coverage finding,
  do not patch around it.
Years extractor: "up to 1-2 years of full-time experience" must extract MINIMUM
  1 and report a MATCH, not a gap. This is the single most important assertion
  in the corpus - reading the upper bound inverts the whole fit result.
Segmentation: "About AlphaSense", the equal-opportunity paragraphs and
  "Recruiting Scams and Fraud" to IGNORED.
Gaps: sales, recruiting, sourcing, cold outreach. None in approved content.

--- clydeco-junior-associate-corporate-insurance ---
NEGATIVE FIXTURE. UPDATED 21 SEPT 2026 - see decision log, "Eleventh pass"
and the pass after it, for the full reasoning. "Never refuse to generate"
(spec section 6) stands and was never actually in conflict with this fixture -
the app does not gate the download button for a BLOCKED verdict, and it never
will. What this fixture actually tests is whether a hard qualification bar
gets surfaced UNMISSABLY, not whether the app blocks a download.

Expected: verdict BLOCKED, naming "Is a qualified solicitor in Ireland" as the
blocking requirement, quoted verbatim in the verdict banner itself (not just
in the findings list below it). Documents still generate and still download -
that is correct, not a bug. Test FAILS if the verdict is anything other than
BLOCKED, or if the blocking quote names the wrong line.
"Is a qualified solicitor in Ireland" is an absolute professional bar, not a
preference a strong CV can outweigh. "1-5 years' post-qualification experience"
counts from admission, which is zero.
Years extractor: "between 1-5 years' post-qualification experience" must
  extract MINIMUM 1, and the verdict must still be BLOCKED (not STRETCH) -
  a "block" severity finding short-circuits the years/stretch logic entirely
  (js/fitcheck.js's computeVerdict returns BLOCKED the instant any warnings
  finding has severity "block", before the years bands are ever consulted).
Watch for: "500 partners, 2,400 lawyers, 3,200 legal professionals, 5,500
  people, nearly 70 offices" and "SBTi Net-Zero" - none may be read as an
  experience requirement.

Confirmed 21 Sept 2026, real run via tests/fixtures/run-e2e.mjs: verdict
"BLOCKED: "- Is a qualified solicitor in Ireland." — documents still
generate...", download NOT disabled, docx downloaded successfully.

If the app tailors a CV for this ad WITHOUT surfacing the BLOCKED verdict and
the exact blocking line, that is a hard failure regardless of how good the
document looks. A hard qualification bar the app cannot detect and cannot
surface unmissably is the most expensive failure mode in the whole system: it
costs a real application and it is invisible in the output. Surfacing it
loudly - not refusing to build - is how this app is designed to prevent that,
per spec section 6.

--- softco-document-processing-administrator ---
THE FIXTURE THAT MOTIVATED CLOSE-MATCH MODE. Derin rejected a letter as
generic for this exact ad, and close-match mode (5 tagged evidence
clusters, 50% MATCHABLE-sentence-hit threshold) was built in direct
response. The verbatim ad text was lost once already (a context-compaction
boundary, 26 Sept 2026, not a missing upload) and resent as a file upload
specifically so it could not happen again.

Derin's five expected results, stated before this run:
  1. Close-match mode fires ("This is the posting that set the rule").
  2. Years extractor detects no experience-requirement figure.
  3. Eligibility PASS.
  4. "About SoftCo", "Our success at a glance", "What We Offer", "Our
     Culture", "Benefits found in job post" segment to IGNORED.
  5. "XML" never appears in output; "GDPR" never appears as a claimed
     skill/training (stating care with confidential personal data is fine;
     claiming GDPR expertise is not).

Confirmed 26 Sept 2026, real run via tests/golden/run-golden-tests.mjs and
tests/fixtures/run-e2e.mjs:

  1. DOES NOT FIRE. hitCount 1 / totalCount 27, ratio ~3.7%, nowhere near
     the 0.5 threshold. The one literal hit is "Work to achieve daily and
     weekly processing targets..." against the "processing targets" tag.
     Every other closeMatch tag is a multi-word phrase this app matches
     literally ("client liaison", "query resolution", "standard operating
     procedure", "accuracy record", ...), and this real ad simply doesn't
     use that phrasing - it says "liaise with clients", "SOPs", "address
     ad-hoc queries" instead. This is a genuine, reported miss against
     Derin's own stated expectation, not a test bug: the trigger was
     previously gate-tested only against synthetic JD text
     (CLOSE_MATCH_JD_FOR_DOM in run-golden-tests.mjs) written to closely
     echo the tag list's own wording, which turned out not to be a fair
     stand-in for how a real ad is actually phrased. OPEN DECISION FOR
     DERIN: whether to broaden the tag list (e.g. add "SOP"/"SOPs" and a
     "liaise with client" variant), lower the threshold, or accept that
     this specific ad - despite feeling like a close match by eye - does
     not clear the bar as currently defined. Not changed here.
  2. HOLDS. yearsRequired: null, yearsRequiredAllDiscarded: true - "For
     over 35 years, we've helped finance teams..." is found as a candidate
     and correctly discarded (company history, not an experience ask; also
     sits in an IGNORED region).
  3. HOLDS. Verdict GOOD, no findings, no stretch reasons. No block-severity
     warning matches this ad.
  4. HOLDS for all five named headings.
  5. HOLDS. Neither term appears in the built CV or letter (with or without
     an ECHO quote), and neither is ever offered as an ECHO candidate in
     the first place - js/letterbuild.js already excludes any candidate
     sentence containing a neverClaim term (js/letterbuild.js line ~216),
     so adding "gdpr"/"xml" to neverClaim last pass closes this
     automatically, independent of this fixture ever arriving.

Independent finding, not one of the five checks: "Document Processing
Administrator - Your role:" is not recognised by any MATCHABLE_HEADING_TERMS
entry (it says "your role", the list has "the role"/"about the role"), so
the intro paragraph directly under it ("You will play a key role in
ensuring the accuracy, quality, and integrity of data processed...")
inherits IGNORED state from the preceding company-boilerplate section until
"Your responsibilities:" flips it back. Did not change today's archetype
pick or verdict (the words that mattered - "client", "digital" - also occur
in genuinely matchable lines below), but is a real heading-vocabulary gap
this fixture happened to expose. Flagged, not fixed - the heading lists are
Derin's own, verbatim.

Archetype auto-pick (informational): consulting-tech, score 9, top terms
"client" (weight 5) and "digital" (weight 4) - not customer-ops, which the
earlier synthetic close-match test text had assumed.

====================================================================
WHAT THIS CORPUS IS ALSO FOR
====================================================================

Beyond the end-to-end, this is the keyword-precision harness. Record the hit
count per tag across all ads once, then any tag change prints a delta:

    excel:            5 ads -> 3 ads   (-2: netapp, wtw)
    data validation:  2 ads -> 2 ads   (no change)

That turns a precision trade into a number rather than a judgement made in the
dark. It is what the `excel` / `word` / `access` decision should have been
measured against.
