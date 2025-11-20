# 🎬 Toonstream Auto-Sync System

Automated 24/7 sync system that fetches anime episodes from Toonstream to Supabase database.

## ✨ Features

- 🔄 **Auto-sync every 1 minute** - Continuously fetches latest episodes
- 🧠 **Smart fetching** - Only updates series with new content, refreshes old episodes
- 🌐 **Proxy support** - Optional proxy rotation for better reliability
- ⚡ **Fast & efficient** - Parallel processing with retry logic
- 📊 **Real-time monitoring** - Health check and status endpoints
- 🎯 **24/7 uptime** - Designed for Render deployment

## 🚀 Quick Start

### Local Development

1. **Clone & Install**
```bash
git clone <your-repo>
cd <your-repo>
npm install
```

2. **Configure Environment**
```bash
cp .env.example .env
# Edit .env with your credentials
```

3. **Run**
```bash
# Single sync (run once)
npm run sync:once

# Continuous mode (every 1 minute)
npm start
```

### Deploy to Render (24/7)

See **[DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)** for complete instructions.

## 📡 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check & service status |
| `GET /status` | Detailed sync statistics |
| `GET /sync` | Manual trigger (for testing) |

## ⚙️ Configuration

Edit `.env` file:

```bash
# Required
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_key
TMDB_API_KEY=your_tmdb_key

# Optional
CRON_SCHEDULE=*/1 * * * *  # Every 1 minute
USE_PROXY=false
PORT=3000
```

## 📂 Files for Deployment

**Upload to GitHub/Render:**
- `toonstream-supabase-sync.js` - Main sync logic
- `sync-server.js` - 24/7 server with cron
- `proxy-manager.js` - Proxy rotation system
- `package.json` - Dependencies
- `render.yaml` - Render config
- `.env` - Your environment variables

**DO NOT Upload:**
- `node_modules/`
- `.env` (except on Render dashboard)
- Log files
- Development files

## 🎯 How It Works

1. **Homepage scraping** → Finds latest episodes
2. **Identify updated series** → Tracks which anime have new content
3. **Smart refresh** → Updates ALL episodes (old + new) for active series
4. **Database sync** → Saves to Supabase with complete metadata
5. **Repeat every minute** → Keeps database fresh 24/7

## 🔧 Development

```bash
# Run single sync
npm run sync:once

# Run continuous server
npm start

# Development mode
npm run dev
```

## 📊 Monitoring

```bash
# Check service status
curl http://localhost:3000/status

# View health
curl http://localhost:3000/

# Manual trigger
curl http://localhost:3000/sync
```

## 🎮 Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start 24/7 sync server |
| `npm run sync:once` | Run single sync |
| `npm run dev` | Development mode |

## 📝 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | ✅ | - | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | - | Supabase service role key |
| `TMDB_API_KEY` | ✅ | - | TMDB API key for metadata |
| `PORT` | ❌ | 3000 | Server port |
| `CRON_SCHEDULE` | ❌ | `*/1 * * * *` | Sync schedule |
| `USE_PROXY` | ❌ | false | Enable proxy rotation |
| `PROXY_LIST` | ❌ | - | Custom proxy list |

## 🛠️ Tech Stack

- **Node.js** - Runtime
- **Express** - Web server
- **node-cron** - Scheduled tasks
- **Cheerio** - HTML parsing
- **Axios** - HTTP client
- **Supabase** - Database
- **TMDB API** - Metadata

## 📚 Documentation

- [Deployment Guide](./DEPLOYMENT_GUIDE.md) - Complete deployment instructions
- [.env.example](./.env.example) - Environment variable template

## 🐛 Troubleshooting

**Sync not working?**
- Check environment variables
- Verify Supabase credentials
- Review Render logs

**Proxy issues?**
- Set `USE_PROXY=false` to disable
- Use custom proxies with `PROXY_LIST`

**Memory issues?**
- Reduce `MAX_PARALLEL_SERIES`
- Increase delays between requests

## 📄 License

ISC

---

Made with ❤️ for anime fans
