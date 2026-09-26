/**
 * chat-bot.js - rule based chat bot for the Precog Security demo.
 *
 * The rules, their order and their replies are unchanged. What changed:
 *
 *   1. `respondTo()` threw a TypeError on null/undefined input (index.js calls
 *      it straight from a keydown handler, so a stray event could break the
 *      page). Input is now validated and normalised.
 *   2. Input is length bounded before any pattern is applied, so a hostile or
 *      accidental paste cannot turn the matcher into a CPU sink.
 *   3. The `if / else if / if / else if` chain is now an ordered rule table.
 *      The old chain read as if the later rules were only reachable when an
 *      earlier one did *not* match, which was not what it did; first match in
 *      table order is the actual, tested behaviour.
 *   4. The patterns are compiled once instead of on every keystroke, and a
 *      pattern that fails to compile is skipped instead of taking the whole
 *      bot down.
 *   5. `null` is returned explicitly when no rule matches, instead of falling
 *      off the end of the function with `undefined`.
 */
function chatBot() {
  'use strict';

  // Longest sensible query. Anything beyond this is not a question.
  var MAX_INPUT_LENGTH = 256;

  /**
   * Ordered rule table. First match wins.
   * @type {{pattern: string, reply: string}[]}
   */
  var RULES = [
    {
      pattern: '(hi|maskati|mhoroi|ndeipi|greetings|howzit|hello|hullo|hey|hola|holla|helo|help|advise|advice|howdy)(\\w|$)',
      reply: 'Welcome To Precog Security. Choose 1 DOMESTIC 2 LEGAL 3 BUSINESS 4 COMMUNITY'
    },
    {
      pattern: '(1)(\\d|$)',
      reply: 'Your DISPUTE is DOMESTIC. How is home and family?'
    },
    {
      pattern: '(2)(\\d|$)',
      reply: 'Your ISSUE is LEGAL. Proceed A LAWYER B REPORT to POLICE C SEEK ADVICE D CONTINUE CHAT'
    },
    {
      pattern: '(3)(\\d|$)',
      reply: 'Your CONCERN is BUSINESS. Investing in work or business always has positive effects on other areas of Life :)'
    },
    {
      pattern: '(4)(\\d|$)',
      reply: 'Your STAKES are within COMMUNITY where important things happen'
    },
    {
      pattern: '(security|safety|family|familial|circle|unit|child|minor|kid|children|male|female|sex|gender|SPOUSE|PARTNER|marital|conjugal|married|matrimonial|husband|wife|father|mother|parent|son|daughter|heir|inheritance|affection|like|enjoy|prefer|love|desire|passion|feeling|spirit|church|religion|belief|God|Jesus|faith|tradition|dogma|view|opinion|peace|discipline|moral|principle|relative|relation|brother|sister|inlaw|grandparent|uncle|aunt|nephew|niece|guardian|ward|adopt|step|illegitimate)(\\w|$)',
      reply: 'I understand! LEGALLY, what would you propose?'
    },
    {
      pattern: '(domestic|home|house|internal|inland|interior|local|national|local|internal|residence|residential|habitation|dwelling|abode|habitat|cohabit|quarters|domicile|address|place|origin|city|town|suburb|rural|area|birthplace|native|birth|farm|ranch|homebased|household|homespun|homemade|homeproduced|household)(\\w|$)',
      reply: 'There is PRESSURE upon YOU or RESOURCES.'
    },
    {
      pattern: '(group|gang|clique|party|landlord|TENANT|RENT|ACCOMODATION|CARETAKER|servant|gardener|maid|hire|fire|dismiss|wage|friend|enemy|intruder|visitor|private|secret|prostitute|affair|scandal|shame|taboo|reject|INCIDENT|DISPUTE|VIOLENCE|HIT|hate|speech|verbal|emotional|abuse|insult|hurt|scared|afraid|judgemental|cry|sad|happy|stress|angry|rage|jealous|frustrate|depression|mad|upset)(\\d|$)',
      reply: 'How would your COMMUNITY view that scenario?'
    },
    {
      pattern: '(witness|oath|document|letter|bureau|LEGAL|MURDER|DEATH|UNLAWFUL|KILL|ASSAULT|REPORT|THEFT|PROPERTY|ACCUSED|DEFENCE|COUNSEL|LAWYER|COMPLAINANT|AGENT|APPREHEND|CUSTODY|ARREST|will|RIGHTS|CONTRACT|FORMS|FILES|deterrence|punishment|sentence|jail|prison|incarcerate|detention|detain|interogation|investigate|thief|crook|skate|con|liar|convict|prisoner|fugitive|runaway|HISTORY|PRECEDENT|ADULTERY|DOCKET|DAMAGES|LAWFUL|GOOD|JUSTICE|ADMINISTRATION|ESTATES|TRADE|FINANCE|CASH|owe|repay|credit|debt|possession|ASSET|VALUE|EQUITY|JUSTICE|BALANCE|COMMUNITY|CLIENT|arbitration|settlement|constitution|equal|revenge|restitution|fair|unfair|just|unjust|suspect|suspicious|suspicion|reasonable|sane|doubt|insane|mad|crook|thief|robber|rape|rapist|violent|injury|injure|dishonest|court|case)(\\w|$)',
      reply: 'Who do you SUSPECT'
    },
    {
      pattern: '(unit|office|director|investor|shareholder|share|boost|business|challenge|improve|OPPORTUNITY|BUY|PAY|SELL|SALE|PROFIT|GAIN|LOSS|THREAT|money|VALUE|CASH|ASSETS|INVEST|INCREASE|INVESTMENT|DIVEST|REDUCE|INPUTS|CONTRACT|AGREE|EMPLOYER|GUARDIAN|EMPLOYEE|WAGE|MONEY|SALARY|PROFIT|LOSS|boss|superior|job|labour|manager|slave|vehicle|car|motor|delivery|invoice|budget|receipt|bank|finance|loan|mortgage|company|shop|outlet|market|suspension|suspend|PR|department|store|retail|commerce|cost|commercial|bill|order)(\\w|$)',
      reply: 'Stand by for best BUSINESS Recommendations'
    },
    {
      pattern: '(many|group|location|Africa|Britain|America|Europe|Zimbabwe|geography|COMMUNITY|PEOPLE|neighbour|CROWD|world|neighbour|public|water|air|power|electricty|gas|oil|petrol|diesel|coal|fuel|health|disease|sick|medicine|drugs|politics|society|social|human|person|pollution|ethics|immigration|sanctions|export|import|POPULATION|GLOBAL|EARTH|ENVIRONMENT|CITY|economy|time|calendar|travel|COUNTRY|RURAL|MATTER|ISSUE|INTEREST|PUBLIC|GOOD|PROGRESS|DEVELOPMENT|LEADERSHIP|government|military|soldier|army|airforce|defence|election|representative|tribunal|review|council|parliament|constitution|DIRECTION|COUNTRY|LOCAL|DOMESTIC|INTERNATIONAL|FOREIGN|LEGAL|RESPECT|communication|intepret|network|gang|possee|vigilante|militia|force|strike|coup|revolution|demonstrate|riot|petition)(\\w|$)',
      reply: 'You must SURVEY and INFLUENCE the COMMUNITY'
    }
  ];

  // Compile once, case insensitively. respondTo() normalises the input to lower
  // case, but roughly half the keywords in the rule set are written in upper
  // case ("LAWYER", "MURDER", "CASH"). Without the `i` flag those branches were
  // unreachable dead weight: the bot could never answer "Who do you SUSPECT" for
  // the word "lawyer". The flag makes the rule set behave as it reads.
  var COMPILED = [];
  for (var i = 0; i < RULES.length; i++) {
    try {
      COMPILED.push({ re: new RegExp(RULES[i].pattern, 'i'), reply: RULES[i].reply });
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('chatBot: skipping unusable rule ' + i + ': ' + err.message);
      }
    }
  }

  /** Most recent normalised input. */
  this.input = '';

  /**
   * Whether the last input matches a pattern.
   * @param {string} pattern @returns {boolean}
   */
  this.match = function (pattern) {
    try {
      return new RegExp(pattern).test(this.input);
    } catch (err) {
      return false;
    }
  };

  /**
   * Reply to a line of user input.
   *
   * @param {*} input raw user input; anything that is not usable yields null
   * @return {?string|Array.<string>} reply, or null when no rule matches
   */
  this.respondTo = function (input) {
    if (input === null || input === undefined) {
      this.input = '';
      return null;
    }

    var text = typeof input === 'string' ? input : String(input);
    if (text.length > MAX_INPUT_LENGTH) text = text.slice(0, MAX_INPUT_LENGTH);
    this.input = text.toLowerCase();

    for (var index = 0; index < COMPILED.length; index++) {
      if (COMPILED[index].re.test(this.input)) return COMPILED[index].reply;
    }
    return null;
  };
}

// CommonJS export so the rules can be unit tested; in the browser this stays a
// global function, as the page expects.
if (typeof module === 'object' && module && module.exports) {
  module.exports = chatBot;
}
