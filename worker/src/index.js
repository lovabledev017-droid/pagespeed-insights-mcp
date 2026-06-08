/**
 * PageSpeed Insights MCP Server — Cloudflare Worker
 * Implements MCP Streamable HTTP transport (2025-03-26 spec)
 * Compatible with Lovable, Claude Desktop, and any MCP HTTP client
 */

const MCP_VERSION = "2025-03-26";
const SERVER_VERSION = "1.2.4";

// ─── In-memory cache ──────────────────────────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data, ttlMs = 3_600_000) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ─── PageSpeed API ────────────────────────────────────────────────────────────
async function callPSI(apiKey, params) {
  const url = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  url.searchParams.set("url", params.url);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("strategy", params.strategy || "mobile");
  url.searchParams.set("locale", params.locale || "en");
  for (const cat of (params.category || ["performance"])) {
    url.searchParams.append("category", cat);
  }
  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`PSI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cacheSet(cacheKey, data);
  return data;
}

async function callCrUX(apiKey, url, formFactor) {
  const cacheKey = `crux:${url}:${formFactor || "all"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const endpoint = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${apiKey}`;
  const body = { url, ...(formFactor && { formFactor }) };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CrUX API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cacheSet(cacheKey, data);
  return data;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  { name: "analyze_page_speed", description: "Run comprehensive Google PageSpeed Insights analysis with Lighthouse metrics", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" }, category: { type: "array", items: { type: "string", enum: ["performance","accessibility","best-practices","seo","pwa"] }, default: ["performance"] }, locale: { type: "string", default: "en" } }, required: ["url"] } },
  { name: "get_performance_summary", description: "Get simplified performance metrics for a webpage", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "crux_summary", description: "Get Chrome User Experience Report real-world Core Web Vitals", inputSchema: { type: "object", properties: { url: { type: "string" }, formFactor: { type: "string", enum: ["PHONE","DESKTOP","TABLET"] } }, required: ["url"] } },
  { name: "compare_pages", description: "Compare performance metrics between two URLs", inputSchema: { type: "object", properties: { urlA: { type: "string" }, urlB: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["urlA","urlB"] } },
  { name: "full_report", description: "Unified report combining Lighthouse lab data with CrUX field data", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" }, category: { type: "array", items: { type: "string" }, default: ["performance"] } }, required: ["url"] } },
  { name: "batch_analyze", description: "Analyze multiple URLs (max 5)", inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" }, maxItems: 5 }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["urls"] } },
  { name: "clear_cache", description: "Clear the internal cache", inputSchema: { type: "object", properties: {} } },
  { name: "get_recommendations", description: "Generate smart performance recommendations with priority scoring", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "get_network_analysis", description: "Get detailed network waterfall analysis", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "get_javascript_analysis", description: "Get JavaScript execution breakdown", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "get_image_optimization_details", description: "Get specific images needing optimization with savings potential", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "get_render_blocking_details", description: "Get render-blocking resources and critical request chains", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "get_third_party_impact", description: "Get third-party script impact grouped by entity", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "get_element_analysis", description: "Get DOM elements causing performance issues (LCP, CLS)", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "get_visual_analysis", description: "Get screenshot and filmstrip of page load", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" } }, required: ["url"] } },
  { name: "get_full_audit", description: "Comprehensive audit across all categories", inputSchema: { type: "object", properties: { url: { type: "string" }, strategy: { type: "string", enum: ["mobile","desktop"], default: "mobile" }, categories: { type: "array", items: { type: "string" }, default: ["performance","accessibility","best-practices","seo"] } }, required: ["url"] } },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────
function fmtScore(s) { return s != null ? `${Math.round(s * 100)}/100` : "N/A"; }
function fmtAudit(audits, id) { return audits?.[id]?.displayValue || "N/A"; }

function formatAnalysisReport(data, input) {
  const lh = data.lighthouseResult;
  if (!lh) return "No Lighthouse data available";
  const perf = lh.categories?.performance;
  const audits = lh.audits;
  let r = `# PageSpeed Insights — ${input.url}\n**Strategy:** ${input.strategy || "mobile"}\n\n`;
  if (perf) r += `## Performance Score: ${fmtScore(perf.score)}\n\n`;
  r += `## Core Web Vitals\n`;
  for (const m of ["largest-contentful-paint","first-input-delay","cumulative-layout-shift"]) {
    const a = audits?.[m]; if (a) r += `- **${a.title}**: ${a.displayValue} ${a.score===1?"✅":a.score>=0.9?"⚠️":"❌"}\n`;
  }
  r += `\n## Key Metrics\n`;
  for (const m of ["first-contentful-paint","speed-index","total-blocking-time"]) {
    const a = audits?.[m]; if (a) r += `- **${a.title}**: ${a.displayValue}\n`;
  }
  return r;
}

function formatCruxSummary(data, url) {
  if (!data.record) return `# CrUX Field Data\n**URL:** ${url}\nNo field data available (insufficient traffic).`;
  const { record } = data;
  let r = `# CrUX Field Data\n**URL:** ${url}\n**Form Factor:** ${record.key?.formFactor || "all"}\n\n## Core Web Vitals\n`;
  const map = { largest_contentful_paint: "LCP", first_input_delay: "FID", cumulative_layout_shift: "CLS" };
  for (const [k, label] of Object.entries(map)) {
    const m = record.metrics?.[k];
    if (m) r += `- **${label}**: ${m.percentiles.p75}${k==="cumulative_layout_shift"?"":""} (p75)\n`;
  }
  return r;
}

function formatRecommendations(data) {
  const lh = data.lighthouseResult;
  if (!lh) return "No Lighthouse data";
  const audits = lh.audits || {};
  const failing = Object.entries(audits)
    .filter(([,a]) => a?.score !== null && a?.score < 1 && a?.score !== undefined)
    .sort(([,a],[,b]) => (a.score??1) - (b.score??1))
    .slice(0, 10);
  let r = `# Performance Recommendations — ${lh.requestedUrl || ""}\n**Score:** ${fmtScore(lh.categories?.performance?.score)}\n\n`;
  for (const [id, audit] of failing) {
    r += `## ${audit.title}\n`;
    if (audit.displayValue) r += `**Impact:** ${audit.displayValue}\n`;
    if (audit.description) r += `${audit.description.split(".")[0]}.\n`;
    r += "\n";
  }
  return r;
}

async function handleTool(name, args, apiKey) {
  if (name === "clear_cache") { cache.clear(); return "✅ Cache cleared."; }

  const strategy = args.strategy || "mobile";

  if (name === "analyze_page_speed") {
    const data = await callPSI(apiKey, args);
    return formatAnalysisReport(data, args);
  }
  if (name === "get_performance_summary") {
    const data = await callPSI(apiKey, { ...args, category: ["performance"] });
    const lh = data.lighthouseResult;
    const audits = lh?.audits || {};
    return JSON.stringify({
      url: args.url, strategy,
      score: fmtScore(lh?.categories?.performance?.score),
      metrics: {
        FCP: fmtAudit(audits, "first-contentful-paint"),
        LCP: fmtAudit(audits, "largest-contentful-paint"),
        CLS: fmtAudit(audits, "cumulative-layout-shift"),
        TBT: fmtAudit(audits, "total-blocking-time"),
        SI: fmtAudit(audits, "speed-index"),
      }
    }, null, 2);
  }
  if (name === "crux_summary") {
    const data = await callCrUX(apiKey, args.url, args.formFactor);
    return formatCruxSummary(data, args.url);
  }
  if (name === "compare_pages") {
    const [a, b] = await Promise.all([
      callPSI(apiKey, { url: args.urlA, strategy, category: ["performance"] }),
      callPSI(apiKey, { url: args.urlB, strategy, category: ["performance"] }),
    ]);
    const scoreA = Math.round((a.lighthouseResult?.categories?.performance?.score||0)*100);
    const scoreB = Math.round((b.lighthouseResult?.categories?.performance?.score||0)*100);
    return `# Page Comparison\n- **${args.urlA}**: ${scoreA}/100\n- **${args.urlB}**: ${scoreB}/100\n- **Winner**: ${scoreA>scoreB?args.urlA:scoreB>scoreA?args.urlB:"Tie"} (+${Math.abs(scoreA-scoreB)} pts)`;
  }
  if (name === "full_report") {
    const [psi, crux] = await Promise.allSettled([
      callPSI(apiKey, args),
      callCrUX(apiKey, args.url, undefined),
    ]);
    let r = "";
    if (psi.status === "fulfilled") r += formatAnalysisReport(psi.value, args) + "\n\n---\n\n";
    if (crux.status === "fulfilled") r += formatCruxSummary(crux.value, args.url);
    else r += "## CrUX\nNo field data available.";
    return r;
  }
  if (name === "batch_analyze") {
    const results = await Promise.allSettled(
      (args.urls||[]).slice(0,5).map(url => callPSI(apiKey, { url, strategy, category: ["performance"] }))
    );
    return JSON.stringify(results.map((r, i) => ({
      url: args.urls[i],
      score: r.status==="fulfilled" ? fmtScore(r.value.lighthouseResult?.categories?.performance?.score) : "error",
      error: r.status==="rejected" ? r.reason?.message : undefined,
    })), null, 2);
  }
  if (name === "get_recommendations") {
    const data = await callPSI(apiKey, { ...args, category: ["performance","accessibility","best-practices","seo"] });
    return formatRecommendations(data);
  }
  if (name === "get_network_analysis") {
    const data = await callPSI(apiKey, { ...args, category: ["performance"] });
    const audits = data.lighthouseResult?.audits || {};
    const requests = audits["network-requests"]?.details?.items || [];
    const total = audits["total-byte-weight"]?.numericValue || 0;
    let r = `# Network Analysis — ${args.url}\n**Total size:** ${(total/1024/1024).toFixed(2)} MB | **Requests:** ${requests.length}\n\n## Top 10 Resources\n`;
    [...requests].sort((a,b)=>(b.transferSize||0)-(a.transferSize||0)).slice(0,10).forEach((req,i)=>{
      r += `${i+1}. **${(req.url||"").split("/").pop()||"index"}** — ${((req.transferSize||0)/1024).toFixed(1)} KB (${req.resourceType||""})\n`;
    });
    return r;
  }
  if (name === "get_javascript_analysis") {
    const data = await callPSI(apiKey, { ...args, category: ["performance"] });
    const audits = data.lighthouseResult?.audits || {};
    const unused = audits["unused-javascript"]?.details?.items || [];
    const bootup = audits["bootup-time"]?.details?.items || [];
    let r = `# JavaScript Analysis — ${args.url}\n`;
    if (bootup.length) {
      r += `## Bootup Time\n`;
      [...bootup].sort((a,b)=>(b.total||0)-(a.total||0)).slice(0,5).forEach(s=>{
        r += `- **${(s.url||"").split("/").pop()||"inline"}**: ${(s.total||0).toFixed(0)}ms\n`;
      });
    }
    if (unused.length) {
      const wasted = unused.reduce((sum,i)=>sum+(i.wastedBytes||0),0);
      r += `\n## Unused JS — ${(wasted/1024).toFixed(1)} KB total\n`;
      [...unused].sort((a,b)=>(b.wastedBytes||0)-(a.wastedBytes||0)).slice(0,5).forEach(s=>{
        r += `- **${(s.url||"").split("/").pop()||"bundle"}**: ${((s.wastedBytes||0)/1024).toFixed(1)} KB unused\n`;
      });
    }
    return r;
  }
  if (name === "get_image_optimization_details") {
    const data = await callPSI(apiKey, { ...args, category: ["performance"] });
    const audits = data.lighthouseResult?.audits || {};
    let r = `# Image Optimization — ${args.url}\n`;
    let totalSavings = 0;
    for (const [auditId, label] of [["uses-responsive-images","Oversized images"],["offscreen-images","Offscreen images"],["modern-image-formats","No modern format (WebP/AVIF)"]]) {
      const items = audits[auditId]?.details?.items || [];
      if (items.length) {
        r += `\n## ${label}\n`;
        items.forEach(img => {
          totalSavings += img.wastedBytes||0;
          r += `- **${(img.url||"").split("/").pop()}**: save ${((img.wastedBytes||0)/1024).toFixed(1)} KB\n`;
        });
      }
    }
    r += `\n**Total savings potential: ${(totalSavings/1024/1024).toFixed(2)} MB**`;
    return r;
  }
  if (name === "get_render_blocking_details") {
    const data = await callPSI(apiKey, { ...args, category: ["performance"] });
    const audits = data.lighthouseResult?.audits || {};
    const items = audits["render-blocking-resources"]?.details?.items || [];
    const wasted = audits["render-blocking-resources"]?.details?.overallSavingsMs || 0;
    if (!items.length) return `# Render-Blocking Resources — ${args.url}\n✅ None found!`;
    let r = `# Render-Blocking Resources — ${args.url}\n**Total delay:** ${wasted}ms\n\n`;
    items.forEach((item,i) => {
      r += `${i+1}. **${(item.url||"").split("/").pop()}** — ${((item.totalBytes||0)/1024).toFixed(1)} KB, blocks ${item.wastedMs||0}ms\n`;
    });
    return r;
  }
  if (name === "get_third_party_impact") {
    const data = await callPSI(apiKey, { ...args, category: ["performance"] });
    const audits = data.lighthouseResult?.audits || {};
    const items = audits["third-party-summary"]?.details?.items || [];
    if (!items.length) return `# Third-Party Impact — ${args.url}\n✅ None detected.`;
    let r = `# Third-Party Impact — ${args.url}\n`;
    items.sort((a,b)=>(b.blockingTime||0)-(a.blockingTime||0)).forEach(p=>{
      r += `## ${p.entity}\n- Size: ${((p.transferSize||0)/1024).toFixed(1)} KB | Blocking: ${p.blockingTime||0}ms\n`;
    });
    return r;
  }
  if (name === "get_element_analysis") {
    const data = await callPSI(apiKey, { ...args, category: ["performance"] });
    const audits = data.lighthouseResult?.audits || {};
    let r = `# Element Analysis — ${args.url}\n`;
    const lcp = audits["largest-contentful-paint-element"]?.details?.items?.[0]?.node;
    if (lcp) r += `## LCP Element\n- Selector: \`${lcp.selector}\`\n- Snippet: \`${lcp.snippet}\`\n\n`;
    const cls = audits["layout-shift-elements"]?.details?.items || [];
    if (cls.length) {
      r += `## CLS Elements\n`;
      cls.forEach(item => { if (item.node) r += `- \`${item.node.selector}\` (score: ${item.score?.toFixed(3)||"?"})\n`; });
    }
    return r || `# Element Analysis — ${args.url}\nNo element data available.`;
  }
  if (name === "get_visual_analysis") {
    const data = await callPSI(apiKey, { ...args, category: ["performance"] });
    const audits = data.lighthouseResult?.audits || {};
    const filmstrip = audits["screenshot-thumbnails"]?.details?.items || [];
    let r = `# Visual Analysis — ${args.url}\n`;
    if (filmstrip.length) {
      r += `## Filmstrip (${filmstrip.length} frames)\n`;
      filmstrip.forEach((f,i) => r += `- Frame ${i+1}: ${f.timing}ms\n`);
    } else r += "No filmstrip data available.\n";
    return r;
  }
  if (name === "get_full_audit") {
    const cats = args.categories || ["performance","accessibility","best-practices","seo"];
    const data = await callPSI(apiKey, { ...args, category: cats });
    const categories = data.lighthouseResult?.categories || {};
    let r = `# Full Audit — ${args.url}\n\n## Scores\n`;
    for (const [k, v] of Object.entries(categories)) {
      const s = Math.round((v.score||0)*100);
      r += `- **${k}**: ${s>=90?"🟢":s>=50?"🟠":"🔴"} ${s}/100\n`;
    }
    return r;
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── MCP protocol helpers ─────────────────────────────────────────────────────
function jsonrpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonrpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMcpRequest(body, apiKey) {
  const { method, params, id } = body;

  if (method === "initialize") {
    return jsonrpc(id, {
      protocolVersion: MCP_VERSION,
      serverInfo: { name: "pagespeed-insights-mcp", version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } },
    });
  }
  if (method === "tools/list") {
    return jsonrpc(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params;
    try {
      const text = await handleTool(name, args || {}, apiKey);
      return jsonrpc(id, { content: [{ type: "text", text }] });
    } catch (err) {
      return jsonrpc(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
    }
  }
  if (method === "ping") return jsonrpc(id, {});
  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

// ─── Request handler ──────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", server: "pagespeed-insights-mcp", version: SERVER_VERSION }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404, headers: corsHeaders });
    }

    // Authenticate via Bearer token (your GOOGLE_API_KEY)
    const authHeader = request.headers.get("Authorization") || "";
    let apiKey = env.GOOGLE_API_KEY;

    // Allow passing API key via Bearer token header (for Lovable)
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token) apiKey = token;
    }

    if (!apiKey) {
      return new Response(JSON.stringify(jsonrpcError(null, -32001, "Missing GOOGLE_API_KEY")), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET") {
      // SSE stream for server-sent events (some clients use GET)
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      writer.write(encoder.encode(`data: ${JSON.stringify({ type: "ready" })}\n\n`));
      writer.close();
      return new Response(readable, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify(jsonrpcError(null, -32700, "Parse error")), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Handle batch requests
      if (Array.isArray(body)) {
        const results = await Promise.all(body.map(req => handleMcpRequest(req, apiKey)));
        return new Response(JSON.stringify(results), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await handleMcpRequest(body, apiKey);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  },
};
