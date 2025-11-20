import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";
import ProxyManager from "./proxy-manager.js";

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TMDB_API_KEY",
];

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const CONFIG = {
  homeUrl: "https://toonstream.love/",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 60_000),
  requestTimeout: 30_000,
  maxRetries: 3,
  maxParallelSeriesFetch: Number(process.env.MAX_PARALLEL_SERIES || 4),
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/original";

const seriesCache = new Map();
const processedEpisodes = new Set();
const proxyManager = new ProxyManager();

// Track which series are completely synced
const completedSeries = new Set();

// Statistics tracking
const stats = {
  newEpisodes: 0,
  updatedEpisodes: 0,
  failedEpisodes: 0,
  skippedEpisodes: 0,
  totalServers: 0,
  seriesProcessed: new Set(),
};

function makeEpisodeKey(slug, season, episode) {
  return `${slug}::${season}x${episode}`;
}

function makeSeasonEpisodeKey(season, episode) {
  return `${season}x${episode}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function cleanSlug(name) {
  return (name || "item")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeUrl(rawUrl, base = CONFIG.homeUrl) {
  if (!rawUrl || /^javascript:/i.test(rawUrl)) return null;
  try {
    return new URL(rawUrl, base).href;
  } catch {
    return null;
  }
}

function extractSeriesSlugFromUrl(seriesUrl) {
  try {
    const u = new URL(seriesUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.pop() || null;
  } catch {
    return null;
  }
}

function deriveSeriesUrlFromEpisode(episodeUrl) {
  try {
    const u = new URL(episodeUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const episodeSlug = parts[1] || parts[parts.length - 1] || "";
    if (!episodeSlug) return null;
    const baseSlug = episodeSlug.replace(/-\d+x\d+$/i, "") || episodeSlug;
    return `${CONFIG.homeUrl}series/${baseSlug}/`;
  } catch {
    return null;
  }
}

function buildSeriesUrlFromSlug(seriesSlug) {
  if (!seriesSlug) return null;
  return `${CONFIG.homeUrl}series/${seriesSlug}/`;
}

function buildEpisodeUrl(seriesSlug, season, episode) {
  if (!seriesSlug) return null;
  return `${CONFIG.homeUrl}episode/${seriesSlug}-${season}x${episode}/`;
}

async function fetchHtmlWithRetry(url, retries = CONFIG.maxRetries) {
  let lastErr = null;
  let currentProxy = null;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Get proxy for this attempt
      currentProxy = proxyManager.getNextProxy();
      const proxyAgent = proxyManager.getProxyAgent(currentProxy);
      
      const config = {
        timeout: CONFIG.requestTimeout,
        headers: {
          "User-Agent": getUA(),
          Referer: CONFIG.homeUrl,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      };
      
      // Add proxy agent if available
      if (proxyAgent) {
        config.httpAgent = proxyAgent;
        config.httpsAgent = proxyAgent;
      }
      
      const res = await axios.get(url, config);
      return String(res.data || "");
    } catch (err) {
      lastErr = err;
      
      // Mark proxy as failed if we're using one
      if (currentProxy && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT')) {
        proxyManager.markProxyAsFailed(currentProxy);
      }
      
      await delay(500 * attempt);
    }
  }
  throw new Error(
    `Failed to fetch ${url}: ${lastErr?.message || "unknown error"}`,
  );
}

async function searchTMDB(title, type = "tv") {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;
  const url = `${TMDB_BASE_URL}/search/${type}?api_key=${apiKey}&query=${encodeURIComponent(title)}&language=en-US`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json.results?.[0]?.id || null;
}

async function fetchTMDBDetails(tmdbId, type = "tv") {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || !tmdbId) return null;
  const url = `${TMDB_BASE_URL}/${type}/${tmdbId}?api_key=${apiKey}&language=en-US&append_to_response=images`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const posters = [];
  if (data.poster_path) posters.push(`${TMDB_IMAGE_BASE}${data.poster_path}`);
  data.images?.posters?.slice(0, 5).forEach((img) => {
    const src = `${TMDB_IMAGE_BASE}${img.file_path}`;
    if (!posters.includes(src)) posters.push(src);
  });
  const backdrops = [];
  if (data.backdrop_path)
    backdrops.push(`${TMDB_IMAGE_BASE}${data.backdrop_path}`);
  data.images?.backdrops?.slice(0, 5).forEach((img) => {
    const src = `${TMDB_IMAGE_BASE}${img.file_path}`;
    if (!backdrops.includes(src)) backdrops.push(src);
  });
  return {
    tmdb_id: data.id,
    title: data.name || data.title || null,
    description: data.overview || null,
    rating: data.vote_average ? parseFloat(data.vote_average.toFixed(2)) : null,
    popularity: data.popularity ? parseFloat(data.popularity.toFixed(3)) : null,
    status: data.status || null,
    genres: data.genres?.map((g) => g.name) || [],
    studios: data.production_companies?.map((c) => c.name) || [],
    release_date: data.first_air_date || data.release_date || null,
    total_seasons: data.number_of_seasons || null,
    total_episodes: data.number_of_episodes || null,
    runtime: data.runtime || null,
    posters,
    backdrops,
    poster: posters[0] || null,
    banner_image: backdrops[0] || null,
  };
}

async function getTMDBData(title, isMovie = false) {
  const type = isMovie ? "movie" : "tv";
  const tmdbId = await searchTMDB(title, type);
  if (!tmdbId) return null;
  return fetchTMDBDetails(tmdbId, type);
}

function extractEpisodeCards(html) {
  const $ = cheerio.load(html);
  const cards = [];
  const seen = new Set();
  $('a[href*="/episode/"], a[href*="/watch/"]').each((_, el) => {
    const anchor = $(el);
    const url = normalizeUrl(anchor.attr("href"));
    if (!url || seen.has(url)) return;
    seen.add(url);
    const title = (anchor.attr("title") || anchor.text()).trim();
    const img = anchor.find("img").first();
    const thumb = img.length
      ? normalizeUrl(img.attr("data-src") || img.attr("src"))
      : null;
    cards.push({ url, title, thumb });
  });
  return cards;
}

function extractSeriesEpisodeLinks(seriesHtml, seriesUrl) {
  const $ = cheerio.load(seriesHtml);
  const links = [];
  const seen = new Set();

  const addLink = (anchor) => {
    const node = $(anchor);
    const url = normalizeUrl(node.attr("href"), seriesUrl);
    if (!url || !url.includes("/episode/")) return;
    const code = parseEpisodeCode(url);
    if (!code) return;
    const key = `${code.season}x${code.episode}`;
    if (seen.has(key)) return;
    seen.add(key);

    const text = node.text().trim();
    const img = node.find("img").first();
    const thumb = img.length
      ? normalizeUrl(img.attr("data-src") || img.attr("src"), seriesUrl)
      : null;

    links.push({
      url,
      season: code.season,
      episode: code.episode,
      title: text,
      thumb,
    });
  };

  $('a[href*="/episode/"]').each((_, el) => addLink(el));
  return links.sort((a, b) => {
    if (a.season === b.season) return a.episode - b.episode;
    return a.season - b.season;
  });
}

function parseEpisodeCode(url) {
  const match = url.match(/(\d+)x(\d+)/i);
  if (!match) return null;
  return {
    season: parseInt(match[1], 10),
    episode: parseInt(match[2], 10),
  };
}

async function extractRealVideoUrl(intermediateUrl) {
  try {
    const html = await fetchHtmlWithRetry(intermediateUrl);
    const $ = cheerio.load(html);
    
    // First, try to find video tag with jw-video class (primary method)
    const videoTags = $('video.jw-video, video[class*="jw-video"]');
    for (let i = 0; i < videoTags.length; i++) {
      const video = $(videoTags[i]);
      const src = video.attr('src') || video.attr('data-src');
      
      if (src) {
        // The src might be a blob URL, so we need to find the actual source
        // Look for the real URL in the page's JavaScript
        const scripts = $('script').toArray();
        for (const script of scripts) {
          const content = $(script).html() || '';
          
          // Look for streaming URLs (common patterns for video hosts)
          const urlPatterns = [
            /https?:\/\/[a-zA-Z0-9.-]+\/[a-f0-9-]{36}/gi, // UUID pattern
            /https?:\/\/play\.[a-zA-Z0-9.-]+\/[a-f0-9-]+/gi, // play.domain.com/id
            /https?:\/\/[a-zA-Z0-9.-]+\/(?:video|stream|embed)\/[a-zA-Z0-9-]+/gi,
            /"file"\s*:\s*"(https?:\/\/[^"]+)"/gi,
            /"source"\s*:\s*"(https?:\/\/[^"]+)"/gi,
            /"src"\s*:\s*"(https?:\/\/[^"]+)"/gi,
          ];
          
          for (const pattern of urlPatterns) {
            const matches = content.matchAll(pattern);
            for (const match of matches) {
              const url = match[1] || match[0];
              if (url && !url.includes('trembed') && !url.includes('toonstream.love')) {
                const normalizedUrl = normalizeUrl(url);
                if (normalizedUrl && normalizedUrl !== intermediateUrl) {
                  return normalizedUrl;
                }
              }
            }
          }
        }
      }
    }
    
    // Second, try to find iframe with a src attribute
    const iframes = $('iframe');
    for (let i = 0; i < iframes.length; i++) {
      const iframe = $(iframes[i]);
      const src = iframe.attr('src') || iframe.attr('data-src') || iframe.attr('data-lazy-src');
      
      if (src) {
        const normalizedSrc = normalizeUrl(src);
        // Skip if it's the same intermediate URL (avoid loops)
        if (normalizedSrc && !normalizedSrc.includes('trembed') && normalizedSrc !== intermediateUrl) {
          return normalizedSrc;
        }
      }
    }
    
    // Third, try to find video source in script tags
    const scripts = $('script').toArray();
    for (const script of scripts) {
      const content = $(script).html() || '';
      
      // Look for common video embed patterns
      const patterns = [
        /src["']?\s*:\s*["']([^"']+)["']/i,
        /file["']?\s*:\s*["']([^"']+)["']/i,
        /"url"\s*:\s*"([^"]+)"/i,
        /iframe.*?src=["']([^"']+)["']/i,
        /<iframe[^>]+src=["']([^"']+)["']/i,
      ];
      
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match[1] && !match[1].includes('trembed')) {
          const videoUrl = normalizeUrl(match[1]);
          if (videoUrl && videoUrl !== intermediateUrl) {
            return videoUrl;
          }
        }
      }
    }
    
    // If no real video URL found, return the intermediate URL as fallback
    return intermediateUrl;
  } catch (err) {
    console.warn(`  ⚠️ Failed to extract real video from ${intermediateUrl}: ${err.message}`);
    return intermediateUrl;
  }
}

function extractPostId(html) {
  const $ = cheerio.load(html);
  
  // Look for post ID in common WordPress locations
  const postIdPatterns = [
    // From data attributes
    () => $('[data-post], [data-post-id]').first().attr('data-post') || $('[data-post], [data-post-id]').first().attr('data-post-id'),
    // From input fields
    () => $('input[name="post"], input[name="post_id"]').first().val(),
    // From body class
    () => {
      const bodyClass = $('body').attr('class') || '';
      const match = bodyClass.match(/postid-(\d+)/);
      return match ? match[1] : null;
    },
    // From article tag
    () => $('article[id^="post-"]').first().attr('id')?.replace('post-', ''),
    // From script tags
    () => {
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        const patterns = [
          /"post_id"\s*:\s*"?(\d+)"?/,
          /'post_id'\s*:\s*'?(\d+)'?/,
          /post[_-]?id\s*=\s*['"]?(\d+)['"]?/i,
        ];
        
        for (const pattern of patterns) {
          const match = content.match(pattern);
          if (match && match[1]) {
            return match[1];
          }
        }
      }
      return null;
    },
  ];
  
  for (const extractFn of postIdPatterns) {
    const postId = extractFn();
    if (postId) {
      return postId;
    }
  }
  
  return null;
}

async function fetchEpisodeDataFromAPI(postId, season) {
  if (!postId || !season) return null;
  
  try {
    const url = 'https://toonstream.love/wp-admin/admin-ajax.php';
    const params = new URLSearchParams({
      action: 'action_select_season',
      season: season.toString(),
      post: postId,
    });
    
    const response = await axios.post(url, params, {
      timeout: CONFIG.requestTimeout,
      headers: {
        'User-Agent': getUA(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': CONFIG.homeUrl,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    
    const html = String(response.data || '');
    if (!html) return null;
    
    const $ = cheerio.load(html);
    const episodes = [];
    
    // Parse episode list items
    $('li').each((_, el) => {
      const $li = $(el);
      const $article = $li.find('article.post, article.episodes');
      
      if ($article.length === 0) return;
      
      // Extract episode image
      const $img = $article.find('img, .post-thumbnail img');
      let imageUrl = null;
      if ($img.length > 0) {
        imageUrl = $img.attr('data-src') || $img.attr('src') || $img.attr('data-lazy-src');
        // Fix protocol-relative URLs
        if (imageUrl && imageUrl.startsWith('//')) {
          imageUrl = 'https:' + imageUrl;
        } else if (imageUrl) {
          imageUrl = normalizeUrl(imageUrl);
        }
      }
      
      // Extract episode URL
      const $link = $article.find('a.lnk-blk, a[href*="/episode/"]');
      const episodeUrl = normalizeUrl($link.attr('href'));
      
      // Extract episode code (e.g., "1x1")
      const episodeCode = $article.find('.num-epi, .entry-header span').first().text().trim();
      const codeMatch = episodeCode.match(/(\d+)x(\d+)/);
      
      // Extract title
      const title = $article.find('.entry-title, h2').first().text().trim();
      
      if (episodeUrl && codeMatch) {
        episodes.push({
          url: episodeUrl,
          image: imageUrl,
          season: parseInt(codeMatch[1], 10),
          episode: parseInt(codeMatch[2], 10),
          title: title,
          code: episodeCode,
        });
      }
    });
    
    return episodes;
  } catch (err) {
    console.warn(`  ⚠️ Failed to fetch episode data from API: ${err.message}`);
    return null;
  }
}

async function extractEmbeds(html) {
  const $ = cheerio.load(html);
  const intermediateUrls = [];
  const seen = new Set();
  
  // First, collect all iframe URLs
  $("iframe").each((_, el) => {
    const src =
      $(el).attr("src") ||
      $(el).attr("data-src") ||
      $(el).attr("data-lazy-src");
    const url = normalizeUrl(src);
    if (url && !seen.has(url)) {
      seen.add(url);
      intermediateUrls.push(url);
    }
  });
  
  // Now fetch real video URLs from intermediate URLs
  const embeds = [];
  for (let i = 0; i < intermediateUrls.length; i++) {
    const intermediateUrl = intermediateUrls[i];
    
    // Determine server name
    let serverName = `Server ${i + 1}`;
    if (intermediateUrl.includes('trembed')) {
      const match = intermediateUrl.match(/trembed=(\d+)/);
      if (match) {
        serverName = `Server ${parseInt(match[1]) + 1}`;
      }
    }
    
    // Extract real video URL
    const realVideoUrl = await extractRealVideoUrl(intermediateUrl);
    
    embeds.push({ 
      name: serverName,
      url: realVideoUrl,
      real_video: realVideoUrl,
      type: 'iframe'
    });
    
    // Small delay to avoid overwhelming the server
    await delay(300);
  }
  
  return embeds;
}

function extractEpisodeMeta(html) {
  const $ = cheerio.load(html);
  const title =
    $("h1.entry-title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim();

  const thumbnail =
    $('meta[property="og:image"]').attr("content") ||
    $("div.post-thumbnail img").attr("src") ||
    $("div.video-options img").attr("src") ||
    null;

  return {
    title: title?.replace(/\s+/g, " ").trim() || null,
    thumbnail: thumbnail ? normalizeUrl(thumbnail) : null,
    episode_main_poster: normalizeUrl(
      $("div.video-options img").attr("src") ||
        $("div.video-options img").attr("data-src") ||
        $("div.video-options img").attr("data-lazy-src"),
    ),
  };
}

function extractSeriesMeta(seriesHtml) {
  const $ = cheerio.load(seriesHtml);
  const title =
    $("h1.entry-title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim();
  const description =
    $('meta[property="og:description"]').attr("content") ||
    $("div.entry-content p").first().text().trim() ||
    "";
  const thumbnail =
    $('meta[property="og:image"]').attr("content") ||
    $("div.post-thumbnail img").attr("src") ||
    null;
  const genres = [];
  $('a[rel="tag"], .genres a').each((_, el) => {
    const name = $(el).text().trim();
    if (name && !genres.includes(name)) genres.push(name);
  });
  const yearMatch = $("span.year, .year").first().text().match(/\d{4}/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
  return {
    title: title?.replace(/\s+/g, " ").trim() || null,
    description: description?.replace(/\s+/g, " ").trim() || null,
    poster: thumbnail ? normalizeUrl(thumbnail) : null,
    genres,
    year,
  };
}

async function resolveSeriesContext(seriesUrl, fallbackTitle) {
  if (seriesCache.has(seriesUrl)) return seriesCache.get(seriesUrl);
  const html = await fetchHtmlWithRetry(seriesUrl);
  const meta = extractSeriesMeta(html);
  if (!meta.title && fallbackTitle) meta.title = fallbackTitle;
  if (!meta.title) meta.title = cleanSlug(seriesUrl).replace(/-/g, " ");
  const sourceSlug =
    extractSeriesSlugFromUrl(seriesUrl) || cleanSlug(meta.title);
  const slug = sourceSlug || cleanSlug(meta.title);

  let tmdbData = null;
  try {
    tmdbData = await getTMDBData(meta.title);
  } catch (err) {
    console.warn(`TMDB lookup failed for ${meta.title}: ${err.message}`);
  }

  const payload = {
    slug,
    title: meta.title,
    description: tmdbData?.description || meta.description,
    poster: tmdbData?.poster || meta.poster,
    banner_image: tmdbData?.banner_image || null,
    cover_image_large: tmdbData?.poster || meta.poster,
    cover_image_extra_large: tmdbData?.poster || meta.poster,
    genres: tmdbData?.genres?.length ? tmdbData.genres : meta.genres,
    tmdb_id: tmdbData?.tmdb_id || null,
    rating: tmdbData?.rating || null,
    popularity: tmdbData?.popularity || null,
    status: tmdbData?.status || null,
    studios: tmdbData?.studios || [],
    release_date: tmdbData?.release_date || null,
    total_seasons: tmdbData?.total_seasons || 1,
    total_episodes: tmdbData?.total_episodes || null,
    posters: tmdbData?.posters || (meta.poster ? [meta.poster] : []),
    backdrops: tmdbData?.backdrops || [],
    year:
      meta.year ||
      (tmdbData?.release_date
        ? parseInt(tmdbData.release_date.split("-")[0], 10)
        : null),
  };

  const { error } = await supabase
    .from("series")
    .upsert(payload, { onConflict: "slug" });
  if (error) {
    throw new Error(`Supabase series upsert failed: ${error.message}`);
  }

  const ctx = { ...payload, url: seriesUrl, sourceSlug: sourceSlug || slug };
  seriesCache.set(seriesUrl, ctx);
  return ctx;
}

async function getExistingEpisodeSet(seriesSlug) {
  const { data, error } = await supabase
    .from("episodes")
    .select("season, episode")
    .eq("series_slug", seriesSlug);

  if (error) throw new Error(`Supabase check failed: ${error.message}`);
  const set = new Set();
  data?.forEach((row) =>
    set.add(makeSeasonEpisodeKey(row.season, row.episode)),
  );
  return set;
}

async function episodeExistsInSupabase(seriesSlug, season, episode) {
  const { data, error } = await supabase
    .from("episodes")
    .select("id")
    .eq("series_slug", seriesSlug)
    .eq("season", season)
    .eq("episode", episode)
    .maybeSingle();

  if (error) {
    throw new Error(`Episode verification failed: ${error.message}`);
  }

  return Boolean(data);
}

async function checkEpisodeNeedsUpdate(seriesSlug, season, episode) {
  const { data, error } = await supabase
    .from("episodes")
    .select("servers, thumbnail, episode_main_poster")
    .eq("series_slug", seriesSlug)
    .eq("season", season)
    .eq("episode", episode)
    .maybeSingle();

  if (error) {
    throw new Error(`Episode check failed: ${error.message}`);
  }

  if (!data) return { exists: false, needsUpdate: true };

  const hasServers = data.servers && Array.isArray(data.servers) && data.servers.length > 0;
  const hasThumbnail = Boolean(data.thumbnail);
  const hasPoster = Boolean(data.episode_main_poster);

  return {
    exists: true,
    needsUpdate: !hasServers || !hasThumbnail || !hasPoster,
    missingServers: !hasServers,
    missingThumbnail: !hasThumbnail,
    missingPoster: !hasPoster,
  };
}

async function upsertEpisode(
  seriesSlug,
  seriesTitle,
  season,
  episode,
  episodePayload,
) {
  const basePayload = {
    series_slug: seriesSlug,
    season,
    episode,
    ...episodePayload,
  };
  const { error } = await supabase
    .from("episodes")
    .upsert(basePayload, { onConflict: "series_slug,season,episode" });
  if (error)
    throw new Error(`Supabase episode upsert failed: ${error.message}`);

  const latestPayload = {
    series_slug: seriesSlug,
    series_title: seriesTitle,
    season,
    episode,
    episode_title: episodePayload.title,
    thumbnail:
      episodePayload.episode_card_thumbnail ||
      episodePayload.episode_list_thumbnail ||
      episodePayload.thumbnail ||
      null,
    added_at: new Date().toISOString(),
  };

  const latest = await supabase
    .from("latest_episodes")
    .upsert(latestPayload, { onConflict: "series_slug,season,episode" });
  if (latest.error)
    throw new Error(`Supabase latest upsert failed: ${latest.error.message}`);
}

async function extractSeriesUrlFromBreadcrumb(html) {
  const $ = cheerio.load(html);
  const breadcrumbs = $(
    'nav.breadcrumb a[href*="/series/"], .entry-meta a[href*="/series/"]',
  );
  const last = breadcrumbs.last();
  return normalizeUrl(last.attr("href"));
}

async function buildEpisodeRecord(episodeUrl, hints = {}) {
  const episodeHtml = await fetchHtmlWithRetry(episodeUrl);
  const derivedSeriesUrl =
    (await extractSeriesUrlFromBreadcrumb(episodeHtml)) ||
    deriveSeriesUrlFromEpisode(episodeUrl) ||
    hints.seriesUrl ||
    episodeUrl.split("/episode/")[0];

  const fallbackTitle = hints.seriesTitle || hints.card?.title || null;
  const seriesCtx = await resolveSeriesContext(derivedSeriesUrl, fallbackTitle);
  const meta = extractEpisodeMeta(episodeHtml);
  const code = hints.code ||
    parseEpisodeCode(episodeUrl) || {
      season: 1,
      episode: Math.floor(Date.now() / 1000),
    };
  const embeds = await extractEmbeds(episodeHtml);

  // Try to fetch episode image from API
  let apiEpisodeImage = null;
  try {
    const postId = extractPostId(episodeHtml);
    if (postId && code.season) {
      const episodeData = await fetchEpisodeDataFromAPI(postId, code.season);
      if (episodeData && episodeData.length > 0) {
        // Find the matching episode by season and episode number
        const matchingEpisode = episodeData.find(
          ep => ep.season === code.season && ep.episode === code.episode
        );
        if (matchingEpisode && matchingEpisode.image) {
          apiEpisodeImage = matchingEpisode.image;
        }
      }
    }
  } catch (err) {
    console.warn(`  ⚠️ Failed to fetch episode image from API: ${err.message}`);
  }

  const episodePayload = {
    title: meta.title || hints.card?.title || `Episode ${code.episode}`,
    thumbnail: apiEpisodeImage || meta.thumbnail || hints.card?.thumb || seriesCtx.poster,
    episode_main_poster: apiEpisodeImage || meta.episode_main_poster || seriesCtx.poster,
    episode_card_thumbnail: apiEpisodeImage || meta.thumbnail || hints.card?.thumb || null,
    episode_list_thumbnail: apiEpisodeImage || hints.card?.thumb || meta.thumbnail || null,
    video_player_thumbnail:
      apiEpisodeImage || meta.episode_main_poster || meta.thumbnail || hints.card?.thumb || null,
    servers: embeds,
  };

  if (!episodePayload.thumbnail) {
    episodePayload.thumbnail =
      seriesCtx.poster || seriesCtx.cover_image_large || null;
  }

  return { seriesCtx, code, episodePayload };
}

async function syncEpisodeByUrl(episodeUrl, options = {}) {
  let lastSeriesCtx = null;
  let lastCode = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { seriesCtx, code, episodePayload } = await buildEpisodeRecord(
      episodeUrl,
      options,
    );
    lastSeriesCtx = seriesCtx;
    lastCode = code;

    const key = makeEpisodeKey(seriesCtx.slug, code.season, code.episode);
    const seasonEpisodeKey = makeSeasonEpisodeKey(code.season, code.episode);

    // Check if episode needs update (missing servers or images)
    const updateCheck = await checkEpisodeNeedsUpdate(
      seriesCtx.slug,
      code.season,
      code.episode,
    );

    // When force is true, ALWAYS update regardless of processed status
    // This ensures old episodes get refreshed when series has new content
    if (options.force) {
      // Force update - skip all checks
    } else {
      // Normal mode - skip if already processed and complete
      if (processedEpisodes.has(key) && !updateCheck.needsUpdate) {
        return seriesCtx;
      }
      if (options.existingEpisodes?.has(seasonEpisodeKey) && !updateCheck.needsUpdate) {
        return seriesCtx;
      }
    }

    // Log what we're updating
    // If force is true, always treat as update if episode exists
    const isUpdate = options.force ? updateCheck.exists : (updateCheck.exists && updateCheck.needsUpdate);
    
    if (isUpdate) {
      if (options.force && updateCheck.exists && !updateCheck.needsUpdate) {
        // Episode exists with complete data but we're forcing a refresh
        console.log(
          `   🔄 Force updating ${seriesCtx.title} S${code.season}E${code.episode} (refresh all data)`
        );
      } else if (updateCheck.needsUpdate) {
        // Episode exists but has missing data
        const missing = [];
        if (updateCheck.missingServers) missing.push("servers");
        if (updateCheck.missingThumbnail) missing.push("thumbnail");
        if (updateCheck.missingPoster) missing.push("poster");
        console.log(
          `   🔄 Updating ${seriesCtx.title} S${code.season}E${code.episode} (missing: ${missing.join(", ")})`
        );
      }
    }

    await upsertEpisode(
      seriesCtx.slug,
      seriesCtx.title,
      code.season,
      code.episode,
      episodePayload,
    );

    const persisted = await episodeExistsInSupabase(
      seriesCtx.slug,
      code.season,
      code.episode,
    );
    if (persisted) {
      processedEpisodes.add(key);
      options.existingEpisodes?.add(seasonEpisodeKey);

      // Update statistics
      const serversCount = episodePayload.servers?.length || 0;
      stats.totalServers += serversCount;
      stats.seriesProcessed.add(seriesCtx.slug);
      
      if (isUpdate) {
        stats.updatedEpisodes++;
      } else {
        stats.newEpisodes++;
      }

      const context = options.reason ? ` (${options.reason})` : "";
      const attemptInfo = attempt > 1 ? ` (attempt ${attempt})` : "";
      console.log(
        `✅ Synced ${seriesCtx.title} S${code.season}E${code.episode}${context}${attemptInfo} | Servers: ${serversCount}`,
      );
      return seriesCtx;
    }

    console.warn(
      `   ⚠️  Episode ${seriesCtx.title} S${code.season}E${code.episode} missing in Supabase after upsert, retrying...`,
    );
    await delay(500 * attempt);
  }

  console.error(
    `❌ Failed to persist ${lastSeriesCtx?.title || "episode"} S${lastCode?.season}E${lastCode?.episode} after retries`,
  );
  stats.failedEpisodes++;
  return lastSeriesCtx;
}

function extractSeasonNumbers(html) {
  const $ = cheerio.load(html);
  const seasons = new Set();
  
  // Look for season buttons/options
  $('[data-season], option[value]').each((_, el) => {
    const seasonAttr = $(el).attr('data-season') || $(el).attr('value');
    if (seasonAttr && !isNaN(seasonAttr)) {
      seasons.add(parseInt(seasonAttr, 10));
    }
  });
  
  // If no seasons found via data attributes, try text content
  if (seasons.size === 0) {
    $('.aa-cnt .se-c').each((_, el) => {
      const text = $(el).find('.se-t').text();
      const match = text.match(/season\s+(\d+)/i);
      if (match) {
        seasons.add(parseInt(match[1], 10));
      }
    });
  }
  
  // Default to season 1 if nothing found
  if (seasons.size === 0) {
    seasons.add(1);
  }
  
  return Array.from(seasons).sort((a, b) => a - b);
}

async function ensureSeriesComplete(seriesCtx) {
  try {
    const html = await fetchHtmlWithRetry(seriesCtx.url);
    
    // Extract post ID from series page
    const postId = extractPostId(html);
    if (!postId) {
      console.warn(`   ⚠️  No post ID found for ${seriesCtx.title}, skipping`);
      return;
    }
    
    // Extract available seasons
    const seasons = extractSeasonNumbers(html);
    console.log(`      🔍 Found ${seasons.length} season(s) for ${seriesCtx.title}`);
    
    // Fetch all episodes from all seasons using WordPress AJAX API
    const allEpisodeLinks = [];
    for (const season of seasons) {
      const episodeData = await fetchEpisodeDataFromAPI(postId, season);
      if (episodeData && episodeData.length > 0) {
        console.log(`         • Season ${season}: ${episodeData.length} episode(s)`);
        allEpisodeLinks.push(...episodeData);
      }
      await delay(300); // Small delay between API calls
    }
    
    if (allEpisodeLinks.length === 0) {
      console.warn(`   ⚠️  No episodes found for ${seriesCtx.title}`);
      return;
    }

    // Get all existing episodes for this series
    const { data: existingData } = await supabase
      .from("episodes")
      .select("season, episode, servers, thumbnail, episode_main_poster")
      .eq("series_slug", seriesCtx.slug);

    const existingEpisodes = new Set();
    const episodesToUpdate = [];
    
    existingData?.forEach((ep) => {
      const key = makeSeasonEpisodeKey(ep.season, ep.episode);
      existingEpisodes.add(key);
      
      // Always update ALL existing episodes to refresh data
      episodesToUpdate.push({ season: ep.season, episode: ep.episode });
    });

    // Find missing episodes (new episodes not in database)
    const missing = allEpisodeLinks.filter(
      (link) => !existingEpisodes.has(makeSeasonEpisodeKey(link.season, link.episode)),
    );

    const totalWork = missing.length + episodesToUpdate.length;
    if (totalWork === 0) {
      console.log(`      ✅ No episodes found for ${seriesCtx.title}`);
      return;
    }

    console.log(
      `      ↪ ${seriesCtx.title}: ${missing.length} new + ${episodesToUpdate.length} to update`,
    );

    // Sync missing episodes (new episodes)
    for (const link of missing) {
      await syncEpisodeByUrl(link.url, {
        force: true,
        code: { season: link.season, episode: link.episode },
        seriesUrl: seriesCtx.url,
        seriesTitle: seriesCtx.title,
        existingEpisodes,
        card: { title: link.title, thumb: link.image },
        reason: "backfill",
      });
      await delay(750);
    }

    // Update ALL existing episodes to refresh their data
    for (const ep of episodesToUpdate) {
      const link = allEpisodeLinks.find(l => l.season === ep.season && l.episode === ep.episode);
      if (link) {
        await syncEpisodeByUrl(link.url, {
          force: true,
          code: { season: ep.season, episode: ep.episode },
          seriesUrl: seriesCtx.url,
          seriesTitle: seriesCtx.title,
          existingEpisodes,
          card: { title: link.title, thumb: link.image },
          reason: "refresh-data",
        });
        await delay(750);
      }
    }
  } catch (err) {
    console.error(`   ❌ Failed to process ${seriesCtx.title}: ${err.message}`);
    stats.failedEpisodes++;
  }
}

async function auditLatestEpisodes(
  limit = Number(process.env.LATEST_AUDIT_LIMIT || 25),
) {
  try {
    const { data, error } = await supabase
      .from("latest_episodes")
      .select(
        "series_slug, series_title, season, episode, episode_title, thumbnail",
      )
      .order("added_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!data || data.length === 0) return;

    for (const entry of data) {
      const exists = await episodeExistsInSupabase(
        entry.series_slug,
        entry.season,
        entry.episode,
      );
      if (exists) continue;

      console.log(
        `   ↺ Restoring missing episode ${entry.series_title} S${entry.season}E${entry.episode} from latest feed`,
      );

      const episodeUrl = buildEpisodeUrl(
        entry.series_slug,
        entry.season,
        entry.episode,
      );
      const seriesUrl = buildSeriesUrlFromSlug(entry.series_slug);

      await syncEpisodeByUrl(episodeUrl, {
        force: true,
        seriesUrl,
        seriesTitle: entry.series_title,
        card: { title: entry.episode_title, thumb: entry.thumbnail },
        reason: "latest-audit",
      });
      await delay(500);
    }
  } catch (err) {
    console.error(`⚠️ Latest episodes audit failed: ${err.message}`);
  }
}

async function auditAndUpdateEmptyServers(
  limit = Number(process.env.EMPTY_SERVERS_AUDIT_LIMIT || 50),
) {
  try {
    console.log(`\n🔍 Checking for episodes with missing servers/images...`);
    
    const { data, error } = await supabase
      .from("episodes")
      .select("series_slug, season, episode, servers, thumbnail, episode_main_poster")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!data || data.length === 0) return;

    let updatedCount = 0;
    let skippedCount = 0;
    
    for (const ep of data) {
      const hasServers = ep.servers && Array.isArray(ep.servers) && ep.servers.length > 0;
      const hasThumbnail = Boolean(ep.thumbnail);
      const hasPoster = Boolean(ep.episode_main_poster);

      if (!hasServers || !hasThumbnail || !hasPoster) {
        try {
          const episodeUrl = buildEpisodeUrl(ep.series_slug, ep.season, ep.episode);
          const seriesUrl = buildSeriesUrlFromSlug(ep.series_slug);

          await syncEpisodeByUrl(episodeUrl, {
            force: true,
            seriesUrl,
            reason: "update-missing-data",
          });
          updatedCount++;
          await delay(1000);
        } catch (err) {
          // Skip invalid/404 episodes gracefully
          if (err.message.includes("404") || err.message.includes("Failed to fetch")) {
            skippedCount++;
            stats.skippedEpisodes++;
          } else {
            console.warn(`   ⚠️ Failed to update ${ep.series_slug} S${ep.season}E${ep.episode}: ${err.message}`);
            stats.failedEpisodes++;
          }
        }
      }
    }

    if (updatedCount > 0) {
      console.log(`   ✅ Updated ${updatedCount} episodes with missing data`);
    } else {
      console.log(`   ✅ All recent episodes have complete data`);
    }
    
    if (skippedCount > 0) {
      console.log(`   ℹ️  Skipped ${skippedCount} invalid/deleted episodes`);
    }
  } catch (err) {
    console.error(`⚠️ Empty servers audit failed: ${err.message}`);
  }
}

async function pollHomepage() {
  const latestSeriesSlugs = new Set();
  try {
    const html = await fetchHtmlWithRetry(CONFIG.homeUrl);
    const cards = extractEpisodeCards(html);
    console.log(`🔍 Found ${cards.length} candidate episodes`);
    for (const card of cards) {
      const seriesCtx = await syncEpisodeByUrl(card.url, { card });
      if (seriesCtx && seriesCtx.slug) {
        latestSeriesSlugs.add(seriesCtx.slug);
      }
      await delay(1000);
    }
  } catch (err) {
    console.error(`❌ Polling error: ${err.message}`);
  }
  return latestSeriesSlugs;
}

function printSummary() {
  console.log("\n" + "=".repeat(60));
  console.log("📊 SYNC SUMMARY");
  console.log("=".repeat(60));
  
  const totalEpisodes = stats.newEpisodes + stats.updatedEpisodes;
  const totalProcessed = totalEpisodes + stats.failedEpisodes + stats.skippedEpisodes;
  
  console.log(`\n✅ Success:`);
  console.log(`   • New Episodes Added: ${stats.newEpisodes}`);
  console.log(`   • Episodes Updated: ${stats.updatedEpisodes}`);
  console.log(`   • Total Servers Fetched: ${stats.totalServers}`);
  console.log(`   • Series Processed: ${stats.seriesProcessed.size}`);
  
  if (stats.failedEpisodes > 0 || stats.skippedEpisodes > 0) {
    console.log(`\n⚠️  Issues:`);
    if (stats.failedEpisodes > 0) {
      console.log(`   • Failed Episodes: ${stats.failedEpisodes}`);
    }
    if (stats.skippedEpisodes > 0) {
      console.log(`   • Skipped (Invalid/Deleted): ${stats.skippedEpisodes}`);
    }
  }
  
  console.log(`\n📈 Total Episodes Processed: ${totalProcessed}`);
  
  const successRate = totalProcessed > 0 
    ? ((totalEpisodes / totalProcessed) * 100).toFixed(1) 
    : 0;
  
  console.log(`   Success Rate: ${successRate}%`);
  
  console.log("\n" + "=".repeat(60));
  
  if (stats.failedEpisodes > 0) {
    console.log("⚠️  Status: Completed with some failures");
  } else {
    console.log("✅ Status: All operations completed successfully!");
  }
  
  console.log("💡 Run 'npm run sync' again to fetch new episodes");
  console.log("=".repeat(60) + "\n");
}

async function updateSeriesFromLatestEpisodes(latestSeriesSlugs) {
  try {
    if (!latestSeriesSlugs || latestSeriesSlugs.size === 0) {
      console.log(`\n   ℹ️  No series to update from latest episodes`);
      return;
    }
    
    console.log(`\n🔄 Updating ALL episodes (old + new) for series with recent activity...`);
    console.log(`   📚 Found ${latestSeriesSlugs.size} series with latest episodes\n`);
    
    // Process only the series from latestSeriesSlugs (NOT all series in database)
    for (const slug of latestSeriesSlugs) {
      try {
        // Get series title from database
        const { data: seriesData, error } = await supabase
          .from("series")
          .select("title")
          .eq("slug", slug)
          .maybeSingle();
        
        if (error) {
          console.warn(`   ⚠️ Failed to fetch series data for ${slug}: ${error.message}`);
          continue;
        }
        
        const seriesUrl = buildSeriesUrlFromSlug(slug);
        
        // Create a minimal series context
        const seriesCtx = {
          slug: slug,
          title: seriesData?.title || slug,
          url: seriesUrl,
        };
        
        console.log(`   📺 Processing all episodes: ${seriesCtx.title}`);
        
        // This will fetch ALL episodes from toonstream and update old + new ones
        await ensureSeriesComplete(seriesCtx);
        
        // Small delay between series
        await delay(1500);
      } catch (err) {
        console.warn(`   ⚠️ Failed to process ${slug}: ${err.message}`);
        stats.failedEpisodes++;
      }
    }
    
    console.log(`\n✅ Finished updating all series with recent activity`);
  } catch (err) {
    console.error(`⚠️ Update series failed: ${err.message}`);
  }
}

async function start() {
  console.log("🚀 Toonstream -> Supabase sync started");
  console.log("📡 Fetching latest episodes from Toonstream...\n");
  
  // Initialize proxy system
  await proxyManager.initialize();
  const proxyStats = proxyManager.getStats();
  if (proxyStats.enabled) {
    console.log(`🔐 Proxy Status: ${proxyStats.active}/${proxyStats.total} active\n`);
  }
  
  // Step 1: Fetch latest from homepage and track which series have new episodes
  const latestSeriesSlugs = await pollHomepage();
  
  // Step 2: Update ALL episodes (old + new) for series with recent activity
  await updateSeriesFromLatestEpisodes(latestSeriesSlugs);
  
  // Step 3: Audit and restore from latest_episodes
  await auditLatestEpisodes();
  
  // Step 4: Final check for any episodes with missing data
  await auditAndUpdateEmptyServers();
  
  printSummary();
}

start().catch((err) => {
  console.error("\n❌ Error occurred:", err.message);
  process.exit(1);
});
