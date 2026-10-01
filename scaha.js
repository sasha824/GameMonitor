// SCAHA 16U A Regular Season game tracker.
// Opens the SCAHA schedule page in a headless browser, picks the season + schedule,
// reads the schedule table, and prints only games you haven't been shown before.
//
// Usage:  node scaha.js            -> show new games, remember them
//         node scaha.js --all      -> show every game (does not touch the database)
//         node scaha.js --reset    -> forget all shown games
//         node scaha.js --show     -> run with a visible browser window (debugging)

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  url: 'http://scaha.com/scaha/scoreboard.xhtml',
  season: 'SCAHA 2026/27 Season',
  schedule: '16U A Regular Season',
  dbFile: path.join(__dirname, 'shown_games.json'),
  debugFile: path.join(__dirname, 'debug.html'),
};

const args = process.argv.slice(2);
const SHOW_ALL = args.includes('--all');
const RESET = args.includes('--reset');
const HEADED = args.includes('--show');

// ---------- "shown games" database (simple JSON file) ----------
function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.dbFile, 'utf8'));
  } catch {
    return { shown: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(CONFIG.dbFile, JSON.stringify(db, null, 2));
}

function gameKey(g) {
  // Game # is the unique id on the schedule; fall back to a composite if it is blank.
  return g.gameNumber || `${g.date}|${g.time}|${g.home}|${g.away}`;
}

// ---------- browser helpers ----------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

class BlockedError extends Error {}

async function launchBrowser(headed) {
  const errors = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({
        channel,
        headless: !headed,
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch (e) {
      errors.push(`${channel}: ${e.message.split('\n')[0]}`);
    }
  }
  throw new Error('Could not start Microsoft Edge or Google Chrome.\n' + errors.join('\n'));
}

// Picks an option from a dropdown, whether it is a plain <select> or a PrimeFaces menu.
async function chooseOption(page, label) {
  const re = new RegExp('^\\s*' + escapeRe(label) + '\\s*$');
  const optionLoc = page.locator('option', { hasText: re });

  const nativeVisible = page.locator('select:visible', { has: optionLoc });
  if (await nativeVisible.count()) {
    await nativeVisible.first().selectOption({ label });
  } else {
    const menu = page.locator('.ui-selectonemenu', { has: optionLoc }).first();
    if (!(await menu.count())) throw new Error(`Dropdown containing "${label}" not found`);
    await menu.click();
    await page
      .locator('.ui-selectonemenu-panel:visible li.ui-selectonemenu-item')
      .filter({ hasText: re })
      .first()
      .click();
  }
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1000);
}

// Reads every row of the schedule table (the one with a "Game #" header).
async function readSchedule(page) {
  try {
    await page.waitForFunction(
      () => {
        const t = [...document.querySelectorAll('table')].find((x) => /Game\s*#/.test(x.innerText));
        return t && [...t.querySelectorAll('tbody tr')].some((r) => r.querySelectorAll('td').length >= 9);
      },
      null,
      { timeout: 20000 }
    );
  } catch {
    return [];
  }

  return page.evaluate(() => {
    const t = [...document.querySelectorAll('table')].find((x) => /Game\s*#/.test(x.innerText));
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...t.querySelectorAll('tbody tr')]
      .map((r) => [...r.querySelectorAll('td')].map((c) => clean(c.innerText)))
      .filter((c) => c.length >= 9)
      .map((c) => ({
        gameNumber: c[0],
        date: c[1],
        time: c[2],
        type: c[3],
        status: c[4],
        home: c[5],
        homeScore: c[6],
        away: c[7],
        awayScore: c[8],
        venue: c[9] || '',
        rink: c[10] || '',
      }));
  });
}

function formatGame(g) {
  const score = g.homeScore || g.awayScore ? `  [${g.homeScore}-${g.awayScore}]` : '';
  const where = [g.venue, g.rink].filter(Boolean).join(' - ');
  return (
    `#${g.gameNumber}  ${g.date} ${g.time}  ${g.home} vs ${g.away}${score}\n` +
    `      ${g.type}${g.status ? ' | ' + g.status : ''}${where ? ' | ' + where : ''}`
  );
}

// ---------- main ----------
async function openSchedule(headed) {
  const browser = await launchBrowser(headed);
  let page;
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    page = await context.newPage();

    console.log(`Loading ${CONFIG.url} ${headed ? '(visible window)' : ''}...`);
    const resp = await page.goto(CONFIG.url, { waitUntil: 'networkidle', timeout: 60000 });
    const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    if ((resp && resp.status() === 403) || /403 Forbidden/i.test(bodyText)) {
      throw new BlockedError('The SCAHA site returned "403 Forbidden".');
    }

    console.log(`Selecting season: ${CONFIG.season}`);
    await chooseOption(page, CONFIG.season);
    console.log(`Selecting schedule: ${CONFIG.schedule}`);
    await chooseOption(page, CONFIG.schedule);

    const games = await readSchedule(page);
    if (!games.length) fs.writeFileSync(CONFIG.debugFile, await page.content());
    return games;
  } catch (e) {
    try {
      if (page) fs.writeFileSync(CONFIG.debugFile, await page.content());
    } catch {}
    throw e;
  } finally {
    await browser.close();
  }
}

(async () => {
  if (RESET) {
    saveDb({ shown: {} });
    console.log('Shown-games database cleared.');
    return;
  }

  const db = loadDb();
  let games;
  try {
    try {
      games = await openSchedule(HEADED);
    } catch (e) {
      if (e instanceof BlockedError && !HEADED) {
        console.log('The site blocked the background browser. Retrying with a visible window...');
        games = await openSchedule(true);
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error('\nSomething went wrong: ' + e.message);
    console.error(`Saved the page to ${CONFIG.debugFile} for troubleshooting.`);
    process.exitCode = 1;
    return;
  }

  if (!games.length) {
    console.log('\nNo games found. The schedule may not be published yet.');
    console.log(`(Saved the page to ${CONFIG.debugFile} in case something went wrong.)`);
    return;
  }

  const fresh = games.filter((g) => !db.shown[gameKey(g)]);
  const toShow = SHOW_ALL ? games : fresh;

  console.log(`\n${CONFIG.schedule} - ${CONFIG.season}`);
  console.log(`${games.length} games on the schedule, ${fresh.length} new.\n`);

  if (!toShow.length) {
    console.log('Nothing new since last time.');
  } else {
    toShow.forEach((g) => console.log(formatGame(g) + '\n'));
  }

  if (!SHOW_ALL) {
    const now = new Date().toISOString();
    for (const g of fresh) db.shown[gameKey(g)] = { firstShown: now, game: g };
    saveDb(db);
  }
})();
