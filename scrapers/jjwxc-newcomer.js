/**
 * 晋江新人加权分析模块
 *
 * 读取晋江全榜单数据 (data/jjwxc/ranks/latest.json)，
 * 从新人作者视角计算：
 *   1. 赛道门槛友好度 —— 各性向/频道的新晋门槛（积分 P25/P50/P75、字数中位、连载占比、友好度指数）
 *   2. 新人题材风向 —— 新晋作者榜的年代×主题分布
 *   3. 新人成长路径 —— 新晋作者榜/新手金榜/勤奋指数/月榜 之间的作者交叉
 *   4. AI 文本解读 —— 有 QWEN_API_KEY 时调用通义千问生成新人向解读
 *
 * 输出：data/jjwxc/newcomer.json（前端/展示读取）
 *
 * 用法：node scrapers/jjwxc-newcomer.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, '..', 'data');
const RANKS_FILE = path.join(DATA_DIR, 'jjwxc', 'ranks', 'latest.json');
const OUT_FILE = path.join(DATA_DIR, 'jjwxc', 'newcomer.json');
const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const QWEN_API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// 新晋作者榜 orderstr=3（table 结构，books 为数组，含 sex 字段）
const NEW_AUTHOR_RANK = '3';
// ul 结构榜单（books 为分组数组 [{channel, books:[...]}]）
const UL_RANKS = { '12': '收入金榜', '16': '完结金榜', '17': '新手金榜' };
// table 结构榜单（books 为数组）
const TABLE_RANKS = { '5': '月榜', '7': '总分榜', '15': '勤奋指数', '21': '千字金榜' };

// ========== 工具函数 ==========
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

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {}
  return null;
}

// 取某一榜单的所有书（统一 table/ul 结构差异）
function getAllBooks(rank) {
  if (!rank || !Array.isArray(rank.books)) return [];
  // ul 结构：books 为 [{channel, books:[...]}]
  if (rank.books.length > 0 && rank.books[0] && Array.isArray(rank.books[0].books)) {
    return rank.books.flatMap(g => g.books.map(b => ({ ...b, channel: g.channel, _grouped: true })));
  }
  return rank.books;
}

// 分位数
function quantile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return Math.round(sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo));
}
function median(sortedArr) { return quantile(sortedArr, 0.5); }
function percentileArr(nums, p) { return quantile([...nums].sort((a, b) => a - b), p); }

// 友好度指数（0-100，越高越对新人友好）
//  50% 积分门槛（越低越友好）+ 30% 字数要求（越低越友好）+ 20% 连载友好（连载占比越高越友好）
function friendlinessScore(stat, allStats) {
  const maxScore = Math.max(...allStats.map(s => s.score_p50));
  const maxWord = Math.max(...allStats.map(s => s.word_median));
  const scorePart = maxScore ? 50 * (1 - stat.score_p50 / maxScore) : 50;
  const wordPart = maxWord ? 30 * (1 - stat.word_median / maxWord) : 30;
  const serialPart = 20 * (stat.serial_pct || 0);
  return Math.round(scorePart + wordPart + serialPart);
}

// ========== 1. 赛道门槛友好度 ==========
function analyzeThresholds(newBooks) {
  const bySex = {};
  for (const b of newBooks) {
    const sex = b.sex || '未知';
    if (!bySex[sex]) bySex[sex] = { scores: [], words: [], serial: 0, count: 0, eras: {}, themes: {} };
    bySex[sex].scores.push(b.score || 0);
    bySex[sex].words.push(b.word_count || 0);
    bySex[sex].serial += b.status === '连载中' ? 1 : 0;
    bySex[sex].count++;
    bySex[sex].eras[b.era || '未知'] = (bySex[sex].eras[b.era || '未知'] || 0) + 1;
    bySex[sex].themes[b.theme || '未知'] = (bySex[sex].themes[b.theme || '未知'] || 0) + 1;
  }

  const stats = [];
  for (const [sex, d] of Object.entries(bySex)) {
    const scoreP25 = percentileArr(d.scores, 0.25);
    const scoreP50 = percentileArr(d.scores, 0.5);
    const scoreP75 = percentileArr(d.scores, 0.75);
    const wordMedian = median(d.words.sort((a, b) => a - b));
    stats.push({
      sex,
      count: d.count,
      score_p25: scoreP25,
      score_p50: scoreP50,
      score_p75: scoreP75,
      word_median: wordMedian,
      serial_pct: d.count ? Math.round(d.serial / d.count * 100) / 100 : 0,
      top_eras: Object.entries(d.eras).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}${v}`).join(' '),
      top_themes: Object.entries(d.themes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}${v}`).join(' '),
    });
  }
  stats.sort((a, b) => a.score_p50 - b.score_p50);
  for (const s of stats) s.friendliness = friendlinessScore(s, stats);

  return {
    generated_from: '新晋作者榜（30天内新作者，按积分）',
    summary: stats.map(s => `${s.sex}友好度${s.friendliness}（积分中位${s.score_p50.toLocaleString()}）`).join(' / '),
    by_sex: stats,
  };
}

// ========== 2. 新人题材风向 ==========
function analyzeTrends(newBooks) {
  const era = {};
  const theme = {};
  const eraTheme = {};
  for (const b of newBooks) {
    const e = b.era || '未知';
    const t = b.theme || '未知';
    era[e] = (era[e] || 0) + 1;
    theme[t] = (theme[t] || 0) + 1;
    const key = `${e}×${t}`;
    eraTheme[key] = (eraTheme[key] || 0) + 1;
  }
  return {
    total: newBooks.length,
    era: Object.entries(era).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ tag: k, count: v, pct: Math.round(v / newBooks.length * 100) })),
    theme: Object.entries(theme).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ tag: k, count: v, pct: Math.round(v / newBooks.length * 100) })),
    era_theme_top: Object.entries(eraTheme).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => ({ combo: k, count: v })),
    summary: Object.entries(theme).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}${v}本(${Math.round(v / newBooks.length * 100)}%)`).join('、'),
  };
}

// ========== 3. 新人成长路径 ==========
function analyzePathways(allRanks) {
  const authorId = b => (b.author_url || '').split('authorid=')[1];
  const bookKey = b => b.book_id;

  const collect = (order) => {
    const books = getAllBooks(allRanks[order]);
    return {
      name: (allRanks[order] || {}).name || order,
      books,
      authorSet: new Set(books.map(authorId).filter(Boolean)),
      bookSet: new Set(books.map(bookKey).filter(Boolean)),
    };
  };

  const newAuthor = collect(NEW_AUTHOR_RANK);
  const hand = collect('17');
  const dil = collect('15');
  const month = collect('5');

  const overlapAuthors = (A, B) => {
    const inter = [...A.authorSet].filter(a => B.authorSet.has(a));
    return { count: inter.length, sample: inter.slice(0, 10) };
  };
  const overlapBooks = (A, B) => {
    const inter = [...A.bookSet].filter(b => B.bookSet.has(b));
    return { count: inter.length };
  };

  return {
    explain: '新晋作者榜=30天内新作者积分榜；新手金榜=新手频道榜；勤奋指数=更新频率榜；月榜=发表11-40天积分榜。作者交叉越多说明成长路径越通畅。',
    authors: {
      new_to_hand: overlapAuthors(newAuthor, hand),
      new_to_diligence: overlapAuthors(newAuthor, dil),
      new_to_month: overlapAuthors(newAuthor, month),
      hand_to_diligence: overlapAuthors(hand, dil),
      hand_to_month: overlapAuthors(hand, month),
      diligence_to_month: overlapAuthors(dil, month),
    },
    books: {
      new_to_month: overlapBooks(newAuthor, month),
    },
    note: '单日快照仅反映当前同时上榜情况；连续运行后可追踪同一作者跨日成长。',
  };
}

// ========== 4. AI 文本解读 ==========
function callQwenAPI(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'qwen-plus',
      messages,
      temperature: 0.7,
      max_tokens: 1500,
    });
    const url = new URL(QWEN_API_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${QWEN_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices?.[0]?.message?.content) resolve(json.choices[0].message.content);
          else if (json.error) reject(new Error(`API Error: ${json.error.message || ''}`));
          else reject(new Error('Unexpected response'));
        } catch (e) { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function generateAIInsight(thresholds, trends, pathways) {
  const systemPrompt = `你是一位资深网络文学编辑，特别擅长辅导晋江文学城的新人作者。请基于以下晋江新晋作者榜的分析数据，为想入行的新人作者写一段解读。

数据说明：
- 新晋作者榜 = 注册成为作者30天内发的文按积分排序，31天后下榜，是晋江最直接的"新人信号"
- 友好度指数 = 0-100，越高说明该性向/赛道对新作者门槛越低
- 积分中位数越低 → 新书更容易上榜

请从新人作者视角，给出（输出纯文本，勿用markdown标题）：
1. 哪个性向最值得新手考虑？为什么（结合友好度、门槛、题材热度）
2. 当前新人题材风向是什么？结合年代×主题组合
3. 想上榜的新人应该注意什么（字数、连载节奏等）？

要具体、可执行、不要泛泛而谈，结合给出的数字。`;

  const dataBlock = [
    `【赛道门槛友好度】\n${thresholds.summary}\n\n各性向详情:\n${thresholds.by_sex.map(s =>
      `- ${s.sex}: 友好度${s.friendliness}, 积分中位${s.score_p50.toLocaleString()}(P25 ${s.score_p25.toLocaleString()}/P75 ${s.score_p75.toLocaleString()}), 字数中位${s.word_median}, 连载占比${(s.serial_pct * 100).toFixed(0)}%, 热门年代[${s.top_eras}], 热门主题[${s.top_themes}]`
    ).join('\n')}`,
    `【新人题材风向】\n${trends.summary}\n\n年代分布: ${trends.era.slice(0, 6).map(e => `${e.tag}${e.pct}%`).join(' ')}\n主题分布Top8: ${trends.theme.slice(0, 8).map(t => `${t.tag}${t.pct}%`).join(' ')}\n年代×主题组合Top6: ${trends.era_theme_top.slice(0, 6).map(c => `${c.combo}(${c.count})`).join(' ')}`,
    `【成长路径】\n新晋作者榜→月榜 作者交叉: ${pathways.authors.new_to_month.count}\n新手金榜→勤奋指数 作者交叉: ${pathways.authors.hand_to_diligence.count}\n新晋→勤奋指数: ${pathways.authors.new_to_diligence.count}`,
  ].join('\n\n');

  const response = await callQwenAPI([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `以下是今日数据：\n\n${dataBlock}` },
  ]);
  return response.trim();
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`晋江新人加权分析 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  const data = readJSON(RANKS_FILE);
  if (!data) {
    console.error('❌ 未找到晋江全榜单数据，先运行 scrapers/jjwxc-all-ranks.js');
    process.exit(1);
  }

  const allRanks = data.ranks || {};
  const newBooks = getAllBooks(allRanks[NEW_AUTHOR_RANK]);
  if (!newBooks.length) {
    console.error('❌ 新晋作者榜数据为空');
    process.exit(1);
  }
  console.log(`  新晋作者榜: ${newBooks.length} 本`);

  console.log('\n📊 计算赛道门槛友好度...');
  const thresholds = analyzeThresholds(newBooks);
  console.log(`  ${thresholds.summary}`);

  console.log('\n📈 分析新人题材风向...');
  const trends = analyzeTrends(newBooks);
  console.log(`  ${trends.summary}`);

  console.log('\n🔀 分析新人成长路径...');
  const pathways = analyzePathways(allRanks);
  console.log(`  新晋→月榜: ${pathways.authors.new_to_month.count} 位作者`);

  const result = {
    update_date: fmtDate(now),
    update_time: fmtDateTime(now),
    platform: 'jjwxc',
    generated_by: 'jjwxc-newcomer',
    thresholds,
    trends,
    pathways,
    ai_insight: null,
  };

  // AI 解读
  if (QWEN_API_KEY) {
    console.log('\n🤖 调用 AI 生成新人解读...');
    try {
      result.ai_insight = await generateAIInsight(thresholds, trends, pathways);
      console.log('  ✓ AI 解读完成');
    } catch (e) {
      console.log(`  [WARN] AI 解读失败: ${e.message.slice(0, 50)}`);
    }
  } else {
    console.log('\n⚠️ 未设置 QWEN_API_KEY，跳过 AI 解读（仅输出结构化分析）');
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\n✅ 分析已保存: ${OUT_FILE}`);
}

main().catch(e => {
  console.error('致命错误:', e);
  process.exit(1);
});
