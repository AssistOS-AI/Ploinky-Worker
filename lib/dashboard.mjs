// Self-contained dashboard page (no external assets). Polls /stats.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LLM API Provider monitor</title>
<style>
:root{--bg:#fff;--fg:#1c1f24;--mut:#667;--line:#dde1e6;--acc:#2b6cb0;--bad:#c53030}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e8eb;--mut:#9aa3ad;--line:#2b313a;--acc:#63b3ed;--bad:#fc8181}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;max-width:1100px;margin:auto}
h1{font-size:20px}h2{font-size:15px;margin:22px 0 6px}
table{border-collapse:collapse;width:100%;overflow-x:auto;display:block}
th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--mut);font-weight:600}
.bad{color:var(--bad)}.warn{color:#b7791f;font-weight:600}.bar{display:inline-block;width:80px;height:8px;background:var(--line);border-radius:4px;vertical-align:middle;margin-right:6px}.bar i{display:block;height:8px;border-radius:4px;background:var(--acc)}.bar i.w{background:#d69e2e}.bar i.x{background:var(--bad)}.mut{color:var(--mut)}svg{width:100%;height:80px}
code{background:var(--line);padding:0 4px;border-radius:3px}
</style></head><body>
<h1>LLM API Provider monitor</h1><div id="meta" class="mut">loading…</div>
<h2>Plan limits</h2><div id="plan"></div>
<h2>Value: subscription or pay-per-token</h2><div id="val"></div>
<h2>Upstreams</h2><div id="up"></div>
<h2>Windows</h2><div id="win"></div>
<h2>Fallbacks</h2><div id="fb"></div>
<h2>Calls per minute, last hour</h2><svg id="chart" viewBox="0 0 600 80" preserveAspectRatio="none"></svg>
<h2>By model</h2><div id="mod"></div>
<h2>Inferred limits</h2><div id="lim"></div>
<h2>Quota (plan requests left)</h2><div id="quota"></div>
<h2>Rate-limit headers seen</h2><div id="hdr"></div>
<h2>Token honesty check</h2><div id="tok"></div>
<h2>Recent requests</h2><div id="rec"></div>
<script>
const $=id=>document.getElementById(id);
const f=(n,d=0)=>n==null?'–':Number(n).toLocaleString(undefined,{maximumFractionDigits:d});
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function table(head,rows){return '<table><tr>'+head.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</table>'}
async function tick(){
 const q=location.search; let s;
 try{s=await (await fetch('stats'+q)).json()}catch(e){$('meta').textContent='stats unavailable';return}
 $('meta').textContent='updated '+s.now+' · uptime '+s.uptime_s+' s · '+s.records_in_memory+' records · error rate '+f(s.error_rate*100,1)+'% · 429 rate '+f(s.rate429*100,1)+'% · latency p50/p95/p99 '+f(s.latency_ms.p50)+'/'+f(s.latency_ms.p95)+'/'+f(s.latency_ms.p99)+' ms';
 $('up').innerHTML=table(['upstream','queue depth','active','paused ms','limits'],Object.entries(s.upstreams).map(([n,u])=>[esc(n),u.depth,u.active,f(u.paused_ms),'<code>'+esc(JSON.stringify(u.limits))+'</code>']));
 $('win').innerHTML=table(['window','calls','errors','429','in tok','out tok','cached tok','cost USD (est.)','credit USD','plan requests','fallbacks'],Object.entries(s.windows).map(([n,w])=>[n,f(w.calls),f(w.errors),f(w.r429),f(w.in_tokens),f(w.out_tokens),f(w.cached_tokens),f(w.cost_usd,4),f(w.credit_cost_usd,4),f(w.plan_requests),f(w.fallbacks)]));
 const fb=s.fallback||{total:0,last:[]};
 $('fb').innerHTML=fb.total?'<p>'+f(fb.total)+' total · '+f(fb.hour)+' last hour · '+f(fb.day)+' last day · by kind '+esc(JSON.stringify(fb.by_kind))+'</p>'+table(['time','from','to','kind','status','client','reason'],fb.last.map(x=>[esc(x.ts),esc(x.from),esc(x.to),esc(x.kind),x.status,esc(x.client),esc((x.reason||'').slice(0,80))])):'<span class="mut">no fallback yet</span>';
 const v=s.calls_per_minute_last_hour,mx=Math.max(1,...v);
 $('chart').innerHTML=v.map((n,i)=>'<rect x="'+(i*10+1)+'" y="'+(80-n/mx*76)+'" width="8" height="'+(n/mx*76)+'" fill="var(--acc)"><title>'+n+' calls</title></rect>').join('');
 $('mod').innerHTML=table(['model','billing','quota cost','mult','calls/min','calls/h','calls/day','errors','429','in tok','out tok','cached','cost USD','plan req','p50 ms','p95 ms','ttft p50'],Object.entries(s.by_model).map(([m,x])=>[esc(m),x.billing==='credit'?'<span class="bad">credit (not in plan)</span>':'plan',esc((x.quota_cost_seen||[]).join(', ')||'–'),x.quota_multiplier??'–',x.calls_minute,x.calls_hour,x.calls_day,f(x.errors),f(x.r429),f(x.in_tokens),f(x.out_tokens),f(x.cached_tokens),f(x.cost_usd,4),f(x.plan_requests),f(x.latency_ms.p50),f(x.latency_ms.p95),f(x.ttft_ms.p50)]));
 const dur=ms=>ms==null?'–':ms<90e3?f(ms/1000)+' s':ms<5400e3?f(ms/60e3,1)+' min':ms<172800e3?f(ms/3600e3,1)+' h':f(ms/86400e3,1)+' d';
 $('plan').innerHTML=Object.entries(s.plan||{}).map(([n,p])=>'<p><b>'+esc(n)+'</b> · subscription '+f(p.price_usd_per_month,2)+' USD/month'+(p.warnings.length?' · <span class="warn">warning: '+esc(p.warnings.join('; '))+'</span>':'')+'</p>'+table(['limit','unit','window','used','max','left','','next relief','provider says left','diff (provider - ours)','provider vs ours since reset'],p.limits.map(l=>{const c=l.exceeded?'x':l.warn?'w':'';const pv=l.provider;return [esc(l.name),l.unit,esc(l.window)+(l.mode==='fixed'?' fixed':''),f(l.used,2),f(l.max),f(l.remaining,2),'<span class="bar"><i class="'+c+'" style="width:'+Math.min(100,l.pct*100)+'%"></i></span><span class="'+(c?'warn':'')+'">'+f(l.pct*100,0)+'%</span>',dur(l.next_relief_ms),pv?f(pv.remaining,2)+' <span class="mut">('+pv.age_s+' s ago)</span>':'–',pv?f(pv.diff_remaining,2):'–',pv&&pv.agreement?'provider '+f(pv.agreement.provider_used,2)+' / ours '+f(pv.agreement.our_used,2)+' (diff '+f(pv.agreement.diff,2)+')':'–']}))).join('')||'<span class="mut">no plan limits configured</span>';
 $('val').innerHTML=Object.entries(s.value||{}).filter(([,v])=>v).map(([n,v])=>{const keys=Object.keys(v.periods.day.saving_vs_usd);return '<p><b>'+esc(n)+'</b>: '+esc(v.verdict)+'</p>'+table(['period','calls','in tok','cached tok','out tok','subscription (prorated) USD'].concat(keys.map(k=>esc(k)+' USD')),Object.entries(v.periods).map(([p,x])=>[p,f(x.tokens.calls),f(x.tokens.in),f(x.tokens.cached),f(x.tokens.out),f(x.subscription_prorated_usd,2)].concat(keys.map(k=>{const a=x.saving_vs_usd[k]+x.subscription_prorated_usd;return f(a,2)}))))+'<p class="mut">projection over the last '+v.projection.span_days+' days scaled to 30 days: '+esc(Object.entries(v.projection.monthly_usd).map(([k,a])=>k+' '+f(a,2)).join(', '))+' USD against '+f(v.subscription_usd_per_month,2)+' USD</p>'}).join('')||'<span class="mut">no plan price configured</span>';
 const l=s.inferred_limits;
 $('lim').innerHTML='<p class="mut">'+esc(l.note)+'</p>'+table(['429 count','min calls prev s','min prev min','min prev h','max ok calls/s','max ok calls/min'],[[l.r429_count,l.min_calls_prev_second??'–',l.min_calls_prev_minute??'–',l.min_calls_prev_hour??'–',l.max_success_calls_per_second,l.max_success_calls_per_minute]]);
 const qt=s.quota;
 $('quota').innerHTML=qt.samples?table(['remaining now','used since first seen','samples','resets seen','window estimate (min)'],[[f(qt.remaining_now,2),f(qt.used_since_first,2),qt.samples,qt.resets.length,qt.window_estimate_ms?f(qt.window_estimate_ms/60000,1):'–']]):'<span class="mut">no x-quota-remaining header seen yet</span>';
 $('hdr').innerHTML=Object.keys(l.headers_seen).length?table(['header','last value','count'],Object.entries(l.headers_seen).map(([k,h])=>[esc(k),esc(h.last),h.count])):'<span class="mut">none seen yet</span>';
 $('tok').innerHTML=Object.keys(s.token_check).length?table(['model','samples','reported / estimated input'],Object.entries(s.token_check).map(([m,t])=>[esc(m),t.samples,t.reported_over_estimated_input])):'<span class="mut">no samples yet (estimate is chars/4; expect roughly 0.7 to 1.5)</span>';
 $('rec').innerHTML=table(['time','upstream','model','status','in','out','latency ms','ttft ms','attempt','error'],s.recent.map(r=>[esc(r.ts),esc(r.upstream),esc(r.model),'<span class="'+(r.status>=400?'bad':'')+'">'+r.status+'</span>',f(r.in_tokens),f(r.out_tokens),f(r.latency_ms),f(r.ttft_ms),r.attempt,esc((r.error||'').slice(0,80))]));
}
tick();setInterval(tick,10000);
</script></body></html>`;
