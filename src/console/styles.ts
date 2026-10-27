/** Console stylesheet, kept as a string so the console has no build step. */
export const CONSOLE_CSS = `
:root{--bg:#f1f1f1;--surface:#fff;--nav:#ebebeb;--nav-hover:#e3e3e3;--nav-on:#fafafa;--text:#303030;--subdued:#616161;--disabled:#b5b5b5;--border:#e3e3e3;--border-strong:#8a8a8a;--primary:#303030;--primary-hover:#1a1a1a;--critical:#8e1f0b;--critical-bg:#fedad9;--success:#0c5132;--success-bg:#cdfee1;--attention:#5e4200;--attention-bg:#ffeb78;--info:#00527c;--info-bg:#e0f0ff;--focus:#005bd3;--shadow:0 1px 0 rgba(26,26,26,.07),inset 0 -1px 0 rgba(0,0,0,.08),inset 0 0 0 1px rgba(0,0,0,.06)}
*{box-sizing:border-box}html,body{margin:0}
body{font:13px/20px "Inter",-apple-system,BlinkMacSystemFont,"San Francisco","Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--focus);text-decoration:none}a:hover{text-decoration:underline}
code,.mono,pre,textarea.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.frame{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.nav{background:var(--nav);padding:12px 8px;position:sticky;top:0;height:100vh;overflow:auto;display:flex;flex-direction:column}
.nav .brand{font-weight:650;font-size:15px;padding:6px 12px 14px}
.nav a{display:block;padding:6px 12px;border-radius:8px;color:var(--text);font-weight:550;margin-bottom:2px}
.nav a:hover{background:var(--nav-hover);text-decoration:none}.nav a.on{background:var(--nav-on);box-shadow:var(--shadow)}
.nav .group{margin-top:14px;padding:0 12px 4px;color:var(--subdued);font-size:12px;font-weight:550}
.nav .foot{margin-top:auto;padding:12px;color:var(--subdued);font-size:12px;border-top:1px solid var(--border)}
.nav .foot button{all:unset;color:var(--focus);cursor:pointer}
main{padding:20px 32px 48px;max-width:1100px;width:100%;margin:0 auto}
.header{display:flex;align-items:center;gap:12px;margin-bottom:16px;min-height:32px}
.header h1{font-size:20px;line-height:28px;font-weight:650;margin:0}
.header .back{display:inline-flex;width:28px;height:28px;border-radius:8px;align-items:center;justify-content:center;color:var(--text);font-size:16px}
.header .back:hover{background:#e3e3e3;text-decoration:none}
.header .meta{display:flex;gap:6px;align-items:center}.header .actions{margin-left:auto;display:flex;gap:8px}
.card{background:var(--surface);border-radius:12px;box-shadow:var(--shadow);padding:16px;margin-bottom:16px}
.card.flush{padding:0;overflow:hidden}.card h2{font-size:14px;font-weight:650;margin:0 0 12px}
.card .hint{color:var(--subdued);margin:-8px 0 12px}
.card .foot{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:16px}@media(max-width:960px){.layout{grid-template-columns:1fr}}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.stat{background:var(--surface);border-radius:12px;box-shadow:var(--shadow);padding:12px 16px}
.stat span{color:var(--subdued)}.stat b{display:block;font-size:20px;line-height:28px;font-weight:650}
table{width:100%;border-collapse:collapse}
th{background:#f7f7f7;color:var(--subdued);font-weight:550;font-size:12px;text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}tbody tr.row-link{cursor:pointer}tbody tr.row-link:hover{background:#f7f7f7}
td.clip{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}td.num{text-align:right;font-variant-numeric:tabular-nums}
.toolbar{display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);align-items:center}
.toolbar input{flex:1}
.tabs{display:flex;gap:4px;margin-bottom:16px}
.tabs a{padding:6px 12px;border-radius:8px;color:var(--subdued);font-weight:550}
.tabs a:hover{background:#e3e3e3;text-decoration:none}.tabs a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
label{display:block;margin-bottom:12px;font-weight:450}
label>input,label>select,label>textarea{display:block;width:100%;margin-top:4px}
label small,.help{display:block;color:var(--subdued);font-size:12px;margin-top:4px}
input,select,textarea{font:inherit;color:var(--text);background:#fdfdfd;border:1px solid var(--border-strong);border-radius:8px;padding:6px 12px;min-height:32px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--focus);outline-offset:1px}
textarea{min-height:80px;resize:vertical}textarea.tall{min-height:300px}
label.check{display:flex;gap:8px;align-items:center}label.check input{width:16px;min-height:16px;margin:0}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0 12px}
button,.btn{font:inherit;font-weight:550;border:0;border-radius:8px;padding:6px 12px;min-height:28px;cursor:pointer;background:var(--surface);color:var(--text);box-shadow:var(--shadow);display:inline-flex;align-items:center;gap:6px;white-space:nowrap;text-decoration:none}
button:hover,.btn:hover{background:#f7f7f7;text-decoration:none}
button.primary,.btn.primary{background:var(--primary);color:#fff;box-shadow:0 -1px 0 1px rgba(0,0,0,.8) inset,0 0 0 1px #303030 inset,0 .5px 0 1.5px rgba(255,255,255,.25) inset}
button.primary:hover,.btn.primary:hover{background:var(--primary-hover)}
button.critical{color:var(--critical)}button.small,.btn.small{padding:2px 8px;min-height:24px;font-size:12px}button.plain{background:none;box-shadow:none;color:var(--focus);padding:0 4px;min-height:0}
button.critical.plain{color:var(--critical)}
.badge{display:inline-flex;align-items:center;font-size:12px;font-weight:550;padding:0 8px;border-radius:8px;background:#e3e3e3;color:#616161;line-height:20px}
.badge.success{background:var(--success-bg);color:var(--success)}.badge.critical{background:var(--critical-bg);color:var(--critical)}
.badge.attention{background:var(--attention-bg);color:var(--attention)}.badge.info{background:var(--info-bg);color:var(--info)}
.banner{border-radius:12px;padding:12px 16px;margin-bottom:16px;box-shadow:var(--shadow);background:var(--surface);border-left:4px solid var(--info)}
.banner.success{border-color:#29845a}.banner.critical{border-color:#e51c00;background:#fff5f5}.banner.warning{border-color:#ffb800}
.empty{text-align:center;padding:40px 16px}.empty h3{font-size:14px;margin:0 0 4px;font-weight:650}.empty p{color:var(--subdued);margin:0 0 12px}
.subdued{color:var(--subdued)}.stack{display:flex;flex-direction:column;gap:4px}.inline{display:inline}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)}.list li>:last-child{min-width:0;overflow-wrap:anywhere;text-align:right}.list li:last-child{border:0}
pre{background:#f7f7f7;border-radius:8px;padding:12px;overflow:auto;max-height:360px;margin:0;white-space:pre-wrap;word-break:break-word}
details>summary{cursor:pointer;font-weight:550;margin:4px 0 12px}
.pager{display:flex;gap:8px;justify-content:center;align-items:center;padding:10px;border-top:1px solid var(--border)}
.auth{max-width:432px;margin:14vh auto 0;padding:0 16px}.auth .brand{display:flex;gap:8px;align-items:center;justify-content:center;font-weight:650;font-size:16px;margin-bottom:16px}
.htmx-request{opacity:.6;transition:opacity .2s}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:10px 16px;border-radius:12px;font-weight:550;z-index:50;box-shadow:0 8px 20px rgba(0,0,0,.2);animation:toast 4s forwards}
@keyframes toast{0%{opacity:0;transform:translate(-50%,8px)}8%,85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;visibility:hidden}}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.topbar{display:none}#nav-toggle{display:none}.scrim{display:none}
@media(max-width:768px){
  .frame{grid-template-columns:1fr}
  .topbar{display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:20;background:var(--nav);padding:8px 12px;border-bottom:1px solid var(--border)}
  .topbar .brand{font-weight:650;display:flex;gap:8px;align-items:center}
  .topbar label{margin:0;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:18px;line-height:1}
  .nav{position:fixed;inset:0 auto 0 0;width:260px;z-index:30;transform:translateX(-100%);transition:transform .2s}
  #nav-toggle:checked~.frame .nav{transform:none}
  #nav-toggle:checked~.scrim{display:block;position:fixed;inset:0;z-index:25;background:rgba(0,0,0,.35)}
  main{padding:16px 12px 40px}
  .header{flex-wrap:wrap}.header .actions{margin-left:0;width:100%;flex-wrap:wrap}
  .hide-sm{display:none}
  td,th{padding:8px}
  .toolbar{flex-wrap:wrap}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
}
`
