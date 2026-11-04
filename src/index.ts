import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

const BASE = "https://intervals.icu/api/v1";

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Intervals.icu", version: "1.0.0" });

  private authHeader() {
    return `Basic ${btoa(`API_KEY:${this.env.INTERVALS_API_KEY}`)}`;
  }

  private async icu(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: this.authHeader(), "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`intervals.icu ${res.status}: ${await res.text()}`);
    const text = await res.text();
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, raw: text };
    }
  }

  async init() {
    const athlete = this.env.INTERVALS_ATHLETE_ID;

    this.server.tool(
      "getRecentActivities",
      {
        days: z.number().optional().describe("Days back, default 14"),
        compact: z.boolean().optional().describe("Return only the core fields per activity (much smaller payload)"),
      },
      async ({ days = 14, compact = false }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/activities?oldest=${oldest}`);
        if (!compact || !Array.isArray(data)) return { content: [{ type: "text", text: JSON.stringify(data) }] };
        const keep = ["id", "name", "type", "start_date_local", "moving_time", "elapsed_time", "distance", "total_elevation_gain",
          "average_heartrate", "max_heartrate", "gap", "icu_training_load", "icu_hr_zone_times", "icu_ignore_hr",
          "icu_aerobic_decoupling", "aerobic_decoupling", "icu_decoupling", "decoupling", "lthr", "pa_hr", "average_cadence", "icu_average_watts", "average_speed"];
        const rows = (data as any[]).map((a) => Object.fromEntries(keep.filter((k) => a[k] != null).map((k) => [k, a[k]])));
        return { content: [{ type: "text", text: JSON.stringify(rows) }] };
      },
    );

    this.server.tool(
      "searchActivities",
      {
        oldest: z.string().describe("YYYY-MM-DD, first date to include"),
        newest: z.string().optional().describe("YYYY-MM-DD, last date to include, default today"),
        minKm: z.number().optional().describe("Only activities at least this long, in km"),
        minHours: z.number().optional().describe("Only activities at least this long, in hours"),
        type: z.string().optional().describe("Substring match on type, e.g. Run, Hike, Walk, Ski, Ride"),
      },
      async ({ oldest, newest, minKm, minHours, type }) => {
        const q = `oldest=${encodeURIComponent(oldest)}${newest ? `&newest=${encodeURIComponent(newest)}` : ""}`;
        const data = (await this.icu(`/athlete/${athlete}/activities?${q}`)) as any[];
        const rows = (Array.isArray(data) ? data : [])
          .filter((a) => (!minKm || (a.distance ?? 0) >= minKm * 1000)
            && (!minHours || (a.moving_time ?? 0) >= minHours * 3600)
            && (!type || String(a.type ?? "").toLowerCase().includes(type.toLowerCase())))
          .map((a) => ({
            id: a.id,
            start: a.start_date_local,
            type: a.type,
            name: a.name,
            km: a.distance != null ? Math.round(a.distance / 100) / 10 : null,
            movingH: a.moving_time != null ? Math.round(a.moving_time / 360) / 10 : null,
            elapsedH: a.elapsed_time != null ? Math.round(a.elapsed_time / 360) / 10 : null,
            elevGain: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : null,
            maxAlt: a.max_altitude != null ? Math.round(a.max_altitude) : null,
            avgHr: a.average_heartrate ?? null,
            maxHr: a.max_heartrate ?? null,
            load: a.icu_training_load ?? null,
          }));
        return { content: [{ type: "text", text: JSON.stringify({ count: rows.length, activities: rows }) }] };
      },
    );

    this.server.tool(
      "getWellness",
      { days: z.number().optional().describe("Days back, default 7") },
      async ({ days = 7 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/wellness?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "listUpcomingEvents",
      { days: z.number().optional().describe("Days ahead, default 14") },
      async ({ days = 14 }) => {
        const today = new Date().toISOString().slice(0, 10);
        const newest = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/events?oldest=${today}&newest=${newest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "createWorkout",
      {
        date: z.string().describe("YYYY-MM-DD"),
        name: z.string(),
        type: z.string().describe("Run, Ride, Swim, etc."),
        description: z.string().describe("Structured steps, e.g. '- 10m Z2\\n- 6x800m Z4, 400m Z1 jog\\n- 10m Z2'"),
      },
      async ({ date, name, type, description }) => {
        const data = await this.icu(`/athlete/${athlete}/events`, {
          method: "POST",
          body: JSON.stringify({ start_date_local: `${date}T00:00:00`, category: "WORKOUT", type, name, description }),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "updateWorkout",
      {
        eventId: z.number().describe("Event ID from listUpcomingEvents"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ eventId, date, name, type, description }) => {
        const body: Record<string, unknown> = {};
        if (date) body.start_date_local = `${date}T00:00:00`;
        if (name) body.name = name;
        if (type) body.type = type;
        if (description) body.description = description;
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getActivityDetail",
      {
        activityId: z.string().describe("Activity id from getRecentActivities, e.g. i204077681"),
        resolution: z.number().optional().describe("Seconds between stream samples, default 30"),
        hrThreshold: z.number().optional().describe("Heart rate to report time above, e.g. aerobic threshold"),
      },
      async ({ activityId, resolution = 30, hrThreshold }) => {
        const id = encodeURIComponent(activityId);
        const [ivRes, stRes] = await Promise.allSettled([
          this.icu(`/activity/${id}/intervals`),
          this.icu(`/activity/${id}/streams?types=time,heartrate,velocity_smooth,distance,altitude,cadence,watts,stance_time,vertical_oscillation,step_length`)
            .catch(() => this.icu(`/activity/${id}/streams?types=time,heartrate,velocity_smooth,distance,altitude,cadence`)),
        ]);

        const laps = ivRes.status === "fulfilled"
          ? ((ivRes.value?.icu_intervals ?? []) as any[]).map((v) => ({
              type: v.type,
              label: v.label ?? null,
              start: v.start_time,
              secs: v.moving_time ?? v.elapsed_time,
              km: v.distance != null ? Math.round(v.distance) / 1000 : null,
              avgHr: v.average_heartrate ?? null,
              maxHr: v.max_heartrate ?? null,
              kmh: v.average_speed != null ? Math.round(v.average_speed * 36) / 10 : null,
              gapKmh: v.gap != null ? Math.round(v.gap * 36) / 10 : null,
              elevGain: v.total_elevation_gain ?? null,
              cadence: v.average_cadence ?? null,
              decoupling: v.decoupling ?? null,
            }))
          : [];

        const s: Record<string, number[]> = {};
        if (stRes.status === "fulfilled" && Array.isArray(stRes.value)) {
          for (const x of stRes.value as any[]) if (x?.type && Array.isArray(x.data)) s[x.type] = x.data;
        }
        const t = s.time ?? [], hr = s.heartrate ?? [], v = s.velocity_smooth ?? [], d = s.distance ?? [], alt = s.altitude ?? [], cad = s.cadence ?? [];
        const pw = s.watts ?? [], gct = s.stance_time ?? [], vo = s.vertical_oscillation ?? [], stp = s.step_length ?? [];
        const n = t.length;
        const mean = (a: number[]) => { const b = a.filter((x) => Number.isFinite(x) && x > 0); return b.length ? b.reduce((p, q) => p + q, 0) / b.length : null; };
        const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

        // per-km splits
        const splits: any[] = [];
        if (d.length === n && n > 1) {
          let k = 1, i0 = 0;
          for (let i = 1; i < n; i++) {
            if (d[i] >= k * 1000 || i === n - 1) {
              const secs = t[i] - t[i0], dist = d[i] - d[i0];
              if (dist > 200) splits.push({
                km: k, secs, pace: dist > 0 ? Math.round((secs / dist) * 1000) : null,
                avgHr: r1(mean(hr.slice(i0, i + 1))),
                elev: alt.length === n ? Math.round(alt[i] - alt[i0]) : null,
              });
              i0 = i; k++;
            }
          }
        }

        // halves (aerobic drift)
        let halves = null;
        if (n > 20 && hr.length === n) {
          const mid = Math.floor(n / 2);
          const h = (a: number, b: number) => ({ avgHr: r1(mean(hr.slice(a, b))), kmh: v.length === n ? r1((mean(v.slice(a, b)) ?? 0) * 3.6) : null });
          const a = h(0, mid), b = h(mid, n);
          const ef = (x: any) => (x.avgHr && x.kmh ? x.kmh / x.avgHr : null);
          const ea = ef(a), eb = ef(b);
          halves = { first: a, second: b, driftPct: ea && eb ? r1(((ea - eb) / ea) * 100) : null };
        }

        let timeAboveHr = null;
        if (hrThreshold && hr.length === n) {
          let secs = 0;
          for (let i = 1; i < n; i++) if (hr[i] > hrThreshold) secs += t[i] - t[i - 1];
          timeAboveHr = { threshold: hrThreshold, secs };
        }

        // downsampled streams: mean over each window (time, distance and altitude at window start)
        const step = Math.max(1, resolution);
        const samples: any[] = [];
        const avg = (a: number[], i0: number, i1: number) => {
          let sum = 0, k = 0;
          for (let j = i0; j < i1; j++) { const x = a[j]; if (Number.isFinite(x) && x > 0) { sum += x; k++; } }
          return k ? sum / k : null;
        };
        let i0 = 0;
        while (i0 < n) {
          let i1 = i0 + 1;
          while (i1 < n && t[i1] < t[i0] + step) i1++;
          const r0 = (x: number | null) => (x == null ? null : Math.round(x));
          samples.push([
            t[i0], r0(avg(hr, i0, i1)), v.length ? r1((avg(v, i0, i1) ?? 0) * 3.6) : null,
            d[i0] != null ? Math.round(d[i0]) : null, alt[i0] != null ? Math.round(alt[i0]) : null, r0(avg(cad, i0, i1)),
            pw.length ? r0(avg(pw, i0, i1)) : null, gct.length ? r0(avg(gct, i0, i1)) : null,
            vo.length ? r1(avg(vo, i0, i1)) : null, stp.length ? r0(avg(stp, i0, i1)) : null,
          ]);
          i0 = i1;
        }

        const out = {
          activityId,
          laps,
          splits,
          halves,
          timeAboveHr,
          streams: { columns: ["sec", "hr", "kmh", "m", "alt", "cadence", "watts", "gct_ms", "vo_mm", "step_mm"], resolution: step, data: samples },
          errors: [ivRes, stRes].filter((r) => r.status === "rejected").map((r: any) => String(r.reason)),
        };
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      },
    );

    this.server.tool(
      "deleteEvent",
      { eventId: z.number().describe("Event ID from listUpcomingEvents") },
      async ({ eventId }) => {
        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, { method: "DELETE" });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    // --- research tools: lets the coach look up sources on its own ---
    const UA = "Mozilla/5.0 (compatible; BasekampCoach/1.0)";
    const clean = (html: string) => html
      .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<(br|p|div|li|h[1-6]|tr|section|article)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
      .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

    this.server.tool(
      "webSearch",
      {
        query: z.string().describe("Search query, e.g. 'Uphill Athlete heart rate drift test'"),
        max: z.number().optional().describe("Max results, default 8"),
      },
      async ({ query, max = 8 }) => {
        const out: { title: string; url: string; snippet: string }[] = [];
        const tried: string[] = [];
        const add = (title: string, url: string, snippet: string) => {
          if (!url || out.length >= max || out.some((o) => o.url === url)) return;
          if (/duckduckgo\.com\/y\.js|bing\.com\/aclick/.test(url)) return;
          out.push({ title: clean(title), url, snippet: clean(snippet).slice(0, 400) });
        };
        // 1) Bing RSS (stable, easy to parse)
        try {
          const r = await fetch("https://www.bing.com/search?format=rss&count=" + Math.min(max * 2, 30) + "&q=" + encodeURIComponent(query), { headers: { "User-Agent": UA, "Accept-Language": "en,nb;q=0.8" } });
          const x = await r.text(); tried.push("bing:" + r.status);
          for (const it of x.match(/<item>[\s\S]*?<\/item>/g) || []) {
            const g = (t: string) => ((it.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`)) || [])[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "");
            add(g("title"), g("link").trim(), g("description"));
          }
        } catch (e) { tried.push("bing:err"); }
        // 2) DuckDuckGo lite
        if (!out.length) try {
          const r = await fetch("https://lite.duckduckgo.com/lite/", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "q=" + encodeURIComponent(query) });
          const h = await r.text(); tried.push("ddg-lite:" + r.status);
          const re = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(h))) { let u = m[1]; const q = u.match(/[?&]uddg=([^&]+)/); if (q) u = decodeURIComponent(q[1]); if (u.startsWith("//")) u = "https:" + u; add(m[2], u, m[3]); }
        } catch (e) { tried.push("ddg-lite:err"); }
        // 3) DuckDuckGo html
        if (!out.length) try {
          const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), { headers: { "User-Agent": UA } });
          const h = await r.text(); tried.push("ddg-html:" + r.status);
          const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(h))) { let u = m[1]; const q = u.match(/[?&]uddg=([^&]+)/); if (q) u = decodeURIComponent(q[1]); if (u.startsWith("//")) u = "https:" + u; add(m[2], u, m[3] || ""); }
        } catch (e) { tried.push("ddg-html:err"); }
        return { content: [{ type: "text", text: JSON.stringify({ query, results: out, note: out.length ? undefined : "No results from " + tried.join(", ") + ". Try searchStudies, or fetchPage on a known site (e.g. https://uphillathlete.com/?s=...)." }) }] };
      },
    );

    this.server.tool(
      "fetchPage",
      {
        url: z.string().describe("Full https URL of a public web page"),
        maxChars: z.number().optional().describe("Max characters of text to return, default 15000"),
      },
      async ({ url, maxChars = 15000 }) => {
        if (!/^https:\/\//.test(url)) throw new Error("Only https URLs");
        const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,text/plain" }, redirect: "follow" });
        const type = res.headers.get("content-type") || "";
        if (!/text|html|json|xml/.test(type)) throw new Error("Not a text page: " + type);
        const raw = await res.text();
        const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
        const text = /html/.test(type) ? clean(raw) : raw;
        return { content: [{ type: "text", text: JSON.stringify({ url: res.url, status: res.status, title: clean(title), text: text.slice(0, maxChars), truncated: text.length > maxChars }) }] };
      },
    );

    this.server.tool(
      "searchStudies",
      {
        query: z.string().describe("PubMed search, e.g. 'polarized training recreational runners'"),
        max: z.number().optional().describe("Max studies, default 8"),
      },
      async ({ query, max = 8 }) => {
        // Europe PMC: includes PubMed, abstracts in one call, generous rate limits
        try {
          const r = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=${max}&sort=RELEVANCE&query=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } });
          const j = await r.json() as any;
          const res: any[] = j?.resultList?.result || [];
          if (res.length) {
            const studies = res.map((x) => ({
              pmid: x.pmid, doi: x.doi, title: x.title, journal: x.journalInfo?.journal?.title || x.bookOrReportDetails?.publisher, year: x.pubYear,
              authors: (x.authorString || "").split(", ").slice(0, 3).join(", "), openAccess: x.isOpenAccess === "Y", citedBy: x.citedByCount,
              url: x.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/` : x.doi ? `https://doi.org/${x.doi}` : `https://europepmc.org/article/${x.source}/${x.id}`,
              abstract: clean(x.abstractText || "").slice(0, 1800),
            }));
            return { content: [{ type: "text", text: JSON.stringify({ query, source: "Europe PMC", studies }) }] };
          }
        } catch (e) { /* fall back to PubMed */ }
        const e = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
        const wait = () => new Promise((r) => setTimeout(r, 400));
        const ids = await (await fetch(`${e}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${max}&term=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } })).json() as any;
        const list: string[] = ids?.esearchresult?.idlist || [];
        if (!list.length) return { content: [{ type: "text", text: JSON.stringify({ query, studies: [] }) }] };
        await wait();
        const sum = await (await fetch(`${e}/esummary.fcgi?db=pubmed&retmode=json&id=${list.join(",")}`, { headers: { "User-Agent": UA } })).json() as any;
        await wait();
        const abs = await (await fetch(`${e}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${list.join(",")}`, { headers: { "User-Agent": UA } })).text();
        const studies = list.map((id) => { const r = sum?.result?.[id] || {}; return { pmid: id, title: r.title, journal: r.fulljournalname, year: (r.pubdate || "").slice(0, 4), authors: (r.authors || []).slice(0, 3).map((a: any) => a.name).join(", "), url: `https://pubmed.ncbi.nlm.nih.gov/${id}/` }; });
        return { content: [{ type: "text", text: JSON.stringify({ query, source: "PubMed", studies, abstracts: abs.slice(0, 12000) }) }] };
      },
    );
  }
}

function loginPage(state: string, error: string) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intervals.icu MCP</title>
  <body style="font-family:system-ui;max-width:20rem;margin:4rem auto">
  <h2>Intervals.icu MCP</h2>
  <p style="color:#c00">${error}</p>
  <form method="post">
    <input type="hidden" name="state" value="${state}">
    <input type="password" name="password" placeholder="Password" autofocus
           style="width:100%;padding:.5rem;margin-bottom:.5rem">
    <button style="width:100%;padding:.5rem">Authorize</button>
  </form></body>`;
}

const defaultHandler = {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const html = { "content-type": "text/html;charset=utf-8" };

    if (request.method === "GET") {
      const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      return new Response(loginPage(btoa(JSON.stringify(info)), ""), { headers: html });
    }

    const body = await request.formData();
    const state = String(body.get("state") ?? "");
    if (String(body.get("password")) !== env.MCP_PASSWORD) {
      return new Response(loginPage(state, "Wrong password"), { status: 401, headers: html });
    }

    const info = JSON.parse(atob(state));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: info,
      userId: "owner",
      metadata: {},
      scope: info.scope ?? [],
      props: {},
    });
    return Response.redirect(redirectTo, 302);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MyMCP.serve("/mcp") as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
