// Earned settlement rules used by the modeller.
// Edit this file when the rules change. Nothing else should hard-code a threshold.
//
// Source: "A Fairer Pathway to Settlement: Government Response to the Consultation"
// (CP 1707, Home Office, November 2026), Chapter 2 and Table 1.
// These are announced policy, not yet Immigration Rules.

var ILR_RULES = {
  lastChecked: "2026-11-06",
  source: "A Fairer Pathway to Settlement: Government Response to the Consultation (CP 1707)",
  sources: [
    {
      label: "A Fairer Pathway to Settlement – Government response (CP 1707, PDF)",
      url: "https://assets.publishing.service.gov.uk/media/6ae89fddf4a6b3f59cf37580/FINAL_VERSION_-_Earned_Settlement_-_Consultation_Response.pdf"
    },
    {
      label: "Immigration Rules (GOV.UK)",
      url: "https://www.gov.uk/guidance/immigration-rules"
    },
    {
      label: "Find an OISC-regulated immigration adviser",
      url: "https://www.gov.uk/find-an-immigration-adviser"
    }
  ],

  // How far after the route start to search for an eligible month.
  horizonYears: 15,

  // Only "exclude" is supported in version 1: years not finished before the
  // application month do not count.
  partialYears: "exclude",

  // First month of the tax year (1 = January … 12 = December). Monthly pay is
  // allocated April–March; dates on the tax-year basis are shown as 6 April.
  taxYearStartMonth: 4,
  taxYearStartDay: 6,

  // Combined couple threshold (CP 1707, Chapter 2). Shown for information only;
  // not modelled in version 1.
  householdThreshold: 25142,

  // threshold: annual earnings that must be reached (£)
  // need:      number of years that must meet it
  // window:    number of years looked at, counting back from the application date
  routes: {
    3:  { threshold: 125141, need: 3, window: 4, band: "Additional rate" },
    5:  { threshold: 50271,  need: 3, window: 5, band: "Higher rate" },
    10: { threshold: 12571,  need: 5, window: 7, band: "Basic rate" }
  }
};

if (typeof module === "object" && module.exports) module.exports = { RULES: ILR_RULES };
