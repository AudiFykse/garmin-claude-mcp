# garmin-claude-mcp

Connect your Garmin training data to Claude, and let Claude push structured workouts back to your watch. Free to run. No subscription.

Claude reads your recent activities and wellness data, designs a workout, and writes it to your intervals.icu calendar. Intervals.icu syncs it to Garmin Connect, and it lands on your watch.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kbaudour/garmin-claude-mcp)

## Why it works this way

Garmin's developer API is closed to individuals. Applications are approved for companies, and the program is currently suspended to new applicants. Unofficial libraries that log in with your Garmin password exist, but Garmin has broken them before by changing its auth flow.

Intervals.icu has an official Garmin partnership that predates the program closing. It already syncs both directions, including pushing planned workouts to your watch. It also has a documented API with a personal key. So Claude talks to intervals.icu, and intervals.icu talks to Garmin. Your Garmin password never leaves Garmin.

## What you need

- A Garmin device syncing to Garmin Connect
- A free [intervals.icu](https://intervals.icu) account with Garmin connected under Settings > Integrations, and **"Upload planned workouts" turned on**
- Your intervals.icu API key and athlete id, both under Settings > Developer Settings
- A free Cloudflare account

If "Upload planned workouts" is off, everything below will work perfectly and nothing will ever reach your watch. Check it first.

## Setup

### Option 1: Deploy button

1. Click the button above. Cloudflare forks this repo to your GitHub, provisions the KV namespace and Durable Object, and prompts you for three secrets.
2. Fill in `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`, and `MCP_PASSWORD`. Generate the password with `openssl rand -hex 32`.
3. Deploy. You get a URL like `https://garmin-claude-mcp.<subdomain>.workers.dev`.

### Option 2: Manual

```bash
git clone https://github.com/kbaudour/garmin-claude-mcp
cd garmin-claude-mcp
npm install

npx wrangler kv namespace create OAUTH_KV
# paste the printed id into wrangler.jsonc

npx wrangler secret put INTERVALS_API_KEY
npx wrangler secret put INTERVALS_ATHLETE_ID
npx wrangler secret put MCP_PASSWORD

npm run deploy
```

### Connect it to Claude

In claude.ai, go to Settings > Connectors > Add custom connector and enter your worker URL **with `/mcp` on the end**:

```
https://garmin-claude-mcp.<subdomain>.workers.dev/mcp
```

That path matters. OAuth discovery lives at the domain root, so login will succeed even with the wrong URL, then the connection fails afterward with "Couldn't connect to the server." If you hit that, delete the connector and re-add it with the `/mcp` path rather than editing the URL in place, so the stale registration is discarded.

You will see a password page. Enter your `MCP_PASSWORD`. Once connected on web, it works on mobile too.

## Tools

| Tool | What it does |
| --- | --- |
| `getRecentActivities` | Recent training history |
| `getWellness` | Sleep, HRV, resting HR, recovery signals |
| `listUpcomingEvents` | What is already on the calendar |
| `createWorkout` | Writes a structured workout, which syncs to Garmin |
| `updateWorkout` | Edits an existing planned workout |
| `deleteEvent` | Removes a planned workout |

## First prompt to try

```
Pull my wellness data for the last 7 days and my recent activities for the
last 14 days.

Based on what you see there, recovery, training load, how recent runs have
gone, design one run for tomorrow. Walk me through your reasoning before you
create it.

Then create it, and list my upcoming events so I can confirm it landed.
```

Then open Garmin Connect and check tomorrow's date.

## Known issues and limits

- **Claude's free plan allows one custom connector.** This uses that slot.
- **The password page has no rate limiting and no CSRF token.** It is a single-user server behind a random 64 character password. Fine for that. Not production auth.
- **`updateWorkout` and `deleteEvent` are lightly tested.** The read tools and `createWorkout` are confirmed working end to end, watch included.
- **Token refresh over long periods is untested.** If the connector goes stale, reconnecting takes a few seconds.
- **Anyone with your worker URL sees the password page.** They cannot get further without the password, but the URL is not secret.

## Cost

$0/month. Cloudflare Workers free tier covers 100,000 requests per day. Intervals.icu's free tier includes Garmin sync. Durable Objects have been on the free tier since April 2025, so older guides saying otherwise are out of date.

## License

MIT
