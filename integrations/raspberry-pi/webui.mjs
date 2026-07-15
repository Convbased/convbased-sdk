// A tiny, dependency-free status panel for the Convbased voice-conversion appliance.
// Served by the Node app (index.mjs) on WEBUI_PORT (default 8080), reachable from any
// device on the LAN, e.g. your phone at http://<pi-ip>:8080.
//
// READ-ONLY by design: the voice model and conversion params are chosen in the official
// Convbased console (Open Center, API Key, Device Configuration), bound to this device's API key, and
// pulled by the app via the server profile. This page only *shows* status: current model,
// params, connection state and quality. The two exceptions are device-LOCAL hardware
// controls the cloud cannot manage: microphone mute and sidetone routed to the local USB
// headset). Mutations reject cross-origin requests and can require WEBUI_TOKEN.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PREFS_FILE =
	process.env.PREFS_FILE ?? join(homedir(), "convbased-bt", "convbased-prefs.json");
const SIDETONE_FILE =
	process.env.SIDETONE_FILE ?? join(homedir(), "convbased-bt", "convbased-sidetone");
// Legacy active-model fallback, still honored for upgrades and cleared after a bad-model
// connection failure. Current model selection lives in the server profile.
const MODEL_FILE =
	process.env.MODEL_FILE ?? join(homedir(), "convbased-bt", "convbased-model");
const SIDETONE_SRC = process.env.PW_TARGET ?? "convbased_out";

// The voice-character params, shown read-only here. The values come from the live `prefs`
// (server profile over local cache over env). Labels mirror the console's config dialog.
export const PARAM_SPEC = [
	{ key: "pitch", label: "Pitch", hint: "Semitones", type: "range", step: 1 },
	{ key: "formant", label: "Formant", hint: "Spectral resonance", type: "range", step: 0.1 },
	{ key: "index_rate", label: "Index ratio", hint: "Voice similarity, 0–1", type: "range", step: 0.01 },
	{ key: "rms_mix_rate", label: "RMS mix ratio", hint: "Amplitude envelope, 0–1", type: "range", step: 0.01 },
	{ key: "protect", label: "Protect", hint: "Consonant protection, 0–0.5", type: "range", step: 0.01 },
	{ key: "f0_autotune", label: "Autotune", hint: "", type: "bool" },
	{ key: "f0_autotune_strength", label: "Autotune strength", hint: "0–1", type: "range", step: 0.01 },
];

export function loadPrefs(defaults = {}) {
	try {
		return { ...defaults, ...JSON.parse(readFileSync(PREFS_FILE, "utf8")) };
	} catch {
		return { ...defaults };
	}
}

export function savePrefs(prefs) {
	try {
		mkdirSync(dirname(PREFS_FILE), { recursive: true });
		writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
	} catch (e) {
		console.error("[webui] failed to save prefs:", e.message);
	}
}

// Active-model override persistence (shared with index.mjs).
export function loadModelId(fallback = null) {
	try {
		const id = readFileSync(MODEL_FILE, "utf8").trim();
		return id || fallback;
	} catch {
		return fallback;
	}
}

export function saveModelId(id) {
	try {
		mkdirSync(dirname(MODEL_FILE), { recursive: true });
		writeFileSync(MODEL_FILE, String(id).trim());
	} catch (e) {
		console.error("[webui] failed to save model id:", e.message);
	}
}

export function clearModelOverride() {
	try {
		rmSync(MODEL_FILE, { force: true });
	} catch {
		/* ignore */
	}
}

// Sidetone routes the converted microphone signal to the local headset.
function sh(cmd, args) {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}

function defaultSinkName() {
	if (process.env.SIDETONE_SINK) return process.env.SIDETONE_SINK;
	const m = sh("wpctl", ["inspect", "@DEFAULT_AUDIO_SINK@"]).match(/node\.name = "([^"]+)"/);
	return m ? m[1] : null;
}

function applySidetone(on) {
	const sink = defaultSinkName();
	if (!sink || sink === SIDETONE_SRC) return { ok: false, error: "no usable default sink" };
	const monitors = sh("pw-link", ["-o"])
		.split("\n")
		.map((line) => line.trim())
		.filter((port) => port.startsWith(`${SIDETONE_SRC}:monitor_`));
	const playback = sh("pw-link", ["-i"])
		.split("\n")
		.map((line) => line.trim())
		.filter((port) => port.startsWith(`${sink}:playback_`));
	if (!monitors.length || !playback.length) return { ok: false, error: "audio ports unavailable" };
	for (const destination of playback) {
		const channel = destination.split(":playback_")[1];
		const source = monitors.find((port) => port.endsWith(`monitor_${channel}`))
			?? monitors.find((port) => port.endsWith("monitor_MONO"))
			?? monitors[0];
		const link = [source, destination];
		sh("pw-link", on ? link : ["-d", ...link]);
	}
	return { ok: true, sink };
}

function loadSidetone() {
	try {
		return readFileSync(SIDETONE_FILE, "utf8").trim() === "on";
	} catch {
		return false;
	}
}

function saveSidetone(on) {
	try {
		mkdirSync(dirname(SIDETONE_FILE), { recursive: true });
		writeFileSync(SIDETONE_FILE, on ? "on" : "off");
	} catch {
		/* ignore */
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		let settled = false;
		req.on("data", (c) => {
			if (settled) return;
			data += c;
			if (data.length > 65536) {
				settled = true;
				const error = new Error("request body too large");
				error.statusCode = 413;
				reject(error);
				req.destroy();
			}
		});
		req.on("end", () => {
			if (settled) return;
			try {
				settled = true;
				resolve(data ? JSON.parse(data) : {});
			} catch (e) {
				e.statusCode = 400;
				reject(e);
			}
		});
		req.on("error", (error) => {
			if (!settled) reject(error);
		});
	});
}

function sameOrigin(req) {
	const origin = req.headers.origin;
	if (!origin) return true; // curl/system clients do not send Origin.
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:")
			&& parsed.host === req.headers.host;
	} catch {
		return false;
	}
}

function tokenMatches(req, expected) {
	if (!expected) return true;
	const header = Array.isArray(req.headers["x-convbased-token"])
		? req.headers["x-convbased-token"][0]
		: req.headers["x-convbased-token"];
	const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1];
	const supplied = String(header || bearer || "");
	const wanted = Buffer.from(String(expected));
	const actual = Buffer.from(supplied);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * Start the read-only status panel.
 * @param {object} o
 * @param {number} [o.port]
 * @param {string} [o.host]
 * @param {string} [o.token] shared secret required by mutation endpoints
 * @param {import("@convbased/sdk").ConvbasedClient} o.client  live SDK client
 * @param {Record<string, unknown>} o.prefs  the app's current preferences (shown read-only)
 * @param {() => object} [o.getInfo]  extra status fields (state, modelId, rate, ...)
 */
export function startWebUI({ port = 8080, host = "0.0.0.0", token = "", client, prefs, getInfo }) {
	let muted = false;
	let sidetone = loadSidetone();
	if (sidetone) applySidetone(true);
	const page = HTML;

	const server = createServer(async (req, res) => {
		const json = (code, obj) => {
			res.writeHead(code, {
				"content-type": "application/json",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			res.end(JSON.stringify(obj));
		};
		try {
			const url = (req.url || "/").split("?")[0];
			if (req.method === "POST") {
				if (!sameOrigin(req)) return json(403, { ok: false, error: "cross-origin mutation rejected" });
				if (!tokenMatches(req, token)) return json(401, { ok: false, error: "invalid control token" });
				if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					return json(415, { ok: false, error: "application/json required" });
				}
			}

			if (req.method === "GET" && (url === "/" || url === "/index.html")) {
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
				});
				res.end(page);
				return;
			}

			if (req.method === "GET" && url === "/api/state") {
				let stats = null;
				try {
					stats = await client.getStats();
				} catch {
					/* not connected yet */
				}
				json(200, {
					ok: true,
					...(getInfo ? getInfo() : {}),
					muted,
					sidetone,
					controlAuth: Boolean(token),
					prefs,
					stats,
					spec: PARAM_SPEC,
				});
				return;
			}

			// Device-LOCAL hardware controls (no cloud equivalent), kept interactive.
			if (req.method === "POST" && url === "/api/mute") {
				const body = await readBody(req);
				muted = Boolean(body && body.muted);
				try {
					client.setMuted(muted);
				} catch {
					/* ignore */
				}
				json(200, { ok: true, muted });
				return;
			}

			if (req.method === "POST" && url === "/api/sidetone") {
				const body = await readBody(req);
				const on = Boolean(body && body.on);
				const r = applySidetone(on);
				if (!r.ok) return json(409, { ok: false, error: r.error, sidetone });
				sidetone = on;
				saveSidetone(on);
				json(200, { ok: true, sidetone, sink: r.sink });
				return;
			}

			res.writeHead(404);
			res.end("not found");
		} catch (e) {
			json(e.statusCode || 500, { ok: false, error: e.message });
		}
	});

	server.on("error", (e) => console.error("[webui] server error:", e.message));
	server.listen(port, host, () => {
		const address = server.address();
		const actualPort = typeof address === "object" && address ? address.port : port;
		console.log(`[webui] status panel on http://${host}:${actualPort}`);
	});
	return {
		server,
		close: () => new Promise((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

// The page. Plain HTML/CSS/JS, no build step. Read-only status; the embedded script
// avoids template literals and backslash escapes so this stays one JS template. Palette
// mirrors the official Convbased console: slate #1d1f21/#2c2e30 with brand orange #ff6600.
const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Convbased Device Status</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#1d1f21; color:#f5f5f5; font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width:560px; margin:0 auto; padding:18px 16px 60px; }
  h1 { font-size:18px; margin:6px 0 14px; display:flex; align-items:center; gap:10px; }
  .badge { font-size:12px; font-weight:600; padding:3px 9px; border-radius:999px; background:#2c2e30; color:#aab; }
  .badge.ok { background:#10371f; color:#5fdd88; }
  .badge.bad { background:#3a1620; color:#ff8aa0; }
  .meta { font-size:12px; color:#929292; margin:-8px 0 16px; word-break:break-all; }
  .card { background:#2c2e30; border:1px solid #3a3d40; border-radius:14px; padding:14px 16px; margin-bottom:12px; }
  .card h2 { font-size:13px; margin:0 0 10px; color:#c2c2c2; font-weight:600; letter-spacing:.04em; }
  .ro { display:flex; justify-content:space-between; align-items:baseline; padding:6px 0; border-bottom:1px solid #34373a; }
  .ro:last-child { border-bottom:0; }
  .ro .name { font-size:13px; color:#e0e0e0; }
  .ro .hint { font-size:11px; color:#777; margin-left:6px; }
  .ro .val { font-variant-numeric:tabular-nums; color:#ff983f; font-weight:700; }
  .ro .val.off { color:#777e90; font-weight:600; }
  .toggle { display:flex; align-items:center; gap:10px; cursor:pointer; }
  .sw { width:42px; height:24px; border-radius:999px; background:#444648; position:relative; transition:.15s; flex:0 0 auto; }
  .sw::after { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:.15s; }
  .sw.on { background:#ff6600; } .sw.on::after { left:21px; }
  .btn { width:100%; padding:12px; border:1px solid #3a3d40; border-radius:12px; background:#1d1f21; color:#f5f5f5; font-size:15px; font-weight:600; cursor:pointer; margin-top:8px; }
  .btn.muted { background:#3a1620; color:#ff8aa0; border-color:#5a2230; }
  .stat { display:flex; gap:16px; font-size:12px; color:#929292; flex-wrap:wrap; margin-top:12px; }
  .stat b { color:#e0e0e0; font-weight:600; }
  .note { font-size:12px; color:#777e90; margin-top:4px; }
  .note a { color:#ff983f; text-decoration:none; }
  .toast { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); background:#2c2e30; color:#ffd9bf; border:1px solid #3a3d40; padding:8px 14px; border-radius:10px; font-size:13px; opacity:0; transition:.2s; pointer-events:none; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Convbased Device Status <span id="state" class="badge">…</span></h1>
  <div class="meta" id="meta"></div>

  <div class="card">
    <h2>Current Model and Parameters (Read-Only)</h2>
    <div class="ro"><span class="name">Model</span><span class="val" id="model">–</span></div>
    <div id="params"></div>
    <div class="note">Modify the model and parameters in Open Center &gt; API Key &gt; Device Configuration. This device synchronizes them automatically.</div>
  </div>

  <div class="card">
    <h2>Local Controls</h2>
    <div class="toggle" style="margin:4px 0 2px"><div class="sw" id="sw_sidetone"></div>
      <div><div class="name">Sidetone</div><div class="hint">Monitor the converted microphone signal through the local headset.</div></div>
    </div>
    <button id="mute" class="btn">Mute microphone</button>
    <div class="stat">
      <span>RTT <b id="rtt">–</b> ms</span>
      <span>Jitter <b id="jit">–</b></span>
      <span>Packet loss <b id="loss">–</b></span>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(function(){
  var byId = function(i){ return document.getElementById(i); };
  var toastT;
	var tokenRequired = false;
  function toast(t){ var el=byId('toast'); el.textContent=t; el.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(function(){el.classList.remove('show');},1400); }
  function controlToken(){
    if(!tokenRequired) return '';
    var token=sessionStorage.getItem('convbased-control-token')||'';
    if(!token){ token=window.prompt('Enter the local control token')||''; if(token) sessionStorage.setItem('convbased-control-token',token); }
    return token;
  }
  function post(url, body){
    var headers={'content-type':'application/json'}; var token=controlToken();
    if(token) headers['x-convbased-token']=token;
    return fetch(url,{method:'POST',headers:headers,body:JSON.stringify(body)}).then(function(r){
      return r.json().then(function(v){ if(r.status===401) sessionStorage.removeItem('convbased-control-token'); return v; });
    });
  }

  function fmt(v, step){ var n=Number(v||0); return (step&&step<1) ? n.toFixed(2) : String(Math.round(n)); }

  function renderParams(spec, prefs){
    var box = byId('params'); if(!box) return;
    var html='';
    (spec||[]).forEach(function(p){
      var has = prefs && (p.key in prefs);
      var v = has ? prefs[p.key] : null;
      var valHtml;
      if(p.type==='bool'){
        valHtml = '<span class="val'+(v?'':' off')+'">'+(v?'On':'Off')+'</span>';
      } else {
        valHtml = '<span class="val">'+(has?fmt(v,p.step):'–')+'</span>';
      }
      html += '<div class="ro"><span><span class="name">'+p.label+'</span><span class="hint">'+(p.hint||'')+'</span></span>'+valHtml+'</div>';
    });
    box.innerHTML = html;
  }

  function refresh(){
    fetch('/api/state').then(function(r){return r.json();}).then(function(s){
      if(!s || !s.ok) return;
	  tokenRequired = !!s.controlAuth;
      var st = byId('state'); var conn = (s.state==='connected');
      st.textContent = s.state || '?'; st.className = 'badge '+(conn?'ok':(s.state==='error'?'bad':''));
      byId('meta').textContent = (s.rate||'?')+' Hz';
      byId('model').textContent = s.modelId || '–';
      renderParams(s.spec, s.prefs);
      var m = byId('mute'); m.textContent = s.muted ? 'Unmute microphone' : 'Mute microphone'; m.className = 'btn'+(s.muted?' muted':'');
      var ss = byId('sw_sidetone'); if(ss) ss.classList.toggle('on', !!s.sidetone);
      if(s.stats){ byId('rtt').textContent=s.stats.rttMs; byId('jit').textContent=(s.stats.jitter*1000).toFixed(1); byId('loss').textContent=s.stats.packetsLost; }
    }).catch(function(){ var st=byId('state'); st.textContent='Offline'; st.className='badge bad'; });
  }

  byId('mute').addEventListener('click', function(){
    var muting = byId('mute').className.indexOf('muted')<0;
	post('/api/mute',{muted:muting}).then(function(r){ if(r.ok) refresh(); else toast(r.error||'Control request failed'); });
  });

  byId('sw_sidetone').addEventListener('click', function(){
    var on = !byId('sw_sidetone').classList.contains('on');
    post('/api/sidetone',{on:on}).then(function(r){
      if(r.ok){ byId('sw_sidetone').classList.toggle('on', r.sidetone); toast(r.sidetone?'Sidetone enabled':'Sidetone disabled'); }
      else { toast('Sidetone update failed: '+(r.error||'')); }
	}).catch(function(){ toast('Sidetone request failed'); });
  });

  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>`;
