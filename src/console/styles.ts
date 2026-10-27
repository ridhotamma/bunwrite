/** Console stylesheet, kept as a string so the console has no build step. */
export const CONSOLE_CSS = `
:root{--bg:#f1f1f1;--surface:#fff;--nav:#ebebeb;--nav-hover:#e3e3e3;--nav-on:#fafafa;--text:#303030;--subdued:#616161;--disabled:#b5b5b5;--border:#e3e3e3;--border-strong:#8a8a8a;--primary:#303030;--primary-hover:#1a1a1a;--critical:#8e1f0b;--critical-bg:#fedad9;--success:#0c5132;--success-bg:#cdfee1;--attention:#7a3a00;--attention-bg:#ffe7d1;--info:#00527c;--info-bg:#e0f0ff;--focus:#005bd3;--shadow:0 1px 0 rgba(26,26,26,.07),inset 0 -1px 0 rgba(0,0,0,.08),inset 0 0 0 1px rgba(0,0,0,.06)}
*{box-sizing:border-box}html,body{margin:0}[hidden]{display:none!important}
body{font:13px/20px "Inter",-apple-system,BlinkMacSystemFont,"San Francisco","Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--focus);text-decoration:none}a:hover{text-decoration:underline}
.icon{display:inline-block;vertical-align:-.15em;flex:none}
code,.mono,pre,textarea.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.frame{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.nav{background:var(--nav);padding:12px 8px;position:sticky;top:0;height:100vh;overflow:auto;display:flex;flex-direction:column}
.nav .brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:15px;padding:6px 12px 14px}
.nav .brand-text{flex:1}
.nav-toggle{all:unset;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;cursor:pointer;color:var(--text);opacity:.6}
.nav-toggle:hover{background:var(--nav-hover);opacity:1}
.nav-toggle span{display:flex}
.nav-toggle .nav-expand-icon{display:none}
.nav a{display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:8px;color:var(--text);font-weight:550;margin-bottom:2px}
.nav a:hover{background:var(--nav-hover);text-decoration:none}.nav a.on{background:var(--nav-on);box-shadow:var(--shadow)}
.nav .group{margin-top:14px;padding:0 12px 4px;color:var(--subdued);font-size:12px;font-weight:550}
.nav .foot{margin-top:auto;padding:12px;color:var(--subdued);font-size:12px;border-top:1px solid var(--border)}
.nav .foot button{all:unset;display:inline-flex;align-items:center;gap:6px;color:var(--focus);cursor:pointer}
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
.split-sidebar{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:16px}
#export-panel{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto}
@media(max-width:960px){.split-sidebar{grid-template-columns:1fr}#export-panel{position:static;max-height:none;overflow:visible}}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.stat{background:var(--surface);border-radius:12px;box-shadow:var(--shadow);padding:12px 16px}
.chart{position:relative}
.chart svg{display:block;width:100%;height:auto}
.chart-legend{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:8px;color:var(--subdued);font-size:12px}
.chart-key{display:inline-flex;align-items:center;gap:6px}
.chart-dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.chart-tooltip{position:absolute;z-index:3;transform:translateX(-50%);pointer-events:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);padding:8px 10px;font-size:12px;min-width:150px}
.chart-tooltip[hidden]{display:none}
.chart-tooltip-time{font-weight:650;margin-bottom:4px}
.chart-tooltip-row{display:flex;justify-content:space-between;gap:16px;color:var(--subdued)}
.chart-tooltip-row b{color:var(--text);font-weight:550;font-variant-numeric:tabular-nums}
.chart-tooltip-label{display:inline-flex;align-items:center;gap:6px}
.chart-tooltip-dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.stat span{color:var(--subdued)}.stat b{display:block;font-size:20px;line-height:28px;font-weight:650}
table{width:100%;border-collapse:collapse}
th{background:#f7f7f7;color:var(--subdued);font-weight:550;font-size:12px;text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}tbody tr.row-link{cursor:pointer}tbody tr.row-link:hover{background:#f7f7f7}
td.clip{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}td.num{text-align:right;font-variant-numeric:tabular-nums}
.toolbar{display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);align-items:center}
.toolbar input{flex:1}
.tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px}
.tabs a{padding:6px 12px;border-radius:8px;color:var(--subdued);font-weight:550}
.tabs a:hover{background:#e3e3e3;text-decoration:none}.tabs a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
label{display:block;margin-bottom:12px;font-weight:450}
label>input,label>select,label>textarea{display:block;width:100%;margin-top:4px}
label small,.help{display:block;color:var(--subdued);font-size:12px;margin-top:4px}
input,select,textarea{font:inherit;color:var(--text);background:#fdfdfd;border:1px solid var(--border-strong);border-radius:8px;padding:6px 12px;min-height:32px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--focus);outline-offset:1px}
select:not([multiple]){appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' stroke='%23616161' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;background-size:12px 8px;padding-right:34px;cursor:pointer}
select:not([multiple]):disabled{color:var(--disabled);cursor:not-allowed;opacity:.65}
.toolbar select{flex:0 0 auto;min-width:150px}
textarea{min-height:80px;resize:vertical}textarea.tall{min-height:300px}
label.check{display:flex;gap:8px;align-items:center}label.check input{width:16px;min-height:16px;margin:0}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0 12px}
button,.btn{font:inherit;font-weight:550;border:0;border-radius:8px;padding:6px 12px;min-height:28px;cursor:pointer;background:var(--surface);color:var(--text);box-shadow:var(--shadow);display:inline-flex;align-items:center;gap:6px;white-space:nowrap;text-decoration:none}
button:hover,.btn:hover{background:#f7f7f7;text-decoration:none}
button.primary,.btn.primary{background:var(--primary);color:#fff;box-shadow:0 -1px 0 1px rgba(0,0,0,.8) inset,0 0 0 1px #303030 inset,0 .5px 0 1.5px rgba(255,255,255,.25) inset}
button.primary:hover,.btn.primary:hover{background:var(--primary-hover)}
button.critical{color:var(--critical)}button.small,.btn.small{padding:2px 8px;min-height:24px;font-size:12px}button.plain{background:none;box-shadow:none;color:var(--focus);padding:0 4px;min-height:0}
button.critical.plain{color:var(--critical)}
button.destructive{background:var(--critical);color:#fff;box-shadow:0 -1px 0 1px rgba(0,0,0,.8) inset,0 0 0 1px var(--critical) inset}
button.destructive:hover{background:#721807}
dialog{border:0;border-radius:12px;padding:0;background:var(--surface);color:var(--text);box-shadow:0 24px 60px rgba(0,0,0,.25);max-width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;width:100%;transition:opacity .15s ease,transform .15s ease}
dialog[open]{animation:dialog-in .18s cubic-bezier(.2,.8,.2,1)}
dialog.dialog-closing{opacity:0;transform:translateY(6px) scale(.98);pointer-events:none}
dialog::backdrop{background:rgba(0,0,0,.45);transition:opacity .15s ease}
dialog.dialog-closing::backdrop{opacity:0}
@keyframes dialog-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
.dialog-body{padding:20px}
.dialog h2{font-size:16px;line-height:24px;font-weight:650;margin:0 0 8px}
.dialog-message{color:var(--subdued);margin:0 0 16px}
.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.dialog label{margin:0}
.badge{display:inline-flex;align-items:center;font-size:12px;font-weight:550;padding:0 8px;border-radius:8px;background:#e3e3e3;color:#616161;line-height:20px}
.badge.success{background:var(--success-bg);color:var(--success)}.badge.critical{background:var(--critical-bg);color:var(--critical)}
.badge.attention{background:var(--attention-bg);color:var(--attention)}.badge.info{background:var(--info-bg);color:var(--info)}
td .badge+.badge{margin-left:6px}
.banner{display:flex;align-items:flex-start;gap:12px;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-weight:450;background:var(--info-bg);color:var(--info);transition:opacity .18s ease,transform .18s ease}
.banner.success{background:var(--success-bg);color:var(--success)}
.banner.critical{background:var(--critical-bg);color:var(--critical)}
.banner.warning{background:var(--attention-bg);color:var(--attention)}
.banner.info{background:var(--info-bg);color:var(--info)}
.banner a{color:inherit;text-decoration:underline}
.banner-icon{display:flex;flex:0 0 auto;margin-top:1px}
.banner-content{flex:1;min-width:0}
.banner-close{all:unset;display:flex;flex:0 0 auto;align-items:center;justify-content:center;width:24px;height:24px;cursor:pointer;border-radius:4px;color:inherit;opacity:.7}
.banner-close:hover{opacity:1;background:rgba(0,0,0,.07)}
.banner-close:focus-visible{outline:2px solid var(--focus);outline-offset:1px;opacity:1}
.banner-out{opacity:0;transform:translateY(-4px)}
.empty{text-align:center;padding:40px 16px}.empty h3{font-size:14px;margin:0 0 4px;font-weight:650}.empty p{color:var(--subdued);margin:0 0 12px}
.subdued{color:var(--subdued)}.stack{display:flex;flex-direction:column;gap:4px}.inline{display:inline}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)}.list li>:last-child{min-width:0;overflow-wrap:anywhere;text-align:right}.list li:last-child{border:0}.list .clip{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
pre{background:#f7f7f7;border-radius:8px;padding:12px;overflow:auto;max-height:360px;margin:0;white-space:pre-wrap;word-break:break-word}
details>summary{cursor:pointer;font-weight:550;margin:4px 0 12px}
.pager{display:flex;gap:8px;justify-content:center;align-items:center;padding:10px;border-top:1px solid var(--border)}
.auth{max-width:432px;margin:14vh auto 0;padding:0 16px}.auth .brand{display:flex;gap:8px;align-items:center;justify-content:center;font-weight:650;font-size:16px;margin-bottom:16px}
.htmx-request{opacity:.6;transition:opacity .2s}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;background:#1a1a1a;color:#fff;padding:10px 16px;border-radius:12px;font-weight:550;z-index:50;box-shadow:0 8px 20px rgba(0,0,0,.2);animation:toast 4s forwards}
.nav-tooltip{position:fixed;z-index:100;background:#1a1a1a;color:#fff;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:550;pointer-events:none;box-shadow:0 8px 20px rgba(0,0,0,.2);white-space:nowrap}
.nav-tooltip[hidden]{display:none}
@keyframes toast{0%{opacity:0;transform:translate(-50%,8px)}8%,85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;visibility:hidden}}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.topbar{display:none}#nav-toggle{display:none}.scrim{display:none}
@media(min-width:769px){
  html.nav-collapsed .frame{grid-template-columns:72px minmax(0,1fr)}
  html.nav-collapsed .nav .brand{justify-content:center;padding:6px 0 14px}
  html.nav-collapsed .nav .brand-text{display:none}
  html.nav-collapsed .nav a{justify-content:center;padding:8px 0}
  html.nav-collapsed .nav a span{display:none}
  html.nav-collapsed .nav .group{display:none}
  html.nav-collapsed .nav .group+a{margin-top:10px}
  html.nav-collapsed .nav .foot{text-align:center;padding:12px 0}
  html.nav-collapsed .nav .foot br,html.nav-collapsed .nav .nav-admin{display:none}
  html.nav-collapsed .nav .foot button{justify-content:center}
  html.nav-collapsed .nav .foot button span{display:none}
  html.nav-collapsed .nav .nav-collapse-icon{display:none}
  html.nav-collapsed .nav .nav-expand-icon{display:flex}
}
.perm-presets{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.perm-table{border:1px solid var(--border);border-radius:8px;border-collapse:separate;border-spacing:0;overflow:hidden;margin-bottom:10px}
.perm-table th{background:#f7f7f7}.perm-table td{padding:8px 12px}
.perm-table .perm-col{width:72px;text-align:center}.perm-table .perm-col input{width:16px;min-height:16px;margin:0;cursor:pointer}
.perm-role{font-weight:550}.perm-sub{font-size:11px;line-height:16px}
.perm-empty{border:1px dashed var(--border-strong);border-radius:8px;padding:12px;margin:0 0 10px;text-align:center}
.perm-add{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}.perm-add select{flex:1 1 220px}.perm-add input{flex:1 1 160px;min-width:0}
.perm-add [hidden]{display:none}
.perm-error{color:var(--critical);font-size:12px;margin:0 0 8px}
.perm-summary .list li{padding:6px 0}.perm-summary{margin-bottom:4px}
.perm-text{margin-top:8px}.perm-text textarea{width:100%}
.choice{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-bottom:12px}
.choice label{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin:0;cursor:pointer}
.choice label:has(input:checked){border-color:var(--primary);box-shadow:0 0 0 1px var(--primary)}
.choice input{width:16px;min-height:16px;margin:2px 0 0}.choice b{display:block;font-weight:600}.choice span{color:var(--subdued);font-size:12px}
.docform-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}.docform-head h2{margin:0}
.seg{display:inline-flex;background:#ebebeb;border-radius:8px;padding:2px;gap:2px}
.seg button{box-shadow:none;background:none;min-height:24px;padding:2px 10px;font-size:12px;color:var(--subdued)}
.seg button.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.doc-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 16px}
.doc-label{display:flex;gap:8px;align-items:center}.doc-field textarea{min-height:64px}
.doc-json textarea{width:100%}
.doc-inline{display:flex;gap:8px;margin-top:4px}.doc-inline input{flex:1;margin:0}
.attr-order{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px;margin:4px 0 12px}
.attr-order label{display:flex;align-items:center;gap:8px;margin:0}.attr-order label input{width:16px;min-height:16px;margin:0}.attr-order select{margin-left:auto;min-height:26px;padding:2px 30px 2px 8px;font-size:12px}
@media(prefers-reduced-motion:reduce){dialog,.banner{animation:none!important;transition:none!important}}
@media(max-width:768px){
  .frame{grid-template-columns:1fr}
  .topbar{display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:20;background:var(--nav);padding:8px 12px;border-bottom:1px solid var(--border)}
  .topbar .brand{font-weight:650;display:flex;gap:8px;align-items:center}
  .topbar label{display:flex;align-items:center;justify-content:center;margin:0;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:18px;line-height:1}
  .nav-toggle{display:none}
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
