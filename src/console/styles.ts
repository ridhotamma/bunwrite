import { PROGRESS_CSS } from './progress'

const FONT_FACES = (
  [
    ['Light', 300],
    ['Regular', 400],
    ['Medium', 500],
    ['Bold', 700],
  ] as const
)
  .map(([file, weight]) => `@font-face{font-family:"Neue Montreal";src:url("/fonts/NeueMontreal-${file}.otf") format("opentype");font-weight:${weight};font-style:normal;font-display:swap}`)
  .join('\n')

/**
 * Console stylesheet, kept as a string so the console has no build step.
 * Order: tokens, base, app frame, page structure, shared components, feature
 * components, forms, small screens. Colours come from the tokens only.
 */
export const CONSOLE_CSS = `
${FONT_FACES}

/* Tokens */
:root{
  --bg:#f7f7f8;--surface:#fff;--surface-2:#fafafa;--hover:#f2f2f3;--active:#ececee;
  --text:#1c1c1e;--subdued:#6b6b70;--disabled:#b4b4b8;
  --border:#e6e6e9;--border-strong:#d2d2d6;
  --primary:#1c1c1e;--primary-hover:#000;
  --critical:#b42318;--critical-bg:#fdecea;--success:#1f7a45;--success-bg:#e5f4eb;
  --attention:#8a4b00;--attention-bg:#fdf0dc;--info:#1d5c96;--info-bg:#e6f0fa;
  --focus:#1d5c96;--ring:0 0 0 3px rgba(29,92,150,.18);
  --radius:10px;--radius-lg:14px;
  --shadow-sm:0 1px 2px rgba(16,16,20,.04);
  --shadow:var(--shadow-sm),inset 0 0 0 1px var(--border);
  --shadow-lg:0 16px 40px rgba(16,16,20,.16),0 2px 8px rgba(16,16,20,.06);
  --nav-w:236px;
  /* Older names some inline styles still use. */
  --nav:var(--bg);--nav-hover:var(--hover);--nav-on:var(--surface-2);
}

/* Base */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
[hidden]{display:none!important}
body{font:14px/1.5 "Neue Montreal",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--focus);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3{font-weight:500;letter-spacing:-.01em}
code,.mono,pre,textarea.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;letter-spacing:0}
.icon{display:inline-block;flex:none;vertical-align:-.15em}
.subdued{color:var(--subdued)}
.inline{display:inline}
.stack{display:flex;flex-direction:column;gap:4px}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.htmx-request{opacity:.6;transition:opacity .2s}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}

/* App frame: sidebar + centred page. The frame draws the sidebar's edge so it runs the full page height. */
.frame{display:grid;grid-template-columns:var(--nav-w) minmax(0,1fr);min-height:100vh;background:linear-gradient(to right,transparent calc(var(--nav-w) - 1px),var(--border) calc(var(--nav-w) - 1px),var(--border) var(--nav-w),transparent var(--nav-w))}
.nav{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:2px;padding:0 10px;overflow:auto}
/* Keep items at full size; a short window scrolls the sidebar instead of squeezing it. */
.nav>*{flex-shrink:0}
/* Sidebar scrollbar: thin and rounded, hidden until the sidebar is hovered or focused. The gutter is reserved so links never shift. */
.nav{overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:transparent transparent}
.nav:hover,.nav:focus-within{scrollbar-color:var(--border-strong) transparent}
.nav::-webkit-scrollbar{width:6px}
.nav::-webkit-scrollbar-track{background:transparent}
.nav::-webkit-scrollbar-thumb{border-radius:6px;background:transparent}
.nav:hover::-webkit-scrollbar-thumb,.nav:focus-within::-webkit-scrollbar-thumb{background:var(--border-strong)}
.nav::-webkit-scrollbar-thumb:hover{background:var(--subdued)}
/* The switcher and the account row stay pinned; only the links between them scroll. */
.nav-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:4px;padding:12px 0 10px;margin-bottom:6px;border-bottom:1px solid var(--border);background:var(--bg)}
.nav>a{display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border-radius:8px;color:var(--subdued);font-weight:500}
.nav>a:hover{background:var(--hover);color:var(--text);text-decoration:none}
.nav>a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.nav .group{padding:14px 10px 4px;color:var(--subdued);font-size:11.5px;letter-spacing:.02em}
.nav .foot{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:8px;margin-top:auto;padding:12px 4px;border-top:1px solid var(--border);background:var(--bg)}
.nav .foot .nav-admin{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--subdued);font-size:13px}
.nav-toggle{all:unset;display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:8px;color:var(--subdued);cursor:pointer}
.nav-toggle:hover{background:var(--hover);color:var(--text)}
.nav-toggle:focus-visible{outline:2px solid var(--focus)}
.nav-toggle span{display:flex}.nav-toggle .nav-expand-icon{display:none}
.nav-tooltip{position:fixed;z-index:100;padding:5px 9px;border-radius:7px;background:var(--text);color:#fff;font-size:12px;font-weight:500;white-space:nowrap;pointer-events:none}
.topbar,#nav-toggle,.scrim{display:none}
.frame>main{min-width:0;width:100%;max-width:1144px;margin:0 auto;padding:28px 32px 72px}
@media(min-width:769px){
  html.nav-collapsed{--nav-w:68px}
  html.nav-collapsed .nav-head{flex-direction:column;gap:6px}
  html.nav-collapsed .switcher{flex:none}
  html.nav-collapsed .switcher-btn{padding:6px}
  html.nav-collapsed .switcher-text,html.nav-collapsed .switcher-caret,html.nav-collapsed .nav>a span,html.nav-collapsed .nav .group,html.nav-collapsed .nav .nav-admin,html.nav-collapsed .nav .nav-collapse-icon{display:none}
  html.nav-collapsed .nav>a{justify-content:center;padding:0}
  html.nav-collapsed .nav .group+a{margin-top:12px}
  html.nav-collapsed .nav .foot{flex-direction:column;padding:12px 0}
  html.nav-collapsed .nav .nav-expand-icon{display:flex}
}

/* Project switcher */
.switcher{flex:1;min-width:0}
.switcher.menu-root{position:static}
.switcher-btn{list-style:none;display:flex;align-items:center;gap:10px;min-width:0;padding:6px;border-radius:var(--radius);cursor:pointer}
.switcher-btn::-webkit-details-marker{display:none}
.switcher-btn:hover,.switcher[open] .switcher-btn{background:var(--hover)}
.switcher-text{display:flex;flex-direction:column;flex:1;min-width:0;line-height:1.25}
.switcher-text b,.switcher-org{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.switcher-text b{font-weight:500;font-size:14px}
.switcher-org{color:var(--subdued);font-size:12px}
.switcher-caret{color:var(--subdued)}
.switcher .menu{left:0;right:0;width:auto;min-width:0}.switcher .menu.menu-fixed{right:auto;width:260px}

/* Organization shell: top bar, organization heading, project grid */
.select-topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;height:56px;padding:0 max(24px,calc((100% - 1080px)/2 + 24px));border-bottom:1px solid var(--border);background:rgba(255,255,255,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.select-brand{display:flex;align-items:center;gap:8px;color:var(--text);font-size:15px;font-weight:500}.select-brand:hover{text-decoration:none}.select-brand img{width:24px;height:24px}
.select-user{display:flex;align-items:center;margin-left:auto}
.account-btn{list-style:none;display:flex;border-radius:50%;cursor:pointer}.account-btn::-webkit-details-marker{display:none}
.account-btn:hover .avatar,.menu-root[open] .account-btn .avatar{box-shadow:0 0 0 3px var(--active)}
.select-main{width:100%;max-width:1080px;margin:0 auto;padding:32px 24px 72px}
.org-head{display:flex;align-items:center;gap:14px;min-width:0;margin-bottom:24px}
.org-head-actions{display:flex;flex-wrap:wrap;gap:8px;margin-left:auto}
.org-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border-radius:12px;background:var(--primary);color:#fff;font-size:18px;font-weight:500}
.org-title{min-width:0}.org-title h1{margin:0;font-size:22px;line-height:30px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.org-title p{margin:2px 0 0;color:var(--subdued);font-size:13.5px}
.page-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.page-toolbar-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.search-field{position:relative;display:flex;flex:1 1 280px;max-width:360px;min-width:0;margin:0}
.search-field-icon{position:absolute;left:11px;top:50%;display:flex;color:var(--subdued);transform:translateY(-50%);pointer-events:none}
.search-field input{flex:1 1 auto;width:100%;min-width:0;margin:0;padding-left:34px}
.seg-links{display:inline-flex;flex:none;gap:2px;padding:3px;border-radius:10px;background:var(--active)}
.seg-links a{display:flex;align-items:center;justify-content:center;width:32px;height:28px;border-radius:7px;color:var(--subdued)}
.seg-links a:hover{color:var(--text);text-decoration:none}
.seg-links a.on{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.project-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.project-card{position:relative;display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow);transition:box-shadow .15s}
.project-card:hover{box-shadow:0 6px 18px rgba(16,16,20,.07),inset 0 0 0 1px var(--border-strong)}
.project-card-link{position:absolute;inset:0;z-index:1;border-radius:var(--radius-lg)}
.project-card-head{display:flex;align-items:center;gap:12px;min-width:0}
.project-card-head .menu-root{position:relative;z-index:2;align-self:flex-start;margin:-4px -6px 0 auto}
.project-card-name{display:flex;flex-direction:column;min-width:0}
.project-card-name h3{margin:0;font-size:14.5px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-card-name .mono{font-size:11.5px;line-height:16px;color:var(--subdued);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-card-badges{display:flex;gap:4px;min-height:22px}.project-card-badges:empty{display:none}
.project-card-stats{display:flex;align-items:flex-end;gap:16px;margin-top:auto;padding-top:12px;border-top:1px solid var(--border)}
.project-card-requests{display:flex;flex-direction:column;flex:none;color:var(--subdued);font-size:12px;line-height:16px}
.project-card-requests b{color:var(--text);font-size:18px;line-height:24px;font-weight:500;font-variant-numeric:tabular-nums}
.project-spark-wrap{display:flex;flex-direction:column;align-items:flex-end;flex:1;min-width:0;gap:2px;color:var(--info);font-size:11px;line-height:14px}
.project-spark{display:block;width:100%;height:28px}.project-spark.idle{color:var(--border-strong)}
.project-row{display:inline-flex;align-items:center;gap:10px;margin-right:6px;color:inherit;vertical-align:middle}.project-row:hover{text-decoration:none}.project-row:hover b{text-decoration:underline}
.project-row>span{display:flex;flex-direction:column;line-height:18px}.project-row b{font-weight:500}.project-row .mono{font-size:11.5px;color:var(--subdued)}

/* Page header */
.header{display:flex;align-items:flex-start;gap:12px;min-height:32px;margin-bottom:24px}
.header .back{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)}
.header .back:hover{background:var(--hover);text-decoration:none}
.header-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.header-title{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0}
.header h1{max-width:100%;margin:0;font-size:22px;line-height:30px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header h1.mono{font-size:19px}
.header-sub{margin:0;color:var(--subdued);font-size:13.5px}
.header .meta{display:flex;flex:none;align-items:center;gap:6px}
.header .actions{display:flex;flex:none;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin-left:auto}
.header .actions form{margin:0}
.header .actions .icon-btn{width:34px;height:34px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
.header .actions .icon-btn:hover,.header .actions .menu-root[open]>.icon-btn{background:var(--hover)}
.id-copy{display:inline-flex;align-items:center;gap:2px;max-width:100%;vertical-align:middle}.id-copy .mono{overflow:hidden;text-overflow:ellipsis}
.icon-btn.id-copy-btn{width:auto;min-width:24px;height:24px;padding:0 4px;gap:4px;border-radius:6px;font-size:12px}
.id-copy-btn [data-copy-label]:empty{display:none}
.page-note{margin:-12px 0 20px;color:var(--subdued);font-size:13px}.page-note b{color:var(--text);font-weight:500}

/* Tabs */
.tabs{display:flex;gap:2px;margin:-8px 0 20px;border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs a{position:relative;flex:none;padding:9px 12px;color:var(--subdued);font-weight:500;white-space:nowrap}
.tabs a:hover{color:var(--text);text-decoration:none}
.tabs a.on{color:var(--text)}
.tabs a.on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--text)}

/* Layout */
.layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:20px;align-items:start}
.layout>div{display:flex;flex-direction:column;min-width:0}
.split-sidebar{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:20px;align-items:start}
.settings-layout{display:grid;grid-template-columns:200px minmax(0,1fr);gap:32px;align-items:start}
.settings-nav{position:sticky;top:24px;display:flex;flex-direction:column;gap:18px}
.settings-nav-group{display:flex;flex-direction:column;gap:2px}
.settings-nav-label{padding:0 10px 4px;color:var(--subdued);font-size:11.5px;letter-spacing:.02em}
.settings-nav a{display:block;padding:6px 10px;border-radius:8px;color:var(--subdued);font-weight:500}
.settings-nav a:hover{background:var(--hover);color:var(--text);text-decoration:none}
.settings-nav a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.settings-content{min-width:0}
.settings-section{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:12px 32px;padding:24px 0;border-top:1px solid var(--border)}
.settings-section:first-child,.header+.settings-section,.tabs+.settings-section,.page-note+.settings-section{padding-top:0;border-top:0}
.settings-section .card{min-width:0;margin:0;overflow:hidden}
.settings-section>.card:has(>form[data-confirm-tone="critical"]:last-child:not(.stack-fields)){display:flex;flex-direction:column;align-items:flex-start;justify-content:center}
.settings-section>.card:has(>form[data-confirm-tone="critical"]:last-child:not(.stack-fields))>.hint{margin:0 0 10px}
.settings-heading{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.settings-aside h2{margin:0 0 4px;font-size:15px;line-height:22px}.settings-aside p{margin:0;font-size:13px}
.settings-badge{display:inline-flex}.settings-badge .badge+.badge{margin-left:4px}
.section-head{display:flex;align-items:baseline;gap:8px;margin:28px 0 12px}.section-head h2{margin:0;font-size:15px;line-height:22px}

/* Cards */
.card{min-width:0;margin-bottom:20px;padding:18px;border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow)}
.card.flush{padding:0;overflow:hidden}
.card.narrow{max-width:560px}
.card h2{margin:0 0 14px;font-size:15px;line-height:22px}
.card-head{display:flex;align-items:center;gap:8px;min-height:28px;margin-bottom:14px}
.card-head h2{margin:0}
.card-head-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.card.flush>.card-head{margin:0;padding:12px 18px;border-bottom:1px solid var(--border)}
.card .hint{margin:-8px 0 16px;color:var(--subdued);font-size:13px}
.card .foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;margin-top:4px}
.card .foot form{display:flex;align-items:center}
.card form>textarea{width:100%}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.page-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}

/* Stats: one surface split into cells; the last row stretches so no cell is left empty */
.stats{display:flex;flex-wrap:wrap;margin-bottom:20px;overflow:hidden;border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow)}
.stat{display:flex;flex:1 1 100px;flex-direction:column;gap:2px;min-width:0;padding:14px 18px;color:var(--text);box-shadow:-1px -1px 0 var(--border)}
a.stat:hover{background:var(--surface-2);text-decoration:none}
.stat>span:first-child,.stat-label{color:var(--subdued);font-size:12.5px}
.stat>b,.stat-value{display:block;font-size:24px;line-height:32px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stat-value.sm{font-size:15px;letter-spacing:0}
.stat-sub{color:var(--subdued);font-size:12px}

/* Key/value list */
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:9px 0;border-bottom:1px solid var(--border);font-size:13.5px}
.list li:first-child{padding-top:0}.list li:last-child{padding-bottom:0;border:0}
.list li>:last-child{min-width:0;text-align:right;overflow-wrap:anywhere}
.list .clip{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* A truncated label on the left gives way; the value on the right keeps one line. */
.list li>.clip:first-child{flex:1 1 auto}.list li>.clip:first-child~:last-child{flex:none;white-space:nowrap}
.list li.var-row{flex-wrap:wrap;align-items:center}
.card.flush>.list li{padding:12px 18px}

/* Tables */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{padding:9px 14px;border-bottom:1px solid var(--border);background:var(--surface-2);color:var(--subdued);font-size:12px;font-weight:500;text-align:left;white-space:nowrap}
td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
th:first-child,td:first-child{padding-left:18px}th:last-child,td:last-child{padding-right:18px}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--surface-2)}
tbody tr.row-link{cursor:pointer}
td.clip{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}td.nowrap{white-space:nowrap}
td .badge+.badge{margin-left:6px}
.cell-sub{color:var(--subdued);font-size:12px;line-height:16px}
.row-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px}
th.select-col,td.select-col{width:40px;padding-right:0;text-align:left}
.select-col input[type=checkbox]{cursor:pointer}.select-col input[type=checkbox]:disabled{cursor:not-allowed;opacity:.35}
th.role-col,td.role-col{width:160px}th.date-col{width:140px}th.actions-col{width:56px}
.record-table td{padding:9px 14px}
.domain-table td{padding:8px 14px}.domain-table td.actions-col{text-align:right;white-space:nowrap}
.domain-head{display:flex;align-items:center;gap:8px;margin:0 0 10px}.domain-head .subdued{margin:0;font-size:12.5px}.domain-head .btn{margin-left:auto}
.toolbar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border)}
.toolbar input{flex:1;margin:0}.toolbar select{flex:0 0 auto;min-width:150px}
.bulk-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.bulk-actions .subdued{font-size:12.5px;white-space:nowrap}
.pager{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;border-top:1px solid var(--border)}

/* Empty state */
.empty{display:flex;flex-direction:column;align-items:center;padding:44px 20px;text-align:center}
.empty-icon{display:flex;align-items:center;justify-content:center;width:40px;height:40px;margin-bottom:12px;border-radius:12px;background:var(--hover);color:var(--subdued)}
.empty h3{margin:0 0 4px;font-size:14.5px}
.empty p{max-width:380px;margin:0 0 16px;color:var(--subdued);font-size:13px}
.empty p:last-child{margin-bottom:0}

/* Buttons */
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-size:13.5px;font-weight:500;white-space:nowrap;text-decoration:none;cursor:pointer;box-shadow:var(--shadow-sm);transition:background .12s,border-color .12s}
button:hover,.btn:hover{background:var(--hover);text-decoration:none}
button:disabled{opacity:.5;cursor:not-allowed}
button.primary,.btn.primary{border-color:var(--primary);background:var(--primary);color:#fff}
button.primary:hover,.btn.primary:hover{background:var(--primary-hover)}
button.critical,.btn.critical{color:var(--critical)}
button.critical:hover{border-color:color-mix(in srgb,var(--critical) 30%,var(--border-strong));background:var(--critical-bg)}
button.destructive{border-color:var(--critical);background:var(--critical);color:#fff}
button.destructive:hover{background:#8f1c13}
button.small,.btn.small{min-height:28px;padding:0 10px;font-size:12.5px}
button.plain{min-height:0;padding:0 2px;border:0;background:none;box-shadow:none;color:var(--focus)}
button.plain:hover{background:none;text-decoration:underline}
button.critical.plain{color:var(--critical)}
button[aria-busy]{cursor:progress;opacity:.8}
.icon-btn{all:unset;box-sizing:border-box;list-style:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;color:var(--subdued);cursor:pointer}
.icon-btn::-webkit-details-marker{display:none}
.icon-btn:hover,.menu-root[open]>.icon-btn{background:var(--hover);color:var(--text)}
.icon-btn:focus-visible{outline:2px solid var(--focus)}

/* Badges, tiles, avatars, chips */
.badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;background:var(--active);color:var(--subdued);font-size:12px;font-weight:500;white-space:nowrap}
.badge.success{background:var(--success-bg);color:var(--success)}
.badge.critical{background:var(--critical-bg);color:var(--critical)}
.badge.attention{background:var(--attention-bg);color:var(--attention)}
.badge.info{background:var(--info-bg);color:var(--info)}
.tile{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:9px;background:var(--active);color:var(--text);font-size:13px;font-weight:500;line-height:1}
.tile.sm{width:22px;height:22px;border-radius:6px;font-size:11px}.tile.lg{width:40px;height:40px;border-radius:12px;font-size:16px}
.tile.blue{background:#e3effb;color:#1d5c96}.tile.green{background:#e0f4e8;color:#1f6b40}.tile.orange{background:#fcefdf;color:#8a4b00}
.tile.purple{background:#efe9fb;color:#5b3a9c}.tile.pink{background:#fbe8f0;color:#8a2455}.tile.teal{background:#dff3f0;color:#0f5a52}
.avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:50%;background:var(--active);color:var(--text);font-size:11px;font-weight:500;line-height:1}
.avatar.md{width:32px;height:32px;font-size:12px}
.avatar.lg{width:48px;height:48px;font-size:16px}
.avatar.xl{width:80px;height:80px;font-size:26px;font-weight:500}
.avatar.has-photo{overflow:hidden;background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--border)}
.avatar img{display:block;width:100%;height:100%;object-fit:cover}
.nav-profile{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:4px;margin:-4px;border-radius:8px;color:inherit;text-decoration:none}
.nav-profile:hover{background:var(--nav-hover);text-decoration:none}
.nav-profile:hover .nav-admin{color:var(--text)}
.menu-account{display:flex;align-items:center;gap:10px;padding:8px}
.menu-account>span:last-child{min-width:0}.menu-account .subdued{display:block;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Profile */
.profile-head{display:flex;align-items:flex-start;gap:20px;margin:4px 0 28px}
.profile-title{min-width:0;padding-top:4px}.profile-title h1{margin:0;font-size:22px;line-height:30px;overflow-wrap:anywhere}.profile-title>p{margin:0;overflow-wrap:anywhere}
.profile-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;font-size:13px}
.profile-photo{flex:none}
.profile-avatar{all:unset;position:relative;display:flex;width:fit-content;border-radius:50%;cursor:pointer;list-style:none}
.profile-avatar::-webkit-details-marker{display:none}
.profile-avatar-edit{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(16,16,20,.45);color:#fff;opacity:0;transition:opacity .15s}
.profile-avatar:hover .profile-avatar-edit,.profile-avatar-menu[open] .profile-avatar-edit,.uploading .profile-avatar-edit{opacity:1}
.profile-avatar:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.uploading .profile-avatar{pointer-events:none}.uploading .profile-avatar-edit .icon{animation:photo-pulse 1s ease-in-out infinite}
@keyframes photo-pulse{50%{opacity:.35;transform:translateY(-2px)}}
.profile-photo-noscript{display:flex;flex-direction:column;gap:6px;max-width:160px;margin-top:10px}
.photo-status{display:block;margin-top:8px;color:var(--critical);font-size:12.5px}
.password-box>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0;font-weight:400}
.password-box>summary::-webkit-details-marker{display:none}
.password-box[open]>summary{display:none}
.password-row{display:flex;align-items:center;gap:10px;color:var(--subdued)}.password-dots{letter-spacing:2px}
/* The page between the console and GitHub */
.handoff{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:32px 16px}
.handoff-card{width:100%;max-width:440px;padding:32px 28px 22px;text-align:center}
.handoff-card h1{margin:22px 0 6px;font-size:20px;line-height:28px}
.handoff-lead{margin:0 auto 22px;max-width:340px}
.handoff-logos{display:flex;align-items:center;justify-content:center;gap:14px}
.handoff-logo{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:16px;background:var(--surface);box-shadow:var(--shadow),0 4px 12px rgba(16,16,20,.06)}
.handoff-logo.github{background:#1f2328;color:#fff}
.handoff-track{display:flex;gap:6px}
.handoff-track i{width:6px;height:6px;border-radius:50%;background:var(--border-strong);animation:handoff 1.2s infinite ease-in-out}
.handoff-track i:nth-child(2){animation-delay:.15s}.handoff-track i:nth-child(3){animation-delay:.3s}
.handoff.paused .handoff-track i{animation:none}
@keyframes handoff{0%,70%,100%{background:var(--border-strong);transform:none}35%{background:var(--text);transform:translateY(-3px)}}
.handoff-steps{display:flex;flex-direction:column;gap:2px;margin:0 0 22px;padding:6px;list-style:none;border-radius:var(--radius);background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--border);text-align:left}
.handoff-steps li{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;color:var(--subdued);font-size:13.5px}
.handoff-steps li.current{background:var(--surface);color:var(--text);font-weight:500;box-shadow:var(--shadow)}
.handoff-steps li.done{color:var(--text)}
.handoff-dot{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:50%;background:var(--active);font-size:11px;font-weight:500}
.handoff-steps li.current .handoff-dot{background:var(--primary);color:#fff}
.handoff-steps li.done .handoff-dot{background:var(--success-bg);color:var(--success)}
.handoff-where{margin-left:auto;color:var(--subdued);font-size:12px;font-weight:400}
.handoff-go{width:100%;min-height:40px}
.handoff.leaving .handoff-go{opacity:.7;pointer-events:none}
.handoff-foot{display:flex;justify-content:space-between;gap:12px;margin:14px 0 0;font-size:13px}
@media (prefers-reduced-motion:reduce){.handoff-track i{animation:none}}
@media (max-width:640px){.profile-head{gap:14px}.profile-head .avatar.xl{width:64px;height:64px;font-size:22px}}
.chip{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:2px 10px;border-radius:8px;font-size:12.5px}

/* Banners and toast */
.banner{display:flex;align-items:flex-start;gap:10px;margin-bottom:20px;padding:12px 14px;border-radius:var(--radius);background:var(--info-bg);color:var(--info);font-size:13.5px;transition:opacity .18s,transform .18s}
.banner.success{background:var(--success-bg);color:var(--success)}
.banner.critical{background:var(--critical-bg);color:var(--critical)}
.banner.warning{background:var(--attention-bg);color:var(--attention)}
.banner.info{background:var(--info-bg);color:var(--info)}
.banner a{color:inherit;text-decoration:underline}
.banner-icon{display:flex;flex:none;margin-top:1px}
.banner-content{flex:1;min-width:0}
.banner-close{all:unset;display:flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;opacity:.7;cursor:pointer}
.banner-close:hover{opacity:1;background:rgba(0,0,0,.06)}
.banner-close:focus-visible{outline:2px solid currentColor;opacity:1}
.banner-out{opacity:0;transform:translateY(-4px)}
.toast{position:fixed;left:50%;bottom:24px;z-index:50;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:var(--text);color:#fff;font-weight:500;box-shadow:var(--shadow-lg);transform:translateX(-50%);animation:toast 4s forwards}
.toast .icon{color:#6fd39a}
@keyframes toast{0%{opacity:0;transform:translate(-50%,8px)}8%,85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;visibility:hidden}}

/* Menus */
.menu-root{position:relative;display:inline-block}.menu-root>summary{margin:0;font-weight:inherit}
.menu{position:absolute;top:calc(100% + 4px);right:0;z-index:60;min-width:190px;padding:6px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow-lg);text-align:left;font-weight:400}
.menu.menu-fixed{position:fixed;right:auto}
/* Menus stay hidden until the script has placed them, then scale in from the trigger; closing plays it back. */
.menu-root[open]>.menu:not([data-placed]){visibility:hidden}
.menu{--menu-dy:-4px;transform-origin:top right}.menu-root[data-align=start]>.menu{transform-origin:top left}
.menu[data-side=top]{--menu-dy:4px;transform-origin:bottom right}.menu-root[data-align=start]>.menu[data-side=top]{transform-origin:bottom left}
.menu[data-placed]{animation:menu-in .14s cubic-bezier(.2,.8,.2,1)}
.menu[data-closing]{animation:menu-out .1s ease-in forwards;pointer-events:none}
@keyframes menu-in{from{opacity:0;transform:translateY(var(--menu-dy)) scale(.97)}}
@keyframes menu-out{to{opacity:0;transform:translateY(var(--menu-dy)) scale(.97)}}
.menu hr{margin:6px -6px;border:0;border-top:1px solid var(--border)}
.menu form{display:block;margin:0}
.menu-item,.menu form button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:32px;padding:6px 8px;border-radius:6px;color:var(--text);white-space:nowrap;cursor:pointer}
.menu-item:hover,.menu form button:hover,.menu-item:focus-visible,.menu form button:focus-visible{background:var(--hover);text-decoration:none}
.menu form button.critical{color:var(--critical)}.menu form button.critical:hover{background:var(--critical-bg)}
.menu-item .icon{color:var(--subdued)}
.menu-item-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.menu-item[aria-current]{font-weight:500}.menu-check{color:var(--text)!important}
.menu-label{padding:4px 8px 6px;color:var(--subdued);font-size:12px}
.menu-scroll{max-height:240px;overflow:auto}
.menu-head{padding:6px 8px;color:var(--subdued);font-size:12px;line-height:18px}.menu-head b{display:block;max-width:240px;color:var(--text);font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis}

/* Dialog */
dialog{width:100%;max-width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:0;overflow:auto;border:0;border-radius:var(--radius-lg);background:var(--surface);color:var(--text);box-shadow:var(--shadow-lg);transition:opacity .15s,transform .15s}
dialog[open]{animation:dialog-in .18s cubic-bezier(.2,.8,.2,1)}
dialog.dialog-closing{opacity:0;transform:translateY(6px) scale(.98);pointer-events:none}
dialog::backdrop{background:rgba(16,16,20,.4)}
dialog:has(.perm){max-width:min(640px,calc(100vw - 32px))}
dialog.dialog-wide{max-width:min(760px,calc(100vw - 32px))}
@keyframes dialog-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
.dialog-body{padding:22px}
.dialog h2{margin:0 0 6px;font-size:16px;line-height:24px}
.dialog-message{margin:0 0 16px;color:var(--subdued)}
.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}
.dialog label{margin:0}

/* Forms */
label{display:block;margin-bottom:14px;font-size:13.5px;font-weight:500}
label>input,label>select,label>textarea{display:block;width:100%;margin-top:6px;font-weight:400}
label small,.help{display:block;margin-top:6px;color:var(--subdued);font-size:12.5px;font-weight:400}
.field-label{display:block;margin-bottom:6px;font-size:13.5px;font-weight:500}
input,select,textarea{min-height:36px;padding:7px 11px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-size:14px;transition:border-color .12s,box-shadow .12s}
input::placeholder,textarea::placeholder{color:var(--disabled)}
input:hover,select:hover,textarea:hover{border-color:#bdbdc2}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--focus);box-shadow:var(--ring)}
input[readonly]{background:var(--surface-2)}
input.mono,textarea.mono{font-size:13px}
textarea{min-height:96px;resize:vertical}textarea.tall{min-height:300px}
input[type=checkbox],input[type=radio]{width:16px;height:16px;min-height:0;margin:0;padding:0;accent-color:var(--primary);box-shadow:none}
select:not([multiple]),.combobox-input{appearance:none;-webkit-appearance:none;padding-right:34px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' fill='none'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' stroke='%236b6b70' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 8px}
select:not([multiple]):disabled,.combobox-input:disabled{color:var(--disabled);cursor:not-allowed;opacity:.65}
label.check{display:flex;flex-wrap:wrap;align-items:flex-start;gap:2px 10px;min-width:0;margin-bottom:12px}
label.check input{margin-top:3px;flex:none}
label.check>small{flex:0 0 calc(100% - 26px);min-width:0;margin:0 0 0 26px;line-height:17px;overflow-wrap:anywhere}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:0 14px}
.fields.start{align-items:start}.fields.center{align-items:center}
.fields.two{grid-template-columns:repeat(2,minmax(0,1fr))}.fields .full{grid-column:1/-1}
.event-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:0 14px;min-width:0}
.stack-fields{display:flex;flex-direction:column;gap:14px}.stack-fields label{margin:0}.stack-fields>div:empty{display:none}.stack-fields .fields{row-gap:14px}
.copy-row{display:flex;align-items:center;gap:8px;margin-top:6px}.copy-row input{flex:1;min-width:0;margin:0}
.code-block{position:relative}.code-block pre{padding-right:76px}.code-block>button{position:absolute;top:8px;right:8px}
pre{max-height:360px;margin:0;padding:12px 14px;overflow:auto;border-radius:var(--radius);background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--border);white-space:pre-wrap;word-break:break-word}
details>summary{margin:4px 0 12px;font-weight:500;cursor:pointer}
.disclosure{margin-top:16px;padding-top:12px;border-top:1px solid var(--border)}.disclosure>summary{margin:0}.disclosure[open]>summary{margin-bottom:12px}
.field-heading{margin:18px 0 10px;font-size:14px;line-height:20px;font-weight:500}
.role-form{margin:0}.role-form select{min-height:30px;padding:2px 30px 2px 10px;font-size:13px}
.member-cell{display:flex;align-items:center;gap:12px;min-width:0}.member-cell b{display:flex;align-items:center;gap:6px;font-weight:500}.member-cell .subdued{font-size:12px;line-height:16px}.member-cell>div{min-width:0;overflow:hidden;text-overflow:ellipsis}
.member-role{display:flex;align-items:center;gap:6px}.member-role input{min-width:140px;margin:0}
.invite-rows{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.invite-row{display:grid;grid-template-columns:minmax(0,1fr) 130px 30px;align-items:center;gap:8px}.invite-row input,.invite-row select{min-width:0;margin:0}

/* Choice cards and segmented buttons */
.choice{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-bottom:14px}
.choice label{display:flex;align-items:flex-start;gap:10px;margin:0;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius);font-weight:400;cursor:pointer;transition:border-color .12s}
.choice label:hover{border-color:var(--border-strong)}
.choice label:has(input:checked){border-color:var(--primary);box-shadow:0 0 0 1px var(--primary)}
.choice input{margin-top:2px}.choice b{display:block;font-weight:500}.choice span{color:var(--subdued);font-size:12.5px}
.code-source{min-width:0;margin:0;padding:0;border:0}.code-source legend{margin-bottom:6px;padding:0;font-weight:500}
.code-source .choice{grid-template-columns:repeat(3,minmax(0,1fr));margin:0}
.code-source .choice.two,.code-source .choice:has(>label:nth-child(4)){grid-template-columns:repeat(2,minmax(0,1fr))}
.code-source .choice div{min-width:0}.code-source .choice span{display:block;margin-top:2px;line-height:16px}
.repo-select{display:block}.repo-select>select{display:block;width:100%;margin-top:6px}
textarea.code-editor{min-height:260px;max-height:50vh;overflow:auto;line-height:18px;white-space:pre;tab-size:2}
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:10px;background:var(--active)}
.seg button{min-height:26px;padding:0 10px;border:0;background:none;box-shadow:none;color:var(--subdued);font-size:12.5px}
.seg button:hover{background:none;color:var(--text)}
.seg button.on{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.docform-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}.docform-head h2{margin:0}
.doc-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 16px}
.doc-label{display:flex;align-items:center;gap:8px}.doc-field textarea{min-height:64px}
.doc-json textarea{width:100%}
.doc-inline{display:flex;gap:8px;margin-top:6px}.doc-inline input{flex:1;margin:0}
.attr-order{display:flex;flex-direction:column;gap:6px;max-height:260px;margin:6px 0 14px;padding:8px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius)}
.attr-order label{display:flex;align-items:center;gap:8px;margin:0}.attr-order select{min-height:28px;margin-left:auto;padding:2px 30px 2px 8px;font-size:12.5px}

/* Combobox */
.combobox{position:relative;display:block;margin-top:6px}
.combobox-input{display:block;width:100%;margin:0}
.combobox-native{position:absolute!important;width:1px!important;height:1px!important;margin:0!important;padding:0!important;border:0!important;opacity:0!important;pointer-events:none!important}
.combobox-list{position:fixed;z-index:80;margin:0;padding:4px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow-lg);text-align:left;font-weight:400;visibility:hidden;opacity:0;transform:translateY(4px);transition:opacity .12s,transform .12s,visibility .12s}
.combobox-list[data-side="below"]{transform:translateY(-4px)}
.combobox-list.is-open{visibility:visible;opacity:1;transform:none}
.combobox-option{padding:6px 8px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.combobox-option[aria-selected="true"]{font-weight:500}
.combobox-option.is-active{background:var(--hover)}
.combobox-empty{padding:6px 8px;color:var(--subdued)}

/* File upload */
.upload-field{display:block;min-width:0;margin:0 0 14px}
.upload-label{display:block;margin:0 0 6px;font-weight:500}
.upload-zone{position:relative;display:flex;align-items:center;gap:14px;min-width:0;margin:0;padding:16px;border:1px dashed var(--border-strong);border-radius:var(--radius);background:var(--surface-2);font-weight:400;cursor:pointer;transition:border-color .12s,background .12s}
.upload-zone:hover{border-color:var(--focus);background:var(--info-bg)}
.upload-zone:has(.upload-input:focus-visible){border-color:var(--focus);box-shadow:var(--ring)}
.upload-zone.is-dragover{border-style:solid;border-color:var(--focus);background:var(--info-bg)}
.upload-zone.has-file{border-style:solid;border-color:var(--border);background:var(--surface)}
.upload-zone:has(.upload-input:disabled){opacity:.6;cursor:not-allowed}
.upload-input{position:absolute;inset:0;z-index:1;width:100%;height:100%;min-height:0;margin:0;padding:0;border:0;opacity:0;cursor:pointer}
.upload-input:disabled{cursor:not-allowed}
.upload-icon{display:flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--subdued)}
.upload-zone.is-dragover .upload-icon{color:var(--focus)}
.upload-zone.has-file .upload-icon{border-color:transparent;background:var(--success-bg);color:var(--success)}
.upload-copy{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.upload-empty{display:block;min-width:0}
.upload-title{display:block;font-weight:500;line-height:18px;overflow-wrap:anywhere}
.upload-sub,.upload-file-meta{display:block;color:var(--subdued);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}
.upload-picked{display:flex;flex-direction:column;gap:1px;min-width:0}
.upload-file-name{display:block;font-weight:500;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.upload-browse{display:inline-flex;align-items:center;flex:none;min-height:28px;padding:0 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);font-size:12.5px;font-weight:500}
.upload-zone.has-file .upload-empty{display:none}
.upload-foot{display:flex;align-items:flex-start;gap:12px;margin-top:6px}.upload-foot:empty{display:none}
.upload-help{display:block;flex:1;min-width:0;margin:0;color:var(--subdued);font-size:12.5px;line-height:18px}
.upload-clear{flex:none;min-height:0;margin:0 0 0 auto;padding:0 2px;border:0;background:none;box-shadow:none;color:var(--focus);font-size:12.5px;font-weight:400}
.upload-clear:hover{background:none;text-decoration:underline}
.upload-error{display:block;margin-top:6px;color:var(--critical);font-size:12.5px;line-height:18px}

/* Charts */
.chart{position:relative}
.chart svg{display:block;width:100%;height:auto}
.chart-legend{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:8px;color:var(--subdued);font-size:12px}
.chart-key{display:inline-flex;align-items:center;gap:6px}
.chart-dot,.chart-tooltip-dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.chart-tooltip{position:absolute;z-index:3;min-width:150px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow-lg);font-size:12px;transform:translateX(-50%);pointer-events:none}
.chart-tooltip-time{margin-bottom:4px;font-weight:500}
.chart-tooltip-row{display:flex;justify-content:space-between;gap:16px;color:var(--subdued)}
.chart-tooltip-row b{color:var(--text);font-weight:500;font-variant-numeric:tabular-nums}
.chart-tooltip-label{display:inline-flex;align-items:center;gap:6px}

/* Schema export */
#export-panel{position:sticky;top:20px;align-self:start;max-height:calc(100vh - 40px);overflow:auto}
.export-layout{align-items:start}
.export-head{display:flex;flex-direction:column;gap:10px;padding:12px 18px;border-bottom:1px solid var(--border)}
.export-head-title{display:flex;align-items:baseline;gap:8px}.export-head-title h2{margin:0}.export-head-title .subdued{margin-left:auto;font-size:12.5px;white-space:nowrap}
.export-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.export-tools .search-field{flex:1 1 100%;max-width:none}
.export-actions{display:flex;flex:1 1 100%;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.export-group+.export-group{border-top:1px solid var(--border)}
.export-group-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;min-width:0;margin:0;padding:8px 18px;border-bottom:1px solid var(--border);background:var(--surface-2);color:var(--subdued);font-size:12px;cursor:pointer}
.export-group-name{color:var(--text);font-weight:500;white-space:nowrap}
.export-row{display:flex;align-items:center;gap:10px;min-width:0;margin:0;padding:9px 18px;font-weight:400;cursor:pointer}
.export-row+.export-row{border-top:1px solid var(--border)}
.export-row:hover{background:var(--surface-2)}
.export-row-text{display:flex;flex:1;flex-direction:column;min-width:0;line-height:18px}
.export-row-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.export-clip{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}
.export-count{flex:none;margin-left:auto;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.export-stats{display:flex;flex-wrap:wrap;gap:4px 16px;margin:-4px 0 12px;font-size:12.5px}.export-stats b{font-weight:500}
.export-json{max-height:calc(100vh - 160px)}

/* Email templates */
.template-layout{align-items:start}
.template-list{padding:4px 0}.template-list-head{padding:12px 18px 8px}.template-list-head h2{margin:0}
.template-item{display:flex;align-items:flex-start;gap:12px;padding:12px 18px;border-top:1px solid var(--border);color:var(--text)}
.template-item:hover{background:var(--surface-2);text-decoration:none}.template-item.on{background:var(--hover)}
.template-item .icon{flex:none;margin-top:2px;color:var(--subdued)}
.template-item-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.template-item-name{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-weight:500}
.template-message-head{display:flex;align-items:center;gap:8px;margin:14px 0 8px}.template-message-head h3{margin:0;font-size:14px}.template-message-head .seg{margin-left:auto}
.template-vars{margin-bottom:14px;padding:12px;border-radius:var(--radius);background:var(--surface-2)}
.template-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.template-source{display:block;width:100%;min-height:360px;font-size:12.5px;line-height:1.55;tab-size:2}
.template-preview{overflow:hidden;border:1px solid var(--border);border-radius:var(--radius);background:#f4f4f5}
.template-meta{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--surface);font-size:13px;overflow-wrap:anywhere}
.template-frame{display:block;width:100%;height:560px;border:0;background:#f4f4f5}
.template-foot{justify-content:space-between;margin-top:12px}

/* Variables, backups */
.var-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px}
.var-count{color:var(--subdued);font-size:12.5px}
.var-toolbar-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.var-table{table-layout:fixed}
.var-table td.var-name{overflow:hidden}.var-name>.mono{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.var-name>.badge{margin-top:2px}
.var-table th:first-child{width:38%}
.var-table th.var-actions-col{width:150px;text-align:right}
.var-table th.var-actions-col .menu-root{vertical-align:middle}
.var-table td.var-actions{text-align:right;white-space:nowrap}
.var-table td.var-actions form{display:inline;margin:0 0 0 6px}
.backup-list li{align-items:center;padding:12px 18px}
.backup-meta{display:flex;flex-direction:column;gap:2px;min-width:0}
.backup-actions{display:flex;flex:none;align-items:center;gap:8px}
.backup-actions form{display:inline;margin:0}

/* Permissions and API key scopes */
.perm-presets{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:10px}
.perm-table{margin-bottom:10px;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius);border-collapse:separate;border-spacing:0}
.perm-table td{padding:8px 12px}.perm-table td:first-child{min-width:150px}
.perm-table .perm-col{width:72px;text-align:center}.perm-table .perm-col input{cursor:pointer}
.perm-role{font-weight:500}.perm-sub{font-size:11.5px;line-height:16px}
.perm-empty{margin:0 0 10px;padding:12px;border:1px dashed var(--border-strong);border-radius:var(--radius);text-align:center}
.perm-add{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}.perm-add select{flex:1 1 220px}.perm-add input{flex:1 1 160px;min-width:0}
.perm-error{margin:0 0 8px;color:var(--critical);font-size:12.5px}
.perm-summary{margin-bottom:4px}.perm-summary .list li{padding:6px 0}
.perm-text{margin-top:8px}.perm-text textarea{width:100%}
.scope-picker{min-width:0;margin:16px 0 0;padding:0;border:0}
.scope-picker legend{margin:0 0 8px;padding:0;font-size:13.5px;font-weight:500}
.scope-full{display:flex;align-items:flex-start;gap:10px;margin:0 0 6px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-2);font-weight:400;cursor:pointer}
.scope-full input{margin-top:2px}
.scope-full b{display:block;font-weight:500}
.scope-full .subdued{display:block;font-size:12.5px;line-height:17px}
.scope-toolbar{display:flex;align-items:center;gap:8px;margin:12px 0 6px;font-size:12.5px}
.scope-total{font-weight:500;font-variant-numeric:tabular-nums}
.scope-toolbar [data-scope-clear]{margin-left:auto}
.scope-groups{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);transition:opacity .15s}
.scope-groups.is-disabled{opacity:.5}
.scope-group{padding:0 12px;border-bottom:1px solid var(--border)}.scope-group:last-child{border-bottom:0}
.scope-group-head{display:flex;align-items:center;gap:8px;padding:10px 0}
.scope-group-toggle{all:unset;box-sizing:border-box;display:flex;flex:1;align-items:center;gap:8px;min-width:0;border-radius:6px;cursor:pointer}
.scope-group-toggle:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.scope-chevron{display:inline-block;flex:none;width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:5px solid var(--subdued);transition:transform .15s}
.scope-group-toggle[aria-expanded="true"] .scope-chevron{transform:rotate(90deg)}
.scope-group-name{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:500;white-space:nowrap}
.scope-group-count{margin-right:auto;color:var(--subdued);font-size:12px;font-variant-numeric:tabular-nums}
.scope-all{display:flex;align-items:center;gap:6px;margin:0;color:var(--subdued);font-size:12.5px;font-weight:400;white-space:nowrap;cursor:pointer}
.scope-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 8px;padding-bottom:8px}
.scope-item{display:flex;align-items:flex-start;gap:8px;min-width:0;margin:0;padding:6px 8px;border-radius:8px;font-weight:400;cursor:pointer}
.scope-item:hover{background:var(--surface-2)}
.scope-item:has(input:checked){background:var(--hover)}
.scope-item input{margin-top:2px;cursor:pointer}.scope-item input:disabled{cursor:not-allowed}
.scope-item-text{display:flex;flex-direction:column;min-width:0;line-height:17px}
.scope-item-label{overflow-wrap:anywhere}
.scope-item-code{color:var(--subdued);font-size:11.5px;line-height:15px;overflow-wrap:anywhere}
.key-scopes{white-space:nowrap}.key-scopes .subdued{font-size:12px}

/* Sign-in pages */
.auth{max-width:420px;margin:0 auto;padding:14vh 16px 32px}
.auth .brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:20px;font-size:16px;font-weight:500}
.auth .brand img{width:28px;height:28px}
.auth .card{padding:24px}
.auth .card h2{margin-bottom:18px;font-size:18px;line-height:26px}
.auth .card .hint{margin:-14px 0 20px}
.auth .card .foot button.primary{width:100%}

/* Medium screens: one column */
@media(max-width:1100px){
  .layout{grid-template-columns:minmax(0,1fr)}
  .settings-section{grid-template-columns:minmax(0,1fr);gap:12px}
}
@media(max-width:960px){
  .layout,.split-sidebar{grid-template-columns:minmax(0,1fr)}
  #export-panel{position:static;max-height:none;overflow:visible}
  .settings-layout{grid-template-columns:minmax(0,1fr);gap:16px}
  .settings-nav{position:static;flex-direction:row;gap:20px;margin-bottom:4px;padding:0 0 10px;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--border)}
  .settings-nav::-webkit-scrollbar{display:none}
  .settings-nav-group{flex-direction:row;align-items:center;gap:2px}
  .settings-nav-label{display:none}
  .settings-nav a{white-space:nowrap}
  .settings-section{grid-template-columns:minmax(0,1fr);gap:12px}
}

/* Phones: top bar + slide-in sidebar, stacked tables (see STACK_SCRIPT in layout.ts) */
@media(max-width:768px){
  .frame{grid-template-columns:minmax(0,1fr);background:none}
  .topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;height:54px;padding:0 12px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  .topbar label{display:flex;align-items:center;justify-content:center;width:36px;height:36px;margin:0;border-radius:8px;cursor:pointer}
  .topbar label:hover{background:var(--hover)}
  .topbar .brand{display:flex;align-items:center;gap:8px;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nav{position:fixed;inset:0 auto 0 0;z-index:30;width:276px;background:var(--surface);box-shadow:var(--shadow-lg);transform:translateX(-100%);transition:transform .22s ease;visibility:hidden}
  .nav-head,.nav .foot{background:var(--surface)}
  #nav-toggle:checked~.frame .nav{transform:none;visibility:visible}
  #nav-toggle:checked~.scrim{display:block;position:fixed;inset:0;z-index:25;background:rgba(16,16,20,.35)}
  .nav-toggle{display:none}
  .nav>a{height:40px}
  .frame>main{padding:20px 16px 56px}
  .select-topbar{height:52px;padding:0 14px}
  .select-main{padding:20px 16px 48px}
  .header{flex-wrap:wrap;margin-bottom:20px}
  .header h1{font-size:20px;line-height:28px}
  .header .actions{justify-content:flex-start;width:100%;margin-left:0}
  .header:has(>.actions>.menu-root:only-child){flex-wrap:nowrap}
  .header:has(>.actions>.menu-root:only-child) .actions{width:auto;margin-left:auto}
  .header:has(>.back)>.actions{width:auto;margin-left:auto}
  .card{padding:16px}
  .card.flush>.card-head{padding:12px 16px}
  .stat{flex-basis:120px;padding:12px 14px}
  .stat>b,.stat-value{font-size:20px;line-height:28px}
  .toolbar{flex-wrap:wrap}
  .hide-sm{display:none}
  .search-field{flex-basis:100%;max-width:none}
  .page-toolbar-actions{width:100%;margin-left:0}
  .page-toolbar-actions .primary{flex:1}
  .project-grid{grid-template-columns:minmax(0,1fr)}
  .org-mark{width:38px;height:38px;font-size:16px}
  .org-title h1{font-size:20px;line-height:28px}
  .upload-zone{gap:10px;padding:12px}.upload-browse{display:none}
  .member-cell .avatar{display:none}
  .scope-list{grid-template-columns:minmax(0,1fr)}
  .code-source .choice,.code-source .choice.two,.code-source .choice:has(>label:nth-child(4)){grid-template-columns:minmax(0,1fr)}
  .invite-row{grid-template-columns:minmax(0,1fr) 112px 30px}
  .fields.two{grid-template-columns:minmax(0,1fr)}
  .page-foot,.dialog-actions{flex-direction:column-reverse}.page-foot>*,.dialog-actions>*{width:100%}
  input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),select,textarea{font-size:16px!important}
  table.stacked thead{display:none}
  table.stacked,table.stacked tbody{display:block;width:auto}
  table.stacked tr{display:flex;flex-wrap:wrap;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)}
  table.stacked tbody tr:last-child{border-bottom:0}
  table.stacked tbody tr:hover td{background:none}
  table.stacked td{display:flex;flex:1 1 100%;justify-content:space-between;align-items:center;gap:12px;min-width:0;max-width:none;padding:3px 0!important;border:0;text-align:right;white-space:normal}
  table.stacked td[data-label]::before{content:attr(data-label);flex:none;color:var(--subdued);font:400 12.5px/1.5 "Neue Montreal",-apple-system,sans-serif;text-align:left}
  table.stacked td:first-child,table.stacked td.select-col+td{display:block;padding-bottom:6px!important;text-align:left;font-weight:500}
  table.stacked td:first-child::before,table.stacked td.select-col+td::before{display:none}
  table.stacked td.select-col{flex:0 0 auto;width:auto;margin-right:10px;padding-bottom:6px!important}
  table.stacked td.select-col+td{flex:1 1 0}
  table.stacked td:not([data-label]):not(:first-child){justify-content:flex-end;padding-top:10px!important}
  table.stacked td:empty{display:none}
  table.stacked td[colspan]{display:block;text-align:center}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
${PROGRESS_CSS}`
