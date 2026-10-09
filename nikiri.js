/**
 * language: Node.js (ESM)
 * file: thenkiri-scraper.js
 * target: thenkiri.com.ng (WP + downloadwella.com XFileSharing)
 *
 * Endpoints unified:
 *   search(query)          → WP REST /wp/v2/posts?search=
 *   categories()           → WP REST /wp/v2/categories
 *   listByCategory(slug)   → WP REST posts?categories=
 *   latest(limit)          → WP REST posts + RSS /feed/
 *   getPost(slug|id|url)   → WP REST + HTML parse fallback
 *   resolveDownload(url)   → downloadwella POST op=download2 → direct CDN
 *   fullPipeline(query)    → search → detail → every episode/movie file URL
 *
 * Ads / trackers ignored by design.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { writeFileSync } from 'fs';

const BASE = 'https://thenkiri.com.ng';
const REST = `${BASE}/wp-json/wp/v2`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const jar = new CookieJar();
const http = wrapper(
  axios.create({
    jar,
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/json,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  })
);

// ─── helpers ───────────────────────────────────────────────────────────────

function stripHtml(html = '') {
  return cheerio.load(html || '').text().replace(/\s+/g, ' ').trim();
}

function extractWellaLinks(html) {
  const $ = cheerio.load(html || '');
  const out = [];
  $('a.btnButton, a[href*="downloadwella.com"], a[href*="downloadwella"]').each((_, el) => {
    const href = $(el).attr('href');
    const label = $(el).text().trim() || 'DOWNLOAD';
    if (href && /downloadwella\.com/i.test(href)) {
      out.push({ label, wellaUrl: href });
    }
  });
  // also pull from button-block data-attributes JSON buried in content
  const re = /downloadwella\.com\/[a-z0-9]+\/[^"'\\\s]+\.html/gi;
  const raw = html || '';
  let m;
  while ((m = re.exec(raw))) {
    const u = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
    if (!out.some((x) => x.wellaUrl === u)) out.push({ label: 'DOWNLOAD', wellaUrl: u });
  }
  return out;
}

function parseEpisodes(html) {
  // series pages: "Episode N" heading then DOWNLOAD EPISODE link
  const $ = cheerio.load(html || '');
  const eps = [];
  $('h2, h3, h4, strong, p').each((_, el) => {
    const t = $(el).text().trim();
    const em = t.match(/Episode\s+(\d+)/i);
    if (em) {
      let link = null;
      let n = $(el);
      for (let i = 0; i < 6 && !link; i++) {
        n = n.next();
        if (!n.length) break;
        const a = n.find('a[href*="downloadwella"]').first();
        if (a.length) link = a.attr('href');
        else if (n.is('a') && /downloadwella/i.test(n.attr('href') || '')) link = n.attr('href');
      }
      if (link) eps.push({ episode: Number(em[1]), label: t, wellaUrl: link });
    }
  });
  return eps;
}

// ─── WP surface ────────────────────────────────────────────────────────────

export async function categories() {
  const { data } = await http.get(`${REST}/categories`, {
    params: { per_page: 100 },
  });
  return data.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    count: c.count,
    url: c.link,
  }));
}

export async function search(query, { page = 1, perPage = 20 } = {}) {
  const { data, headers } = await http.get(`${REST}/posts`, {
    params: {
      search: query,
      page,
      per_page: perPage,
      _fields: 'id,slug,link,title,excerpt,date,modified,categories,featured_media,content',
    },
  });
  const total = Number(headers['x-wp-total'] || data.length);
  return {
    total,
    page,
    results: data.map(normalizePost),
  };
}

export async function listByCategory(categoryIdOrSlug, { page = 1, perPage = 20 } = {}) {
  let catId = categoryIdOrSlug;
  if (typeof categoryIdOrSlug === 'string' && !/^\d+$/.test(categoryIdOrSlug)) {
    const cats = await categories();
    const hit = cats.find((c) => c.slug === categoryIdOrSlug);
    if (!hit) throw new Error(`unknown category slug: ${categoryIdOrSlug}`);
    catId = hit.id;
  }
  const { data, headers } = await http.get(`${REST}/posts`, {
    params: {
      categories: catId,
      page,
      per_page: perPage,
      _fields: 'id,slug,link,title,excerpt,date,modified,categories,content',
    },
  });
  return {
    total: Number(headers['x-wp-total'] || data.length),
    page,
    results: data.map(normalizePost),
  };
}

export async function latest({ limit = 20 } = {}) {
  const { data } = await http.get(`${REST}/posts`, {
    params: {
      per_page: limit,
      orderby: 'date',
      order: 'desc',
      _fields: 'id,slug,link,title,excerpt,date,modified,categories,content',
    },
  });
  return data.map(normalizePost);
}

export async function getPost(slugOrIdOrUrl) {
  let post;
  if (typeof slugOrIdOrUrl === 'number' || /^\d+$/.test(String(slugOrIdOrUrl))) {
    const { data } = await http.get(`\( {REST}/posts/ \){slugOrIdOrUrl}`);
    post = data;
  } else {
    let slug = String(slugOrIdOrUrl);
    const m = slug.match(/thenkiri\.com(?:\.ng)?\/([^/?#]+)/i);
    if (m) slug = m[1].replace(/\/$/, '');
    const { data } = await http.get(`${REST}/posts`, {
      params: { slug, _fields: 'id,slug,link,title,excerpt,date,modified,categories,content,featured_media' },
    });
    if (!data?.length) throw new Error(`post not found: ${slug}`);
    post = data[0];
  }
  return normalizePost(post, true);
}

function normalizePost(p, deep = false) {
  const html = p.content?.rendered || '';
  const base = {
    id: p.id,
    slug: p.slug,
    url: p.link,
    title: stripHtml(p.title?.rendered || p.title || ''),
    excerpt: stripHtml(p.excerpt?.rendered || ''),
    date: p.date,
    modified: p.modified,
    categories: p.categories || [],
  };
  if (!deep && !html) return base;

  const wella = extractWellaLinks(html);
  const episodes = parseEpisodes(html);
  // synopsis: first paragraph under Synopsis heading
  const $ = cheerio.load(html);
  let synopsis = '';
  $('h2, h3').each((_, el) => {
    if (/synopsis/i.test($(el).text())) {
      synopsis = $(el).nextAll('p').first().text().trim();
    }
  });
  if (!synopsis) synopsis = $('p').first().text().trim();

  return {
    ...base,
    synopsis,
    downloadButtons: wella, // movie-style single/multi buttons
    episodes, // series-style Episode N → wella
    rawContentLength: html.length,
  };
}

// ─── downloadwella resolver (XFileSharing Pro) ─────────────────────────────

/**
 * Input: any https://downloadwella.com/<id>/<filename>.html
 * Output: { filename, sizeBytes, sizeLabel, directUrl, expiresNote }
 */
export async function resolveDownload(wellaUrl) {
  if (!/downloadwella\.com/i.test(wellaUrl)) {
    throw new Error('not a downloadwella url');
  }

  // fresh jar per resolve keeps IP token clean
  const localJar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar: localJar,
      timeout: 45000,
      maxRedirects: 5,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    })
  );

  // 1) GET landing — establish session + read file id
  const land = await client.get(wellaUrl);
  const $1 = cheerio.load(land.data);
  const id =
    $1('input[name="id"]').attr('value') ||
    wellaUrl.match(/downloadwella\.com\/([a-z0-9]+)\//i)?.[1];
  if (!id) throw new Error('could not extract file id from wella page');

  // 2) POST op=download2 (free path) — generates IP-bound direct link (\~8h)
  const body = new URLSearchParams({
    op: 'download2',
    id,
    rand: $1('input[name="rand"]').attr('value') || '',
    referer: '',
    method_free: '',
    method_premium: '',
  });

  const gen = await client.post(wellaUrl, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://downloadwella.com',
      Referer: wellaUrl,
    },
  });

  const $2 = cheerio.load(gen.data);
  let direct =
    $2('a[href*="dwbe"]').attr('href') ||
    $2('a:contains("Start download")').attr('href') ||
    null;

  if (!direct) {
    const m = String(gen.data).match(
      /https:\/\/dwbe\d*\.downloadwella\.com\/d\/[a-z0-9]+\/[^"'\\\s]+/i
    );
    if (m) direct = m[0];
  }
  if (!direct) {
    throw new Error('direct link not issued — possible captcha / rate-limit / premium gate');
  }

  const filename =
    $2('h2, .filename, #icod').text().match(/[\w.\-()]+\.mkv|[\w.\-()]+\.mp4/i)?.[0] ||
    decodeURIComponent(direct.split('/').pop());
  const sizeLabel =
    gen.data.match(/Size:\s*([0-9.]+\s*[KMGT]?B)/i)?.[1] ||
    $1('td, .size, .filesize').text().match(/[0-9.]+\s*[KMGT]?B/)?.[0] ||
    null;
  const sizeBytes = gen.data.match(/\((\d+)\s*bytes\)/i)?.[1]
    ? Number(RegExp.$1)
    : null;

  return {
    filename,
    sizeLabel,
    sizeBytes,
    directUrl: direct,
    expiresNote: 'IP-bound \~8 hours (XFS free path)',
    wellaId: id,
  };
}

// ─── unified pipelines ─────────────────────────────────────────────────────

/**
 * Search → every matching post → every wella button / episode → direct CDN URL
 */
export async function fullPipeline(query, { resolveFiles = true, maxPosts = 5 } = {}) {
  const { results } = await search(query, { perPage: maxPosts });
  const out = [];

  for (const r of results) {
    const post = await getPost(r.id);
    const targets = [];

    if (post.episodes?.length) {
      for (const ep of post.episodes) {
        targets.push({ kind: 'episode', episode: ep.episode, label: ep.label, wellaUrl: ep.wellaUrl });
      }
    } else {
      for (const b of post.downloadButtons || []) {
        targets.push({ kind: 'movie', label: b.label, wellaUrl: b.wellaUrl });
      }
    }

    const files = [];
    for (const t of targets) {
      const entry = { ...t };
      if (resolveFiles) {
        try {
          entry.resolved = await resolveDownload(t.wellaUrl);
        } catch (e) {
          entry.resolveError = e.message;
        }
      }
      files.push(entry);
    }

    out.push({
      id: post.id,
      title: post.title,
      url: post.url,
      synopsis: post.synopsis,
      files,
    });
  }
  return out;
}

export async function getDirectsForPost(slugOrIdOrUrl) {
  const post = await getPost(slugOrIdOrUrl);
  const targets = post.episodes?.length
    ? post.episodes.map((e) => ({ kind: 'episode', episode: e.episode, label: e.label, wellaUrl: e.wellaUrl }))
    : (post.downloadButtons || []).map((b) => ({ kind: 'movie', label: b.label, wellaUrl: b.wellaUrl }));

  const files = [];
  for (const t of targets) {
    try {
      files.push({ ...t, resolved: await resolveDownload(t.wellaUrl) });
    } catch (e) {
      files.push({ ...t, resolveError: e.message });
    }
  }
  return { post: { id: post.id, title: post.title, url: post.url, synopsis: post.synopsis }, files };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === 'help') {
    console.log(`
thenkiri-scraper
  node thenkiri-scraper.js categories
  node thenkiri-scraper.js search <query>
  node thenkiri-scraper.js category <slug|id>
  node thenkiri-scraper.js latest [n]
  node thenkiri-scraper.js post <slug|id|url>
  node thenkiri-scraper.js resolve <wellaUrl>
  node thenkiri-scraper.js pipeline <query>          # search + resolve directs
  node thenkiri-scraper.js directs <slug|id|url>     # one post → all direct files
`);
    return;
  }

  let result;
  switch (cmd) {
    case 'categories':
      result = await categories();
      break;
    case 'search':
      result = await search(args.join(' ') || 'nickels');
      break;
    case 'category':
      result = await listByCategory(args[0] || 'k-drama');
      break;
    case 'latest':
      result = await latest({ limit: Number(args[0]) || 15 });
      break;
    case 'post':
      result = await getPost(args[0]);
      break;
    case 'resolve':
      result = await resolveDownload(args[0]);
      break;
    case 'pipeline':
      result = await fullPipeline(args.join(' ') || 'nickels', { resolveFiles: true, maxPosts: 3 });
      break;
    case 'directs':
      result = await getDirectsForPost(args[0]);
      break;
    default:
      throw new Error(`unknown cmd: ${cmd}`);
  }

  const json = JSON.stringify(result, null, 2);
  console.log(json);
  writeFileSync('thenkiri-out.json', json);
  console.error('\n→ wrote thenkiri-out.json');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
