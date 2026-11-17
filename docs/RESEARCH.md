# Ledgerline Suite: UX, accessibility and performance research

Audit run 2026-11-17 04:59 UTC (Chromium via Playwright, axe-core 4.x, 1366x900 and 400x860, DPR 1).
At that moment 16 views existed (home, approvals, journals, accounts, reports, periods, payables,
receivables, purchasing, inventory, orders, workforce, absence, payroll, audit, security). The
seven new modules (assets, projects, plan, crm, mfg, talent, cash) had only stub files, so nav,
state size and DOM counts will grow. Scripts: scratchpad `audit.js`, `axe2.js`, `split.js`, `load.js`.

## Summary
- **Speed is fine today but grows with row count.** Most views render in 3 to 8 ms. Journals (177 rows)
  takes 22 to 27 ms and Audit trail (385 rows, 4,200 nodes) 31 to 35 ms. **About 70 to 85% of that is
  style and layout**, not building the string: on audit, parsing the innerHTML takes 4.5 ms and the
  forced layout takes 25.6 ms. Re-rendering more cleverly (morphing, keyed diffs) won't help much.
  **Putting fewer rows in the DOM** will: pagination, `content-visibility`, `table-layout: fixed`.
- **Every action re-renders the whole page.** `App.try(() => null)` on Journals costs 26.8 ms. Of that,
  2 x `JSON.stringify(E.S)` is about 2 ms, `localStorage.setItem` (199 KB) 0.7 ms, and render the rest.
  Storage is not the bottleneck yet. The audit log is 39% of state and will dominate as modules are added.
- **Load:** the Google Fonts stylesheet is render-blocking and moved first paint from about 40 ms to
  136 to 404 ms. `App.start` (seed plus first render) takes 54 to 80 ms. A reload from localStorage takes 41 ms.
- **Accessibility:** axe finds only 3 rules per page (missing `lang`, `.crumb` contrast 2.65:1, empty
  action `<th>`). The serious problems are ones axe cannot see. The drawer does not trap focus (Tab
  leaves it after 3 stops), the background is not inert, tabs have no arrow keys or tabpanel, line-editor
  inputs have no labels, and form errors are not announced.
- **Visual:** there are three real CSS bugs. The "Menu" button shows on desktop. `.dl div > span` turns
  status pills and amounts into uppercase labels in every detail drawer. All `App.link`s use a monospace font,
  so supplier and customer names render in mono. Other issues are density and wrapping problems, and a
  16-item rail that will not scale to 23 or more modules.

## Prioritized backlog

### P1: correctness, accessibility blockers, cheap and high-impact fixes
| # | Change (file / function) | Why (measured / observed) | Impact | Effort | Sources |
|---|---|---|---|---|---|
| 1 | **Make the drawer a real modal.** In `ui.js App.drawer`, render `<dialog class="drawer"><form method="dialog">...` and open it with `showModal()`, or keep the div and set `inert` on `.app` while it is open and trap Tab. Use `aria-labelledby` pointing at the `<h2>` and drop `role=dialog` from the `<form>` (axe `aria-allowed-role`). Change `<header>` to a `<div>` (axe `landmark-no-duplicate-banner`). | Tab left the drawer after 3 presses and reached the rail and top bar. Escape and focus return already work. | Keyboard and screen-reader users | S | [APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [MDN dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog) |
| 2 | **Fix the `.dl` label selector.** In `index.html`, change `.dl div > span` to `.dl div > span:first-child`, or better, add a class to the label in `ui.js dl()`. | Every detail drawer shows the status pill stretched and uppercased ("VALIDATED"), and the amount and "Unpaid" values styled as labels (screenshot `drawer-1366.png`). | Every drill-down | S | (visual audit) |
| 3 | **Hide the Menu button on desktop.** `.btn` (line 82) overrides `.menu-btn{display:none}` (line 63). Use `.btn.menu-btn{display:none}` or move the rule. Also add `aria-expanded` and `aria-controls="rail"`, close on Escape and on scrim click, and move focus into the rail. | A "Menu" button that does nothing shows at 1366px. On mobile, `aria-expanded` is null and focus stays on the button. | Visual polish, a11y | S | [APG disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) |
| 4 | **Paginate long tables.** Add `opts.pageSize` (default 50) to `App.table`, with "Showing 1-50 of 385" and Prev/Next, and per-view page state in `App.ui`. Use it in Journals, Audit, Receivables and Orders, plus the account drill-down (`App.detail('acct')` renders every posting). | Layout is 15 ms of 22 ms on Journals and 25.6 of 31 on Audit. 50 rows would cut each to about 5 ms. These lists grow with every module. | Every action on long views 4 to 6 times faster | M | [web.dev large layouts](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing), [Carbon data table](https://carbondesignsystem.com/components/data-table/usage/) |
| 5 | **Fix contrast tokens.** Raise light `--faint` from `#8a9894` to about `#6b7a76` (`.crumb` is 2.65:1 on `--bg`, and 3.0:1 on white). Raise dark `--faint` from `#6e7f7a` to about `#83948f` (4.45:1). Give input and select borders a 3:1 token (`--line` `#d9e1df` on white is 1.33:1, which fails 1.4.11). | axe `color-contrast` on all 16 views, light and dark. Ratios computed by hand. | AA conformance | S | [WCAG 2.2 What's new](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/), [Understanding 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) |
| 6 | **Add `<html lang="en">`** in `index.html`, and a visually hidden "Actions" header for action columns in `App.table` (`c.h` is empty). | axe `html-has-lang` (16/16 views) and `empty-table-header` (9 views, 14 nodes). | AA | S | axe rules |
| 7 | **Label line-editor cells.** In `App.lines`, add `aria-label="${c.label} line ${i+1}"` to each cell input and select. | New journal drawer: axe `label` x6 and `select-name` x2. | Forms usable with a screen reader | S | [WAI forms tutorial](https://www.w3.org/WAI/tutorials/forms/labels/) |
| 8 | **Announce drawer errors and mark fields invalid.** `#drawerErr` gets `role="alert"`. Let engine errors carry an optional `field`, then set `aria-invalid` and `aria-describedby` on that input and focus it. | The error text is currently silent (no role or live region). Nothing points to the field. | Fewer failed submits | S/M | [NN/g form errors](https://www.nngroup.com/articles/errors-forms-design-guidelines/), [GOV.UK error message](https://design-system.service.gov.uk/components/error-message) |

### P2: navigation, tables, perceived quality
| # | Change | Why | Impact | Effort | Sources |
|---|---|---|---|---|---|
| 9 | **Ctrl/Cmd+K command palette.** Add a `<dialog>` with a combobox that merges (a) every `views[n]` as "Go to ...", (b) `E.search(q)` records, and (c) registered actions (`App.command(label, fn, perm)`). With an empty query, show recent items. Reuse the `search-pick` handler and add a visible "Ctrl K" hint in the top bar. | We will have 23+ modules and the rail already fills 900px at 16. Search currently only finds records, not pages or actions. | Fastest navigation for power users | M | [APG combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/), [SaaS palette patterns](https://www.saasui.design/blog/saas-search-command-palette-ux-patterns) |
| 10 | **Collapsible rail groups, plus Favorites and Recent.** In `renderNav()`, make each `.nav-group h4` a `<button aria-expanded>`, store collapsed groups and pinned or recent views in `localStorage` (`ledgerline-ui` key, wrapped in try/catch), and auto-expand the group of `App.current`. | NAV grows through `def.group`, and 8+ groups at 30px per item will not fit. | Wayfinding | S/M | [NN/g vertical nav](https://www.nngroup.com/articles/vertical-nav/) |
| 11 | **Sortable headers in `App.table`.** Add `c.sort: (row) => key`. The header renders `<th aria-sort><button data-act="sort">`, with sort state in `App.ui.sort[view]`. Put `aria-sort` only on the sorted `<th>`. | There is no sorting anywhere. Finance users scan by amount and date. | Core table UX | M | [APG sortable table](https://www.w3.org/WAI/ARIA/apg/patterns/table/examples/sortable-table/), [Chrome guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/ui-behaviors/sortable-table) |
| 12 | **Sticky table headers and a density toggle.** Use `.t th{position:sticky;top:var(--top-h)}` with `.tbl-wrap` scrolling vertically inside a max-height, or sticky against the page with `overflow-x:clip`. Add a body class `density-compact` (6px cell padding, 13px text) saved per viewer. | On Journals and Audit the headers scroll away after about 12 rows. Rows are 36 to 53px tall because of wrapping. | Scanability | S | [Carbon data table style](https://carbondesignsystem.com/components/data-table/style) |
| 13 | **Column hygiene.** In `App.link`, apply `mono` only when the label equals the id (names render in mono today). Add `white-space:nowrap` and `max-width` with an ellipsis and `title` for "Created by" and description columns. Set `table-layout:fixed` plus `<colgroup>` widths on large tables. | Journals: "System Administrator" wraps on every row, doubling row height. Supplier names show in monospace. | Density, less layout work | S | [NN/g data tables](https://www.nngroup.com/articles/data-tables/) |
| 14 | **APG tabs.** In `App.tabs`, add `id`/`aria-controls`, wrap content in `role="tabpanel"`, use roving `tabindex` (-1 on inactive tabs), and handle ArrowLeft/Right/Home/End. | Today there is no tabpanel or aria-controls, and every tab is tabindex 0. | Keyboard | S | [APG tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) |
| 15 | **Keep focus across re-renders.** In `render()`, save `document.activeElement` by `id` or by `[data-act][data-id]` before replacing innerHTML, then restore it after. On route change only, move focus to the page `h1` (`tabindex=-1`) so screen readers hear the new page. | After any `App.try` the clicked button is destroyed and focus falls to `<body>`, so a keyboard user restarts at the top. | Keyboard flow | S | [APG dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) (focus return), [MDN focus](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus) |
| 16 | **Load Plex fonts without blocking render.** Use `<link rel=preload as=style onload="this.rel='stylesheet'">` or a `media="print" onload` swap, or self-host the woff2 subsets. | The fonts stylesheet moved FCP from about 40 ms to 136 to 404 ms. | First paint | S | [web.dev defer non-critical CSS](https://web.dev/articles/defer-non-critical-css) |
| 17 | **Saved filters in the URL.** Encode `App.ui.filter[view]` and sort into the hash (`#journals?status=Pending`), so views can be shared or bookmarked and Back works. | Filters are lost on reload. | Saved-view light | M | [NN/g data tables](https://www.nngroup.com/articles/data-tables/) |
| 18 | **Mobile tables.** At 820px and below, render `App.table` rows as stacked cards (`td::before{content:attr(data-h)}`) or hide low-priority columns (`c.hideSm`). | At 400px the Journals rows are about 100px tall and 5 of 8 columns sit off-screen with no scroll cue. | Phone use | M | [Carbon data table](https://carbondesignsystem.com/components/data-table/usage/) |

### P3: scale and polish
| # | Change | Why | Impact | Effort | Sources |
|---|---|---|---|---|---|
| 19 | **Cap and split persistence.** Trim `E.S.audit` to the most recent N in storage (or archive it under a separate key). Debounce `save()` with `requestIdleCallback`, with a 500 ms fallback, and flush on `pagehide`. Make the snapshot lazy: use `structuredClone` only for the touched collections, or keep the snapshot string and skip the save when the new string is identical. | Audit is 78 KB of 199 KB. The storage path costs about 3 ms per action today, and it is synchronous and grows linearly. | Future-proofing | S | [Nolan Lawson, what blocks the DOM](https://nolanlawson.com/2015/09/29/indexeddb-websql-localstorage-what-blocks-the-dom/) |
| 20 | **`content-visibility:auto`** with `contain-intrinsic-size` on below-the-fold `.card`s on Home and large report sections. | A cheap layout skip if pagination is not adopted everywhere. | Render | S | [web.dev content-visibility](https://web.dev/articles/content-visibility) |
| 21 | **Targeted updates instead of `render()` for drawer-only actions.** When an action only changes the open drawer, re-render the drawer and the nav badges, and defer the page render with `requestAnimationFrame`, coalescing repeated calls into one frame (`let queued; App.render = () => queued ||= requestAnimationFrame(() => { queued = 0; render(); })`). | Most actions are triggered from drawers, and the page behind is re-laid out (about 25 ms on long views) even though nobody can see it. | Snappier drawers | S | [web.dev large layouts](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing) |
| 22 | **Morph instead of replacing (optional).** Use idiomorph or a tiny keyed `tbody` patch (`data-key=row.id`) to keep scroll, focus and input state. Measured string plus parse is only 3 to 5 ms, so do this for state preservation, not speed. | It replaces the hand-rolled scroll restore and would make #15 unnecessary. | Robustness | M | [idiomorph](https://github.com/bigskysoftware/idiomorph) |
| 23 | **Finance dashboard.** Compare KPI tiles to the prior period (delta and sparkline), make each tile a link to its list, and keep 4 to 6 KPIs. Format dates consistently: the Home attention list shows raw `2026-11-17 to 2026-11-18`. | KPI tiles have no comparison, so a value has no context. | Insight | M | [Few, via UXmatters](https://uxmatters.com/mt/archives/2007/04/book-review-information-dashboard-design.php) |
| 24 | **Empty states with a next step.** `App.table` `opts.empty` already exists. Add an optional action button (for example "New journal") and an icon. | Some lists already describe the next step in text but give no button to take it. | Onboarding | S | [NN/g empty states](https://www.nngroup.com/articles/empty-state-interface-design/) |
| 25 | **Toasts:** cap at 3, add a dismiss button, and pause the timer on hover or focus. Keep `role=status` / `alert`. | Errors stay for 7 s, and there is no way to dismiss them or keep them longer. | WCAG 2.2.1 | S | [WCAG 2.2.1 Timing](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html) |
| 26 | **`prefers-reduced-motion`** already covers the rail. Keep any new transitions (drawer slide, palette) behind the same media query. | — | — | S | [MDN prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) |

Not recommended: adding a framework or a build step, or virtualization. At these row counts, pagination
is simpler, and virtual scroll breaks find-in-page and screen-reader table navigation. `defer` on the 21
scripts gains nothing measurable: they already sit at the end of the document, and the parse cost is
under 10 ms.

## Raw results

### axe-core (wcag2a/aa, wcag21a/aa, wcag22aa, best-practice): identical in light and dark
| Rule | Impact | Views | Nodes | Example selector / detail |
|---|---|---|---|---|
| color-contrast | serious | 16/16 | 16 | `.crumb`: 2.65:1 light (#8a9894 on #eef2f1), 4.45:1 dark |
| html-has-lang | serious | 16/16 | 16 | `html` |
| empty-table-header | minor | 9/16 | 14 | `section:nth-child(1) > .tbl-wrap > table > thead > tr > th:nth-child(5)` (action columns) |
| (drawer) aria-allowed-role | minor | detail and form drawers | 1 | `#drawer` (`role=dialog` on `<form>`) |
| (drawer) landmark-no-duplicate-banner | moderate | detail and form drawers | 1 | `#drawer > header` |
| (New journal drawer) label | critical | — | 6 | `#jeLines-memo-0` and other line cells |
| (New journal drawer) select-name | critical | — | 2 | `#jeLines-acct-0` |

Manual checks:
- **Drawer focus:** initial focus lands in the drawer (OK). Tab escapes after 3 presses (FAIL). Escape
  closes the drawer and focus returns to the trigger (OK).
- **Tabs:** no `aria-controls`, no `role=tabpanel`, every tab tabindex 0 (FAIL).
- **Mobile menu:** no `aria-expanded`, focus is not moved (FAIL).
- **Tables:** no `<caption>` and no `scope` (acceptable for simple tables).
- **Reduced motion:** a rule exists.

Contrast computed by hand: rail group labels 5.15:1 light and 4.98:1 dark (OK). `--muted` on
`--surface-2` 5.5:1 (OK). `--warn` on `--warn-soft` 4.77:1 (OK). Primary button 6.7:1 (OK).
Input border 1.33:1 (FAIL 1.4.11).

### Performance (Chromium headless, median of 5 runs, light mode)
| View | Render ms (median/max) | DOM nodes (page / #content) | #content HTML KB |
|---|---|---|---|
| home | 7.7 / 9.8 | 398 / 281 | 13.9 |
| approvals | 3.0 / 3.2 | 297 / 180 | 7.4 |
| journals | **26.8 / 37.8** | 2295 / 2178 | 82.1 |
| accounts | 3.0 / 3.2 | 354 / 237 | 7.5 |
| reports | 3.3 / 3.5 | 306 / 189 | 7.1 |
| periods | 3.1 / 3.2 | 328 / 211 | 6.3 |
| payables | 2.9 / 3.0 | 301 / 184 | 7.8 |
| receivables | 8.3 / 8.4 | 867 / 750 | 32.6 |
| purchasing | 3.5 / 3.6 | 329 / 212 | 8.7 |
| inventory | 3.0 / 3.2 | 272 / 155 | 5.3 |
| orders | 6.9 / 7.1 | 754 / 637 | 28.2 |
| workforce | 3.9 / 4.1 | 405 / 288 | 12.0 |
| absence | 3.2 / 3.3 | 383 / 266 | 9.7 |
| payroll | 2.5 / 2.5 | 223 / 106 | 3.9 |
| audit | **35.2 / 40.6** | 4329 / 4212 | 172.0 |
| security | 5.3 / 5.3 | 612 / 495 | 29.5 |

Render split (a second run, so totals differ slightly):

| View | Total | innerHTML parse | Forced layout | Rows |
|---|---|---|---|---|
| journals | 22.3 | 2.7 | 15.1 | 177 |
| audit | 30.6 | 4.5 | 25.6 | 385 |
| receivables | 7.1 | 0.9 | 4.0 | 43 |
| home | 4.7 | 0.5 | 1.8 | 25 |

| Action / load metric | Value |
|---|---|
| `JSON.stringify(E.S)` | 1.0 ms, **199 KB** (audit 78 KB, journals 62 KB, sos 15 KB, invTxns 13 KB) |
| `JSON.parse` / `localStorage.setItem` | 0.7 ms / 0.7 ms |
| `App.try(() => null)` on Journals (snapshot, save, render, drawer refresh) | 26.8 ms |
| `App.try(E.approveAbsence)` on Journals | 24.6 ms |
| `E.approvalsInbox()` (runs on every render for the nav badge) | 0.2 ms |
| First load, empty storage (seed plus first render), `App.start` | 54 to 80 ms |
| Reload from localStorage, `App.start` | 41 ms |
| FCP with Google Fonts / with fonts blocked | 136 to 404 ms / about 30 to 45 ms |
| Counts | 177 journals, 384 audit entries |

### Visual review (screenshots in scratchpad `shots/`)
- **Desktop 1366:** a "Menu" button shows in the top bar for no purpose. The page-head description wraps at
  70ch next to the action buttons, leaving a ragged two-line intro. Journals and Audit rows vary from 36
  to 53px because descriptions and "System Administrator" wrap. Payables puts the row action (Pay/Release)
  in a headerless column, and the hold reason inside the status cell makes that row three lines tall.
  Supplier names are underlined monospace.
- **Detail drawer:** label styles leak onto values (P1 #2). The step flow for a "Validated" invoice
  highlights "Paid" as current, which reads as if it has been paid. Use a "next" style for the
  following step, or highlight "Validated".
- **400px:** the layout holds with no horizontal page scroll (scrollWidth 400). Tables scroll sideways
  with no affordance, and only 3 or 4 columns are visible. KPI tiles in two columns work well.
- **Home:** the attention list mixes formatted dates (`17 Nov 2026`) with raw ISO ranges
  (`2026-11-17 to 2026-11-18`). The nav badge (6) and the visible list count can differ at a glance
  when a "See all" exists. That is acceptable, but label it.
- **Dark mode:** consistent. Only the `--faint` contrast issue remains.

Note: nngroup.com and primer.style could not be fetched from this environment. The NN/g citations come from search results.
