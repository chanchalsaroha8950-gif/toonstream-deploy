import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
    this.failedProxies = new Set();
    this.useProxy = process.env.USE_PROXY === "true";
    this.customProxies = process.env.PROXY_LIST ? process.env.PROXY_LIST.split(",") : [];
  }

  async initialize() {
    if (!this.useProxy) {
      console.log("🔓 Proxy system disabled - using direct connection");
      return;
    }

    if (this.customProxies.length > 0) {
      this.proxies = this.customProxies.map(p => p.trim()).filter(Boolean);
      console.log(`🔐 Loaded ${this.proxies.length} custom proxies`);
    } else {
      await this.fetchFreeProxies();
    }
  }

  async fetchFreeProxies() {
    try {
      console.log("🔍 Fetching free proxy list...");
      
      // Using free proxy sources
      const sources = [
        "https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
        "https://www.proxy-list.download/api/v1/get?type=http",
      ];

      for (const source of sources) {
        try {
          const response = await axios.get(source, { timeout: 10000 });
          const proxyList = response.data
            .split("\n")
            .map(p => p.trim())
            .filter(p => p && p.includes(":"));
          
          if (proxyList.length > 0) {
            this.proxies.push(...proxyList.slice(0, 20)); // Take first 20
            console.log(`✅ Fetched ${proxyList.length} proxies from source`);
            break;
          }
        } catch (err) {
          console.warn(`⚠️  Failed to fetch from source: ${err.message}`);
        }
      }

      if (this.proxies.length === 0) {
        console.warn("⚠️  No proxies found, disabling proxy");
        this.useProxy = false;
      } else {
        console.log(`🔐 Total proxies loaded: ${this.proxies.length}`);
      }
    } catch (err) {
      console.error(`❌ Proxy fetch failed: ${err.message}`);
      this.useProxy = false;
    }
  }

  getNextProxy() {
    if (!this.useProxy || this.proxies.length === 0) {
      return null;
    }

    // Find next working proxy
    let attempts = 0;
    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

      if (!this.failedProxies.has(proxy)) {
        return proxy;
      }
      attempts++;
    }

    // All proxies failed, reset failed list
    console.warn("⚠️  All proxies failed, resetting...");
    this.failedProxies.clear();
    return this.proxies[0];
  }

  markProxyAsFailed(proxy) {
    if (proxy) {
      this.failedProxies.add(proxy);
      console.warn(`⚠️  Marking proxy as failed: ${proxy}`);
    }
  }

  getProxyAgent(proxy) {
    if (!proxy) return null;
    
    try {
      const proxyUrl = proxy.startsWith("http") ? proxy : `http://${proxy}`;
      return new HttpsProxyAgent(proxyUrl);
    } catch (err) {
      console.warn(`⚠️  Invalid proxy format: ${proxy}`);
      return null;
    }
  }

  async testProxy(proxy) {
    try {
      const agent = this.getProxyAgent(proxy);
      await axios.get("https://www.google.com", {
        timeout: 5000,
        httpAgent: agent,
        httpsAgent: agent,
      });
      return true;
    } catch {
      return false;
    }
  }

  getStats() {
    return {
      total: this.proxies.length,
      failed: this.failedProxies.size,
      active: this.proxies.length - this.failedProxies.size,
      enabled: this.useProxy,
    };
  }
}

export default ProxyManager;
