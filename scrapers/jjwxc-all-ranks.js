/**
 * 晋江文学城全榜单抓取器（扩展版）
 *
 * 覆盖全部 topten.php 榜单，纯 HTTP 抓取（GBK 编码，自动解压 gzip/deflate）。
 *
 * 榜单体系（orderstr → 名称 → 页面结构）：
 *   table 结构（全站 200 本/性向）：3 新晋作者榜 / 5 月榜 / 7 总分榜 / 15 勤奋指数 / 21 千字金榜
 *     - topten.php 的 t 参数为性向选择：t=0 言情 / t=1 纯爱 / t=6 百合 / t=4 无CP+多元
 *     - 循环抓取全部性向并合并，每本书打 sex 标记（言情/纯爱/百合/无CP/多元）
 *   ul    结构（按频道分组，每频道约 24 本，已含全频道）：12 收入金榜 / 16 完结金榜 / 17 新手金榜
 *
 * 输出：
 *   data/jjwxc/ranks/latest.json            —— 全部榜单最新数据（前端/分析读取）
 *   data/jjwxc/ranks/history/YYYY-MM-DD.json —— 每日快照（历史趋势）
 *   data/jjwxc/ranks/index.json             —— 日期索引（最近 90 天）
 *
 * 用法：
 *   node scrapers/jjwxc-all-ranks.js          # 抓全部榜单
 *   node scrapers/jjwxc-all-ranks.js --quick   # 只抓新人向榜单(3,17,15)
 */

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { withRetry } = require('./retry');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data', 'jjwxc', 'ranks');
const BASE_URL = 'https://www.jjwxc.net/topten.php';
const REQUEST_DELAY = 1500;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Referer': 'https://www.jjwxc.net/',
};

// 榜单定义：type = table | ul
const RANKS = [
  { order: '3',  name: '新晋作者榜', type: 'table' },
  { order: '5',  name: '月榜',       type: 'table' },
  { order: '7',  name: '总分榜',     type: 'table' },
  { order: '12', name: '收入金榜',   type: 'ul' },
  { order: '15', name: '勤奋指数',   type: 'table' },
  { order: '16', name: '完结金榜',   type: 'ul' },
  { order: '17', name: '新手金榜',   type: 'ul' },
  { order: '21', name: '千字金榜',   type: 'table' },
];

// table 型榜单的性向频道参数（t 值）
const SEX_PARAMS = [
  { t: '0', sex: '言情' },
  { t: '1', sex: '纯爱' },
  { t: '6', sex: '百合' },
  { t: '4', sex: '无CP+多元' },
];

const NEWBIE_RANKS = ['3', '17', '15']; // 新人向：新晋作者榜/新手金榜/勤奋指数

// ========== 工具函数 ==========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function getNowBJT() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function httpGet(url, encoding = 'gbk') {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: HEADERS, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirect = res.headers.location;
        if (redirect.startsWith('/')) {
          const parsed = new URL(url);
          redirect = `${parsed.protocol}//${parsed.host}${redirect}`;
        }
        return httpGet(redirect, encoding).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let dec = buffer;
        const ce = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (ce.includes('gzip')) dec = zlib.gunzipSync(buffer);
          else if (ce.includes('deflate')) dec = zlib.inflateSync(buffer);
        } catch (e) {}
        let data;
        try { data = new (require('util').TextDecoder)(encoding).decode(dec); }
        catch (e) { data = dec.toString('utf-8'); }
        resolve({ status: res.statusCode, data });
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function cleanText(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ========== 分类解析（与 jjwxc.js 一致）==========
function parseAttrs(attrText) {
  const parts = cleanText(attrText).split('-').map(s => s.trim()).filter(Boolean);
  const nature = parts[0] || '';   // 原创/衍生
  const genre  = parts[1] || '';   // 纯爱/言情/百合/无CP → 主分类
  const era    = parts[2] || '';
  const theme  = parts[3] || '';
  const primaryTag = genre || era || theme || '未分类';
  return { nature, genre, era, theme, primaryTag };
}

// ========== table 结构解析（新晋/月榜/总分/勤奋/千字）==========
function parseTable(html, sex) {
  const books = [];
  const rows = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  let rank = 0;
  for (const row of rows) {
    const rowHtml = row[1];
    if (rowHtml.includes('序号') || rowHtml.includes('作品积分')) continue;
    if (!rowHtml.includes('onebook.php')) continue;
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 7) continue;
    rank++;

    const authorTitleMatch = cells[1]?.match(/<a[^>]*title="([^"]*)"/) || cells[1]?.match(/<a[^>]*>([^<]+)<\/a>/);
    const author = authorTitleMatch ? authorTitleMatch[1].trim() : '';
    const authorIdMatch = cells[1]?.match(/authorid=(\d+)/);
    const authorUrl = authorIdMatch ? `https://www.jjwxc.net/oneauthor.php?authorid=${authorIdMatch[1]}` : '';

    const m = cells[2]?.match(/<a[^>]*href="onebook\.php\?novelid=(\d+)"[^>]*title="([^"]*)"/)
      || cells[2]?.match(/<a[^>]*title="([^"]*)"[^>]*href="onebook\.php\?novelid=(\d+)"/);
    let bookName = '', bookId = '';
    if (m) {
      if (m[0].indexOf('href') < m[0].indexOf('title')) { bookId = m[1]; bookName = m[2]; }
      else { bookName = m[1]; bookId = m[2]; }
    } else {
      const idF = cells[2]?.match(/novelid=(\d+)/);
      if (idF) bookId = idF[1];
      const nF = cells[2]?.match(/<a[^>]*>([^<]+)<\/a>/);
      if (nF) bookName = nF[1];
    }
    bookName = cleanText(bookName).replace(/ /g, '');
    if (!bookName || bookName === '作品') continue;

    const { nature, genre, era, theme, primaryTag } = parseAttrs(cells[3]);
    const statusText = cleanText(cells[4]);
    let status = '未知';
    if (statusText.includes('连载')) status = '连载中';
    else if (statusText.includes('完结') || statusText.includes('完成')) status = '完结';

    const wordCount = parseInt(cleanText(cells[5]).replace(/,/g, '')) || 0;
    const score = parseInt(cleanText(cells[6]).replace(/,/g, '').replace(/\s/g, '')) || 0;

    books.push({
      rank, book_id: bookId, book_name: bookName, author,
      channel: genre || '未知', sex, nature, genre, era, theme, primary_tag: primaryTag,
      secondary_tags: [era, theme].filter(Boolean),
      all_tags: [nature, genre, era, theme].filter(Boolean),
      score, word_count: wordCount,
      status, book_url: `https://www.jjwxc.net/onebook.php?novelid=${bookId}`, author_url: authorUrl,
    });
  }
  return books;
}

// ========== ul 结构解析（收入/完结/新手金榜，按频道分组）==========
function parseUl(html) {
  const groups = [];
  const uls = html.matchAll(/<ul[^>]*class="list_01"[^>]*>([\s\S]*?)<\/ul>/gi);
  const h5s = [...html.matchAll(/<h5[^>]*>([\s\S]*?)<\/h5>/gi)].map(m => cleanText(m[1]).replace(/ /g, ''));

  let i = 0;
  for (const ul of uls) {
    const channelName = h5s[i] || `频道${i + 1}`;
    i++;
    const books = [];
    const lis = ul[1].matchAll(/<li>([\s\S]*?)<\/li>/gi);
    let rank = 0;
    for (const li of lis) {
      const liHtml = li[1];
      if (!liHtml.includes('onebook.php')) continue;
      rank++;
      const m = liHtml.match(/href="onebook\.php\?novelid=(\d+)"[^>]*title="([^"]*)"/)
        || liHtml.match(/title="([^"]*)"[^>]*href="onebook\.php\?novelid=(\d+)"/);
      let bookName = '', bookId = '';
      if (m) {
        if (m[0].indexOf('href') < m[0].indexOf('title')) { bookId = m[1]; bookName = m[2]; }
        else { bookName = m[1]; bookId = m[2]; }
      } else {
        const idF = liHtml.match(/novelid=(\d+)/);
        if (idF) bookId = idF[1];
        const nF = liHtml.match(/<a[^>]*>([^<]+)<\/a>/);
        if (nF) bookName = nF[1];
      }
      bookName = cleanText(bookName).replace(/ /g, '');
      if (!bookName) continue;
      const aMatch = liHtml.match(/href="oneauthor\.php\?authorid=(\d+)"[^>]*>[\s\S]*?<span class="author">([^<]+)<\/span>/)
        || liHtml.match(/oneauthor\.php\?authorid=(\d+)/);
      const author = aMatch && aMatch[2] ? aMatch[2].trim() : '';
      const authorId = aMatch ? aMatch[1] : '';
      books.push({
        rank, book_id: bookId, book_name: bookName, author,
        channel: channelName, genre: channelName, primary_tag: channelName,
        secondary_tags: [], all_tags: [channelName],
        score: 0, word_count: 0, status: '未知',
        book_url: `https://www.jjwxc.net/onebook.php?novelid=${bookId}`,
        author_url: authorId ? `https://www.jjwxc.net/oneauthor.php?authorid=${authorId}` : '',
      });
    }
    if (books.length > 0) groups.push({ channel: channelName, books });
  }
  return groups;
}

// ========== 主函数 ==========
async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const now = getNowBJT();
  const today = fmtDate(now);
  const dateTime = fmtDateTime(now);

  console.log('='.repeat(60));
  console.log(`晋江文学城全榜单抓取器 - ${dateTime}${quick ? ' (quick模式: 新人向榜单)' : ''}`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  const selected = quick ? RANKS.filter(r => NEWBIE_RANKS.includes(r.order)) : RANKS;
  const results = {};

  for (const r of selected) {
    process.stdout.write(`\n→ ${r.name} (orderstr=${r.order}) ... `);
    try {
      if (r.type === 'table') {
        // table 型：循环抓取全部性向频道并合并（t=0言情/t=1纯爱/t=6百合/t=4无CP+多元）
        let allBooks = [];
        const sexSummary = [];
        for (const sp of SEX_PARAMS) {
          const url = `${BASE_URL}?orderstr=${r.order}&t=${sp.t}`;
          try {
            const res = await withRetry(() => httpGet(url, 'gbk'), { name: `${r.name}(${sp.sex})`, maxAttempts: 3, baseDelay: 5000 });
            const books = parseTable(res.data, sp.sex);
            allBooks = allBooks.concat(books);
            sexSummary.push(`${sp.sex}${books.length}`);
          } catch (e) {
            console.log(`  [${sp.sex}] FAIL: ${e.message.slice(0, 50)}`);
          }
          await sleep(REQUEST_DELAY);
        }
        allBooks.sort((a, b) => a.rank - b.rank);
        results[r.order] = { name: r.name, order: r.order, type: 'table', total: allBooks.length, sex_summary: sexSummary, books: allBooks };
        console.log(`合计 ${allBooks.length} 本 (${sexSummary.join(' / ')})`);
      } else {
        const url = `${BASE_URL}?orderstr=${r.order}&t=0`;
        const res = await withRetry(() => httpGet(url, 'gbk'), { name: r.name, maxAttempts: 3, baseDelay: 5000 });
        const groups = parseUl(res.data);
        const total = groups.reduce((s, g) => s + g.books.length, 0);
        results[r.order] = { name: r.name, order: r.order, type: 'ul', total, channels: groups.length, books: groups };
        console.log(`${groups.length} 个频道 / ${total} 本`);
      }
      if (r.order !== selected[selected.length - 1].order) await sleep(REQUEST_DELAY);
    } catch (e) {
      console.log(`FAIL: ${e.message.slice(0, 60)}`);
    }
  }

  // 统计
  const emptyRanks = Object.values(results).filter(r => (r.books.length === 0));
  const summary = {
    update_time: dateTime,
    update_date: today,
    source: 'https://www.jjwxc.net/topten.php',
    platform: 'jjwxc',
    ranks: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { name: r.name, total: r.total || (r.books.reduce((s, g) => s + g.books.length, 0)), channels: r.channels || null, sex_summary: r.sex_summary || null, empty: r.books.length === 0 }])),
  };

  const latestPath = path.join(DATA_DIR, 'latest.json');
  fs.writeFileSync(latestPath, JSON.stringify({ summary, ranks: results }, null, 2), 'utf-8');
  const histPath = path.join(DATA_DIR, 'history', `${today}.json`);
  fs.writeFileSync(histPath, JSON.stringify({ summary, ranks: results }, null, 2), 'utf-8');

  const idxPath = path.join(DATA_DIR, 'index.json');
  let idx = [];
  if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch (e) {} }
  if (!idx.includes(today)) idx.unshift(today);
  idx = idx.slice(0, 90);
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 完成！共抓取 ${Object.keys(results).length} 个榜单`);
  if (emptyRanks.length > 0) console.log(`⚠️ 空榜单: ${emptyRanks.map(r => `${r.name}(${r.order})`).join(', ')}`);
  console.log(`   数据: ${latestPath}`);
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
