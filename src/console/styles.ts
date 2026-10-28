import { PROGRESS_CSS } from './progress'

/** Console stylesheet, kept as a string so the console has no build step. */
export const CONSOLE_CSS = `
:root{--bg:#f1f1f1;--surface:#fff;--nav:#ebebeb;--nav-hover:#e3e3e3;--nav-on:#fafafa;--text:#303030;--subdued:#616161;--disabled:#b5b5b5;--border:#e3e3e3;--border-strong:#8a8a8a;--primary:#303030;--primary-hover:#1a1a1a;--critical:#8e1f0b;--critical-bg:#fedad9;--success:#2a6a45;--success-bg:#e6f3eb;--attention:#7a3a00;--attention-bg:#ffe7d1;--info:#00527c;--info-bg:#e0f0ff;--focus:#005bd3;--ring:#b5b5b5;--shadow:0 1px 0 rgba(26,26,26,.07),inset 0 -1px 0 rgba(0,0,0,.08),inset 0 0 0 1px rgba(0,0,0,.06)}
*{box-sizing:border-box}html,body{margin:0}[hidden]{display:none!important}
body{font:13px/20px "Inter",-apple-system,BlinkMacSystemFont,"San Francisco","Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--focus);text-decoration:none}a:hover{text-decoration:underline}
.icon{display:inline-block;vertical-align:-.15em;flex:none}
code,.mono,pre,textarea.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.frame{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
.nav{background:var(--nav);padding:12px 8px;position:sticky;top:0;height:100vh;overflow:auto;display:flex;flex-direction:column}
.nav-head{display:flex;align-items:center;gap:4px;padding:0 0 12px;margin-bottom:8px;border-bottom:1px solid var(--border)}
.switcher{flex:1;min-width:0}
.switcher-btn{list-style:none;display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:10px;cursor:pointer;min-width:0}
.switcher-btn::-webkit-details-marker{display:none}
.switcher-btn:hover,.switcher[open] .switcher-btn{background:var(--nav-hover)}
.switcher-btn:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.switcher-text{display:flex;flex-direction:column;flex:1;min-width:0;line-height:16px}
.switcher-text b,.switcher-org{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.switcher-text b{font-weight:650;font-size:13px}.switcher-org{color:var(--subdued);font-size:11px}
.switcher-caret{color:var(--subdued)}
.nav-head{position:relative}.switcher.menu-root{position:static}.switcher .menu{left:0;right:0;width:auto;min-width:0}.switcher .menu.menu-fixed{right:auto;width:260px}
.select-topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;height:56px;padding:0 max(24px,calc((100% - 1080px)/2 + 24px));background:var(--surface);border-bottom:1px solid var(--border)}
.select-brand{display:flex;align-items:center;gap:8px;color:var(--text);font-weight:650;font-size:15px}.select-brand:hover{text-decoration:none}.select-brand img{width:24px;height:24px}
.select-user{display:flex;align-items:center;margin-left:auto}
.account-btn{list-style:none;display:flex;border-radius:50%;cursor:pointer}.account-btn::-webkit-details-marker{display:none}
.account-btn:hover .avatar,.menu-root[open] .account-btn .avatar{box-shadow:0 0 0 3px var(--border)}
.account-btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.select-main{max-width:1080px;width:100%;margin:0 auto;padding:32px 24px 64px}
.tile{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:8px;font-weight:650;font-size:13px;line-height:1;background:#e3e3e3;color:#303030}
.tile.sm{width:22px;height:22px;border-radius:6px;font-size:11px}.tile.lg{width:36px;height:36px;border-radius:10px;font-size:15px}
.tile.blue{background:#e0f0ff;color:#00527c}.tile.green{background:#cdfee1;color:#0c5132}.tile.orange{background:#ffe7d1;color:#7a3a00}
.tile.purple{background:#f1e8ff;color:#5b2a9c}.tile.pink{background:#ffe4f0;color:#8a1f55}.tile.teal{background:#d4f5f1;color:#0b5149}
.avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border-radius:50%;background:#d9d9d9;color:#303030;font-weight:650;font-size:10px;line-height:1}
.avatar.md{width:32px;height:32px;font-size:12px}
.icon-btn{all:unset;box-sizing:border-box;list-style:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;color:var(--subdued);cursor:pointer}
.icon-btn::-webkit-details-marker{display:none}
.icon-btn:hover,.menu-root[open]>.icon-btn{background:rgba(0,0,0,.06);color:var(--text)}
.icon-btn:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.menu-root{position:relative;display:inline-block}.menu-root>summary{margin:0;font-weight:inherit}
.menu{position:absolute;right:0;top:calc(100% + 4px);z-index:60;min-width:180px;padding:6px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.06);text-align:left;font-weight:450}
.menu.menu-fixed{position:fixed;right:auto}
.menu hr{border:0;border-top:1px solid var(--border);margin:6px -6px}
.menu form{margin:0;display:block}
.menu-item,.menu form button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:32px;padding:6px 8px;border-radius:6px;color:var(--text);cursor:pointer;font-weight:450;white-space:nowrap}
.menu-item:hover,.menu form button:hover,.menu-item:focus-visible,.menu form button:focus-visible{background:#f3f3f3;text-decoration:none}
.menu form button.critical{color:var(--critical)}.menu form button.critical:hover{background:var(--critical-bg)}
.menu-item .icon{color:var(--subdued)}.menu-item>.icon:first-child{margin:0 3px}
.menu-item-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.menu-item[aria-current]{font-weight:600}.menu-check{color:var(--text)!important}
.menu-label{padding:4px 8px 6px;color:var(--subdued);font-size:12px;font-weight:550}
.menu-scroll{max-height:240px;overflow:auto}
.menu-head{padding:6px 8px;color:var(--subdued);font-size:12px;line-height:18px}.menu-head b{display:block;color:var(--text);font-size:13px;font-weight:550;overflow:hidden;text-overflow:ellipsis;max-width:240px}
.page-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.page-toolbar-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.search-field{position:relative;display:flex;flex:1 1 280px;max-width:360px;min-width:0;margin:0}
.search-field-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);display:flex;color:var(--subdued);pointer-events:none}
.search-field input{flex:1 1 auto;width:100%;min-width:0;padding-left:34px;background:var(--surface);border-color:var(--border-strong)}
.seg-links{display:inline-flex;flex:none;gap:2px;padding:2px;border-radius:8px;background:#e3e3e3}
.seg-links a{display:flex;align-items:center;justify-content:center;width:30px;height:28px;border-radius:6px;color:var(--subdued)}
.seg-links a:hover{color:var(--text);text-decoration:none}
.seg-links a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.project-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.project-card{position:relative;display:flex;flex-direction:column;gap:12px;padding:16px;background:var(--surface);border-radius:12px;box-shadow:var(--shadow);transition:box-shadow .15s ease}
.project-card:hover{box-shadow:0 4px 14px rgba(0,0,0,.08),inset 0 0 0 1px rgba(0,0,0,.1)}
.project-card-link{position:absolute;inset:0;z-index:1;border-radius:12px}
.project-card-link:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.project-card-head{display:flex;align-items:center;gap:12px;min-width:0}
.project-card-head .menu-root{position:relative;z-index:2;margin:-4px -6px 0 auto;align-self:flex-start}
.project-card-name{display:flex;flex-direction:column;min-width:0}
.project-card-name h3{margin:0;font-size:14px;line-height:20px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-card-name .mono{font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-card-badges{display:flex;gap:4px;min-height:20px}
.project-card-badges:empty{display:none}
.project-card-stats{display:flex;align-items:flex-end;gap:16px;margin-top:auto;padding-top:12px;border-top:1px solid var(--border)}
.project-card-requests{display:flex;flex-direction:column;flex:none;font-size:12px;line-height:16px}
.project-card-requests b{color:var(--text);font-size:18px;line-height:24px;font-weight:650;font-variant-numeric:tabular-nums}
.project-spark-wrap{display:flex;flex-direction:column;align-items:flex-end;flex:1;min-width:0;gap:2px;font-size:11px;line-height:14px;color:#2463eb}
.project-spark{display:block;width:100%;height:28px}.project-spark.idle{color:#cfcfcf}
.project-row{display:inline-flex;align-items:center;gap:10px;color:inherit;vertical-align:middle;margin-right:6px}.project-row:hover{text-decoration:none}.project-row:hover b{text-decoration:underline}
.project-row>span{display:flex;flex-direction:column;line-height:18px}.project-row .mono{font-size:11.5px}
.org-head{display:flex;align-items:center;gap:14px;margin-bottom:20px;min-width:0}
.org-head-actions{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.org-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border-radius:12px;background:var(--primary);color:#fff;font-weight:650;font-size:18px}
.org-title{min-width:0}.org-title h1{margin:0;font-size:22px;line-height:28px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.org-title p{margin:2px 0 0;font-size:13px}
.settings-section{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:24px;padding:0 0 24px;margin-bottom:24px;border-bottom:1px solid var(--border)}
.settings-section:last-of-type{border-bottom:0;margin-bottom:0}
.settings-section .card{margin:0;min-width:0;overflow:hidden}
.settings-section>.card:has(>form[data-confirm-tone="critical"]:last-child){display:flex;flex-direction:column;justify-content:center;align-items:flex-start}
.settings-section>.card:has(>form[data-confirm-tone="critical"]:last-child)>.hint{margin:0 0 8px}
.settings-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.settings-aside h2{margin:4px 0 4px;font-size:14px;line-height:20px;font-weight:650}.settings-aside p{margin:0;font-size:13px}
.settings-badge{display:inline-flex;margin-top:4px}.settings-badge .badge+.badge{margin-left:4px}
.copy-row{display:flex;align-items:center;gap:8px;margin-top:4px}.copy-row input{flex:1;min-width:0;margin:0}
.page-note{margin:-4px 0 16px;font-size:12.5px}.page-note b{color:var(--text);font-weight:550}
.section-head{display:flex;align-items:baseline;gap:8px;margin:28px 0 10px}.section-head h2{margin:0;font-size:14px;line-height:20px;font-weight:650}
.member-cell{display:flex;align-items:center;gap:12px;min-width:0}.member-cell b{display:flex;align-items:center;gap:6px;font-weight:550}.member-cell .subdued{font-size:12px;line-height:16px}.member-cell>div{min-width:0;overflow:hidden;text-overflow:ellipsis}
th.role-col,td.role-col{width:160px}th.date-col{width:140px}th.actions-col{width:56px}
.role-form{margin:0}.role-form select{min-height:28px;padding:2px 30px 2px 10px;font-size:13px;background-color:var(--surface);border-color:var(--border)}
.role-form select:hover{border-color:var(--border-strong)}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.stack-fields{display:flex;flex-direction:column;gap:14px}.stack-fields label{margin:0}.stack-fields .fields{row-gap:14px}
.card.narrow{max-width:520px}
.code-source{border:0;padding:0;margin:0;min-width:0}.code-source legend{padding:0;margin-bottom:6px;font-weight:450}
.code-source .choice{grid-template-columns:repeat(3,minmax(0,1fr));margin:0}
.code-source .choice.two,.code-source .choice:has(>label:nth-child(4)){grid-template-columns:repeat(2,minmax(0,1fr))}
.repo-select{display:block}.repo-select>select{display:block;width:100%;margin-top:4px}
.code-source .choice label{align-items:flex-start}.code-source .choice div{min-width:0}.code-source .choice b{font-weight:600}.code-source .choice span{display:block;line-height:16px;margin-top:2px}
textarea.code-editor{min-height:260px;max-height:50vh;tab-size:2;white-space:pre;overflow:auto;line-height:18px}
input[type=file]{padding:5px 8px;background:var(--surface)}
.invite-rows{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.invite-row{display:grid;grid-template-columns:minmax(0,1fr) 130px 28px;gap:8px;align-items:center}.invite-row input,.invite-row select{min-width:0;margin:0}
.nav-toggle{all:unset;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;cursor:pointer;color:var(--text);opacity:.6}
.nav-toggle:hover{background:var(--nav-hover);opacity:1}
.nav-toggle span{display:flex}
.nav-toggle .nav-expand-icon{display:none}
.nav>a{display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:8px;color:var(--text);font-weight:550;margin-bottom:2px}
.nav>a:hover{background:var(--nav-hover);text-decoration:none}.nav>a.on{background:var(--nav-on);box-shadow:var(--shadow)}
.nav .group{margin-top:14px;padding:0 12px 4px;color:var(--subdued);font-size:12px;font-weight:550}
.nav .foot{display:flex;align-items:center;gap:8px;margin-top:auto;padding:12px 4px 0 8px;color:var(--subdued);font-size:12px;border-top:1px solid var(--border)}
.nav .foot .nav-admin{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{padding:20px 32px 48px;max-width:1100px;width:100%;margin:0 auto}
.header{display:flex;align-items:center;gap:12px;margin-bottom:16px;min-height:32px}
.header-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.header-title{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;min-width:0}.header-title h1{min-width:0;max-width:100%}
.id-copy{display:inline-flex;align-items:center;gap:2px;vertical-align:middle;max-width:100%}.id-copy .mono{overflow:hidden;text-overflow:ellipsis}
.icon-btn.id-copy-btn{width:auto;min-width:22px;height:22px;padding:0 4px;gap:4px;border-radius:6px;font-size:12px}
.id-copy-btn [data-copy-label]:empty{display:none}
.header h1{font-size:20px;line-height:28px;font-weight:650;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header .back{display:inline-flex;flex:none;align-self:center;width:28px;height:28px;border-radius:8px;align-items:center;justify-content:center;color:var(--text);font-size:16px}
.header .back:hover{background:#e3e3e3;text-decoration:none}
.header .meta{display:flex;gap:6px;align-items:center;flex:none}.header .actions{margin-left:auto;display:flex;gap:8px}
.header .actions .icon-btn{width:32px;height:32px;background:var(--surface);box-shadow:var(--shadow);color:var(--text)}
.header .actions .icon-btn:hover,.header .actions .menu-root[open]>.icon-btn{background:#f7f7f7}
.card{background:var(--surface);border-radius:12px;box-shadow:var(--shadow);padding:16px;margin-bottom:16px}
.card.flush{padding:0;overflow:hidden}.card h2{font-size:14px;font-weight:650;margin:0 0 12px}
.card .hint{color:var(--subdued);margin:-8px 0 12px}
.card .foot{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.card form>textarea{width:100%}
.card-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}.card-head h2{margin:0}.card-head-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:16px}@media(max-width:960px){.layout{grid-template-columns:minmax(0,1fr)}}
.split-sidebar{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:16px}
#export-panel{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto}
.template-layout{align-items:start}
.template-list{padding:4px 0}.template-list-head{padding:12px 16px 8px}.template-list-head h2{margin:0}
.template-item{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;color:var(--text);border-top:1px solid var(--border)}
.template-item:hover{background:var(--nav-on);text-decoration:none}.template-item.on{background:var(--nav)}
.template-item .icon{flex:none;margin-top:2px;color:var(--subdued)}
.template-item-text{display:flex;flex-direction:column;gap:2px;min-width:0}.template-item-name{font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.template-message-head{display:flex;align-items:center;gap:8px;margin:12px 0 8px}.template-message-head h3{margin:0;font-size:14px;font-weight:650}.template-message-head .seg{margin-left:auto}
.template-vars{background:var(--bg);border-radius:8px;padding:12px;margin-bottom:12px}
.template-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:2px 10px;border-radius:8px;font-size:12px}
.template-source{display:block;width:100%;min-height:360px;font-size:12.5px;line-height:1.55;tab-size:2}
.template-preview{border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#f4f4f5}
.template-meta{display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:var(--surface);border-bottom:1px solid var(--border);font-size:13px;overflow-wrap:anywhere}
.template-frame{display:block;width:100%;height:560px;border:0;background:#f4f4f5}
.template-foot{justify-content:space-between;margin-top:12px}
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
.record-table td{padding:8px 12px}
.domain-table td{padding:6px 12px}
.domain-table td.actions-col{text-align:right;white-space:nowrap}
.domain-table .mono{font-size:13px}
.row-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}
.toolbar{display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);align-items:center}
.toolbar input{flex:1}
.tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px}
.tabs a{padding:6px 12px;border-radius:8px;color:var(--subdued);font-weight:550}
.tabs a:hover{background:#e3e3e3;text-decoration:none}.tabs a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
label{display:block;margin-bottom:12px;font-weight:450}
label>input,label>select,label>textarea{display:block;width:100%;margin-top:4px}
label small,.help{display:block;color:var(--subdued);font-size:12px;margin-top:4px}
input,select,textarea{font:inherit;color:var(--text);background:#fdfdfd;border:1px solid var(--border-strong);border-radius:8px;padding:6px 12px;min-height:32px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--text)}
input[type=checkbox],input[type=radio]{accent-color:var(--primary)}
input[type=checkbox]:focus-visible,input[type=radio]:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
button:focus-visible,.btn:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
select:not([multiple]),.combobox-input{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' stroke='%23616161' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;background-size:12px 8px;padding-right:34px;cursor:pointer}
select:not([multiple]):disabled,.combobox-input:disabled{color:var(--disabled);cursor:not-allowed;opacity:.65}
.combobox{display:block;position:relative;margin-top:4px}
.combobox-input{display:block;width:100%;margin:0}
.combobox-native{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:0!important;border:0!important;opacity:0!important;pointer-events:none!important}
.combobox-list{position:fixed;z-index:80;margin:0;padding:4px;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.06);text-align:left;font-weight:450;visibility:hidden;opacity:0;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease,visibility .12s}
.combobox-list[data-side="below"]{transform:translateY(-4px)}
.combobox-list.is-open{visibility:visible;opacity:1;transform:none}
.combobox-option{padding:6px 8px;border-radius:6px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.combobox-option[aria-selected="true"]{font-weight:550}
.combobox-option.is-active{background:#f3f3f3}
.combobox-empty{padding:6px 8px;color:var(--subdued)}
.toolbar select{flex:0 0 auto;min-width:150px}
textarea{min-height:80px;resize:vertical}textarea.tall{min-height:300px}
label.check{display:flex;flex-wrap:wrap;gap:2px 8px;align-content:flex-start;align-items:flex-start;margin-bottom:12px;min-width:0}label.check input{width:16px;min-height:16px;margin:3px 0 0;flex:none}label.check>small{display:block;flex:0 0 100%;margin:0 0 0 24px;color:var(--subdued);font-size:12px;line-height:16px;overflow-wrap:anywhere;min-width:0}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0 12px}.fields.center{align-items:center}
.event-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:0 12px;min-width:0}.event-grid label.check{min-width:0}
button,.btn{font:inherit;font-weight:550;border:0;border-radius:8px;padding:6px 12px;min-height:28px;cursor:pointer;background:var(--surface);color:var(--text);box-shadow:var(--shadow);display:inline-flex;align-items:center;gap:6px;white-space:nowrap;text-decoration:none}
button:hover,.btn:hover{background:#f7f7f7;text-decoration:none}
button.primary,.btn.primary{background:var(--primary);color:#fff;box-shadow:0 -1px 0 1px rgba(0,0,0,.8) inset,0 0 0 1px #303030 inset,0 .5px 0 1.5px rgba(255,255,255,.25) inset}
button.primary:hover,.btn.primary:hover{background:var(--primary-hover)}
button.critical{color:var(--critical)}button.small,.btn.small{padding:2px 8px;min-height:24px;font-size:12px}button.plain{background:none;box-shadow:none;color:var(--focus);padding:0 4px;min-height:0}
button.critical.plain{color:var(--critical)}
button.destructive{background:var(--critical);color:#fff;box-shadow:0 -1px 0 1px rgba(0,0,0,.8) inset,0 0 0 1px var(--critical) inset}
button.destructive:hover{background:#721807}
button[aria-busy]{cursor:progress;opacity:.8}button[aria-busy]::before{content:"";width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
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
.banner-close:focus-visible{outline:2px solid var(--ring);outline-offset:1px;opacity:1}
.banner-out{opacity:0;transform:translateY(-4px)}
.empty{text-align:center;padding:40px 16px}.empty h3{font-size:14px;margin:0 0 4px;font-weight:650}.empty p{color:var(--subdued);margin:0 0 12px}
.subdued{color:var(--subdued)}.stack{display:flex;flex-direction:column;gap:4px}.inline{display:inline}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)}.list li>:last-child{min-width:0;overflow-wrap:anywhere;text-align:right}.list li:last-child{border:0}.list .clip{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list li.var-row{flex-wrap:wrap;align-items:center}.var-toolbar{display:flex;justify-content:flex-end;margin-bottom:8px}.var-edit{flex:0 0 100%;display:flex;flex-wrap:wrap;justify-content:flex-end}.var-edit>summary{display:inline-block;font-weight:450;color:var(--focus);margin:2px 0 0}.var-edit>summary:hover{text-decoration:underline}.var-edit[open]>summary{color:var(--subdued);flex:0 0 100%;text-align:right;margin-bottom:6px}.var-edit-form{flex:0 0 100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin:0 0 4px}.var-edit-form input:not([type=hidden]):not([type=checkbox]){flex:1 1 160px;min-width:120px;margin:0}.var-edit-form label.check{margin:0;flex:none;align-items:center}.var-edit-form label.check input{margin:0}.var-edit-form button{flex:none}
pre{background:#f7f7f7;border-radius:8px;padding:12px;overflow:auto;max-height:360px;margin:0;white-space:pre-wrap;word-break:break-word}
details>summary{cursor:pointer;font-weight:550;margin:4px 0 12px}
.disclosure{border-top:1px solid var(--border);margin-top:16px;padding-top:12px}.disclosure>summary{margin:0}.disclosure[open]>summary{margin-bottom:10px}
.field-heading{font-size:14px;line-height:20px;font-weight:650;margin:16px 0 10px}
.cell-sub{font-size:12px;line-height:16px}
.page-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.member-role{display:flex;gap:6px;align-items:center}.member-role input{min-width:140px;margin:0}
dialog:has(.perm){max-width:min(640px,calc(100vw - 32px))}
dialog.dialog-wide{max-width:min(760px,calc(100vw - 32px))}
.pager{display:flex;gap:8px;justify-content:center;align-items:center;padding:10px;border-top:1px solid var(--border)}
.auth{max-width:432px;margin:14vh auto 0;padding:0 16px}.auth .brand{display:flex;gap:10px;align-items:center;justify-content:center;font-weight:650;font-size:16px;margin-bottom:16px}.auth .brand img{width:28px;height:28px}
.htmx-request{opacity:.6;transition:opacity .2s}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;background:#1a1a1a;color:#fff;padding:10px 16px;border-radius:12px;font-weight:550;z-index:50;box-shadow:0 8px 20px rgba(0,0,0,.2);animation:toast 4s forwards}
.nav-tooltip{position:fixed;z-index:100;background:#1a1a1a;color:#fff;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:550;pointer-events:none;box-shadow:0 8px 20px rgba(0,0,0,.2);white-space:nowrap}
.nav-tooltip[hidden]{display:none}
@keyframes toast{0%{opacity:0;transform:translate(-50%,8px)}8%,85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;visibility:hidden}}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.topbar{display:none}#nav-toggle{display:none}.scrim{display:none}
@media(min-width:769px){
  html.nav-collapsed .frame{grid-template-columns:72px minmax(0,1fr)}
  html.nav-collapsed .nav-head{flex-direction:column;gap:6px}
  html.nav-collapsed .switcher{flex:none}
  html.nav-collapsed .switcher-btn{padding:6px}
  html.nav-collapsed .switcher-text,html.nav-collapsed .switcher-caret{display:none}
  html.nav-collapsed .nav>a{justify-content:center;padding:8px 0}
  html.nav-collapsed .nav>a span{display:none}
  html.nav-collapsed .nav .group{display:none}
  html.nav-collapsed .nav .group+a{margin-top:10px}
  html.nav-collapsed .nav .foot{flex-direction:column;padding:12px 0 0}
  html.nav-collapsed .nav .nav-admin{display:none}
  html.nav-collapsed .nav .nav-collapse-icon{display:none}
  html.nav-collapsed .nav .nav-expand-icon{display:flex}
}
.perm-presets{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.perm-table{border:1px solid var(--border);border-radius:8px;border-collapse:separate;border-spacing:0;overflow:hidden;margin-bottom:10px}
.perm-table th{background:#f7f7f7}.perm-table td{padding:8px 12px}.perm-table td:first-child{min-width:150px}
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
@media(prefers-reduced-motion:reduce){dialog,.banner,.combobox-list{animation:none!important;transition:none!important}}
@media(max-width:768px){
  .frame{grid-template-columns:minmax(0,1fr)}
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
  .select-topbar{padding:0 14px;height:52px}
  .select-main{padding:20px 16px 40px}
  .search-field{flex-basis:100%;max-width:none}
  .page-toolbar-actions{width:100%;margin-left:0}
  .page-toolbar-actions .primary{flex:1;justify-content:center}
  .project-grid{grid-template-columns:1fr}
  .org-mark{width:38px;height:38px;font-size:16px}
  .org-title h1{font-size:19px;line-height:26px}
  .settings-section{grid-template-columns:minmax(0,1fr);gap:10px}
  th.role-col,td.role-col{width:auto}
  .member-cell .avatar{display:none}
  .code-source .choice,.code-source .choice.two,.code-source .choice:has(>label:nth-child(4)){grid-template-columns:1fr}
  .invite-row{grid-template-columns:minmax(0,1fr) 112px 28px}
}
${PROGRESS_CSS}`
