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
      { days: z.number().optional().describe("Days back, default 14") },
      async ({ days = 14 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/activities?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
          this.icu(`/activity/${id}/streams?types=time,heartrate,velocity_smooth,distance,altitude,cadence`),
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

        // downsampled streams
        const step = Math.max(1, resolution);
        const samples: any[] = [];
        let next = 0;
        for (let i = 0; i < n; i++) {
          if (t[i] >= next) {
            samples.push([t[i], hr[i] ?? null, v[i] != null ? r1(v[i] * 3.6) : null, d[i] != null ? Math.round(d[i]) : null, alt[i] != null ? Math.round(alt[i]) : null, cad[i] ?? null]);
            next = t[i] + step;
          }
        }

        const out = {
          activityId,
          laps,
          splits,
          halves,
          timeAboveHr,
          streams: { columns: ["sec", "hr", "kmh", "m", "alt", "cadence"], resolution: step, data: samples },
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
