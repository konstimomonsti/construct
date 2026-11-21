"use strict";

const $ = id => document.getElementById(id);
const LABELS = { include: "Included", conditional: "Conditional", unit_price_only: "Unit price only" };
const FORMAT_GROUPS = [
  ["Documents", [
    ["pdf", "PDF", "Priced bill for review"], ["docx", "Word (.docx)", "Editable document"],
    ["zip", "ZIP bundle", "PDF and Word together"],
  ]],
  ["GAEB DA XML", [
    ["x83", "GAEB XML 3.2 (.x83)", "Tender scope, unpriced"], ["x83-31", "GAEB XML 3.1 (.x83)", "Tender scope, older software"],
    ["x82", "GAEB XML 3.2 (.x82)", "Cost estimate with rates"],
  ]],
  ["GAEB 90 (legacy)", [
    ["d83", "GAEB 1990 (.d83)", "Tender scope, unpriced"], ["d84", "GAEB 1990 (.d84)", "Bid with prices"],
    ["d86", "GAEB 1990 (.d86)", "Award scope and rates"],
  ]],
];
const FILTERS = [
  ["", "All"], ["unpriced", "Needs rate"], ["matches", "Catalogue match"], ["gaps", "Scope gaps"], ["conditional", "Conditional"],
];
const SAMPLE_PROJECT = "Challenge A import review";
const SAMPLE_FILE = "GAEB-[PROJEKT_004].X83";
const pageSize = 100;
const state = { workspace: null, bom: null, changes: new Map(), page: 1, busy: false, filter: "", allPending: false };
const integer = new Intl.NumberFormat("en");
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>';

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function option(value, label) {
  const node = element("option", label);
  node.value = value;
  return node;
}

function button(label, handler, className = "ghost") {
  const node = element("button", label, className);
  node.type = "button";
  node.addEventListener("click", handler);
  return node;
}

function chevron() {
  const holder = element("span");
  holder.innerHTML = ICON_CHEVRON;
  return holder.firstChild;
}

async function request(path, params = {}, payload, raw = false) {
  const query = new URLSearchParams(params);
  const init = payload === undefined ? {} : {
    method: "POST", headers: { "Content-Type": raw ? "application/octet-stream" : "application/json" },
    body: raw ? payload : JSON.stringify(payload),
  };
  const response = await fetch(`/api/mvp/${path}?${query}`, init);
  if (!response.ok) {
    let message = "The request could not be completed.";
    try { message = (await response.json()).error || message; } catch { /* non-JSON error */ }
    throw new Error(message);
  }
  return path === "export" ? response : response.json();
}

let toastTimer;
function notify(message = "", error = false) {
  clearTimeout(toastTimer);
  $("notice").hidden = !message;
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  if (message && !error) toastTimer = setTimeout(() => { $("notice").hidden = true; }, 4000);
}

function sampleProject() {
  return state.workspace?.projects.find(p => p.name === SAMPLE_PROJECT);
}

function busy(value) {
  state.busy = value;
  $("pick-file").disabled = value || !state.workspace?.project;
  $("import-library-source").disabled = value || !state.workspace?.project;
  $("sample").disabled = value || !sampleProject();
  $("project").disabled = value;
  $("create-project").disabled = value;
  for (const control of document.querySelectorAll(".bill, .pending-actions button")) control.disabled = value;
  for (const input of $("lines").querySelectorAll(".cell")) input.disabled = value || Boolean(state.bom?.version.locked);
  updateActions();
}

function updateActions() {
  const count = state.changes.size;
  $("savebar").hidden = !count;
  $("unsaved-count").textContent = count === 1 ? "1 position" : `${count} positions`;
  $("save").disabled = state.busy || !count || Boolean(state.bom?.version.locked);
  $("discard").disabled = state.busy;
  for (const action of ["export", "risk", "catalogue"]) {
    $(action).disabled = state.busy || Boolean(count);
  }
  $("export").title = count ? "Save your changes before exporting" : "";
  $("risk").title = $("catalogue").title = count ? "Save your changes before reviewing the bill" : "";
}

function mayLeave() {
  return !state.changes.size || confirm("Discard unsaved changes to this bill?");
}

function itemCount(doc) {
  return (doc.counts?.item || 0) + (doc.counts?.item_candidate || 0) ||
    (doc.exchange_phase === "84" ? doc.counts?.price || 0 : 0);
}

/* ---------- Home ---------- */

function drawHome() {
  const ws = state.workspace;
  const drafts = ws?.drafts || [];
  const list = $("drafts");
  list.replaceChildren();
  for (const draft of drafts) {
    const row = button("", () => {
      if (!state.busy) run(() => openDraft(draft.id, true));
    }, "bill");
    const main = element("span", undefined, "bill-main");
    main.append(element("strong", draft.title || draft.filename || "Untitled bill"),
      element("span", [draft.filename, `version ${draft.version_no}`].filter(Boolean).join(" · ")));
    const lines = Number(draft.lines) || 0;
    const priced = Number(draft.priced) || 0;
    const progress = element("span", undefined, "bill-progress");
    const meter = element("span", undefined, "meter");
    const fill = element("span");
    fill.style.width = `${lines ? Math.round(priced / lines * 100) : 0}%`;
    meter.append(fill);
    progress.append(element("span", `${integer.format(priced)} of ${integer.format(lines)} positions priced`), meter);
    row.append(main, progress, chevron());
    list.append(row);
  }
  $("drafts-count").textContent = drafts.length ? integer.format(drafts.length) : "";
  if (!drafts.length) {
    list.append(element("div", ws?.project
      ? "No bills in this project yet. Upload a tender above to create one."
      : "Create a project to start.", "empty-home"));
  }

  const opened = new Set(drafts.map(d => d.source_id).filter(Boolean));
  const pending = (ws?.documents || []).filter(doc => !opened.has(doc.id));
  const box = $("pending");
  box.replaceChildren();
  const shown = state.allPending ? pending : pending.slice(0, 6);
  for (const doc of shown) {
    const row = element("div", undefined, "bill bill-pending");
    const main = element("span", undefined, "bill-main");
    const count = itemCount(doc);
    const bits = doc.status === "failed" ? ["Couldn't read this file"]
      : count ? [`${integer.format(count)} positions found`] : ["No positions found"];
    if (doc.warnings) bits.push(`${doc.warnings} parser warnings`);
    if (doc.exchange_phase === "84") bits.push("Bid return");
    main.append(element("strong", doc.filename), element("span", bits.join(" · ")));
    const actions = element("span", undefined, "pending-actions");
    let index = null;
    if (doc.boq_indexes.length > 1) {
      index = element("select");
      index.setAttribute("aria-label", `Bill of quantities in ${doc.filename}`);
      for (const n of doc.boq_indexes) index.append(option(n, `Bill ${n}`));
      actions.append(index);
    }
    const open = button("Open", () => {
      run(() => openSource(doc.id, index ? Number(index.value) : doc.boq_indexes[0] || null));
    }, "ghost small-btn");
    open.disabled = doc.status === "failed" || !count;
    actions.append(open);
    row.append(main, actions);
    box.append(row);
  }
  if (shown.length < pending.length) {
    box.append(button(`Show all ${integer.format(pending.length)} files`, () => { state.allPending = true; drawHome(); }, "show-more"));
  }
  $("pending-block").hidden = !pending.length;
  $("pending-count").textContent = pending.length ? integer.format(pending.length) : "";
  $("home-sub").textContent = ws?.project
    ? "Upload a tender to get an editable bill you can price and export."
    : "Create a project first, then upload a tender.";
}

async function loadWorkspace(project) {
  state.workspace = await request("workspace", project ? { project } : {});
  const select = $("project");
  select.replaceChildren();
  if (!state.workspace.projects.length) select.append(option("", "No projects"));
  for (const entry of state.workspace.projects) select.append(option(entry.id, entry.name));
  select.value = state.workspace.project?.id || "";
  drawHome();
  $("db-dot").classList.add("online");
  $("db-label").textContent = "Connected";
}

/* ---------- Editor ---------- */

function setDraft(data) {
  state.bom = data;
  state.changes.clear();
  state.page = 1;
  state.filter = "";
  $("search").value = "";
  $("section").replaceChildren(option("", "All sections"));
  for (const s of data.sections) {
    if (data.lines.some(line => line.section_id === s.id)) {
      $("section").append(option(s.id, `${s.display_code ? s.display_code + " " : ""}${s.title}`));
    }
  }
  const v = data.version;
  $("title").textContent = v.title;
  const meta = $("subtitle");
  meta.replaceChildren(document.createTextNode([v.filename, `Version ${v.version_no}`].filter(Boolean).join(" · ")));
  meta.append(element("span", v.locked ? "Locked by issued quote" : "Draft", v.locked ? "badge locked" : "badge"));
  $("rate-header").textContent = `Rate (${v.currency})`;
  $("original").hidden = !v.source_id;
  if (v.source_id) $("original").href = `/api/mvp/original?id=${encodeURIComponent(v.source_id)}`;
  $("scope").hidden = !v.scope_notes;
  $("welcome").hidden = true;
  $("review").hidden = false;
  $("review-step").setAttribute("aria-current", "step");
  $("export-step").removeAttribute("aria-current");
  document.title = `${v.title} · Tender desk`;
  drawLines();
  window.scrollTo({ top: 0 });
}

async function openDraft(id, push = false) {
  const data = await request("bom", { id });
  if (data.version.project_id !== state.workspace.project?.id) await loadWorkspace(data.version.project_id);
  setDraft(data);
  const url = `?bom=${encodeURIComponent(id)}`;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

function closeDraft() {
  state.bom = null;
  state.changes.clear();
  updateActions();
  $("welcome").hidden = false;
  $("review").hidden = true;
  document.title = "Tender desk";
  if (location.search) history.pushState(null, "", "/tender-desk/");
  drawHome();
}

async function openSource(id, boqIndex) {
  const draft = await request("draft", {}, { document_id: id, boq_index: boqIndex });
  await loadWorkspace(state.workspace.project.id);
  await openDraft(draft.bom_version_id, true);
}

async function run(action) {
  if (state.busy) return;
  busy(true);
  notify();
  try {
    await action();
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy(false);
  }
}

function setUploadNote(text, working = false) {
  $("upload-note").textContent = text;
  $("upload-note").classList.toggle("busy", working);
}

async function showLibrarySource(id) {
  const response = await fetch("/data/index.json");
  if (!response.ok) throw new Error("Could not load the VaultBudget library.");
  const source = (await response.json()).lists.find(list => list.id === id);
  if (!source?.file?.startsWith("files/")) throw new Error("The original file is unavailable.");
  $("library-source-name").textContent = source.fileName;
  $("library-source").hidden = false;
  $("import-library-source").onclick = () => upload(async () => {
    const file = await fetch(`/${source.file}`);
    if (!file.ok || file.headers.get("content-type")?.includes("text/html")) {
      throw new Error("Could not download the original file.");
    }
    return new File([await file.blob()], source.fileName);
  });
}

function upload(getFile) {
  if (!state.workspace?.project || !mayLeave()) return;
  run(async () => {
    try {
      const file = await getFile();
      if (!file) return;
      setUploadNote(`Reading ${file.name}…`, true);
      const project = state.workspace.project.id;
      const imported = await request("upload", { project, filename: file.name }, file, true);
      await loadWorkspace(project);
      const doc = state.workspace.documents.find(source => source.id === imported.document_id);
      if (imported.status === "failed") {
        setUploadNote("We couldn't read positions from this file. The original is kept under Data tables.");
      } else if (imported.format === "zip") {
        setUploadNote("Archive imported. Open one of its files below.");
      } else if (doc && itemCount(doc) && doc.boq_indexes.length <= 1) {
        await openSource(doc.id, doc.boq_indexes[0] || null);
        setUploadNote(`Imported ${file.name}.`);
      } else {
        setUploadNote(doc?.boq_indexes.length > 1
          ? "This file holds several bills. Pick one below." : "File stored, but no positions were found in it.");
      }
    } catch (error) {
      setUploadNote("");
      throw error;
    } finally {
      $("file").value = "";
    }
  });
}

function drawer(context, title, centered = false) {
  $("drawer-context").textContent = context;
  $("drawer-title").textContent = title;
  $("drawer-content").replaceChildren();
  $("drawer").classList.toggle("center", centered);
  if (!$("drawer").open) $("drawer").showModal();
  $("drawer").scrollTop = 0;
  return $("drawer-content");
}

function labelled(label, input) {
  const wrapper = element("label");
  wrapper.append(element("span", label), input);
  return wrapper;
}

function current(line) {
  return { ...line, ...state.changes.get(line.id) };
}

function change(line, field, value) {
  const fields = { ...state.changes.get(line.id) };
  if (value === (line[field] ?? "")) delete fields[field];
  else fields[field] = value;
  if (Object.keys(fields).length) state.changes.set(line.id, fields);
  else state.changes.delete(line.id);
  updateActions();
}

function decimal(value) {
  const found = /^([+-]?)(\d+)(?:[.,](\d+))?$/.exec(String(value ?? "").trim());
  if (!found) return null;
  return { digits: BigInt(found[1] + found[2] + (found[3] || "")), scale: found[3]?.length || 0 };
}

function lineAmount(line) {
  if (line.total_rule === "unit_price_only") return null;
  const a = decimal(line.draft_unit_price);
  const b = decimal(line.pricing_basis === "lump_sum" ? "1" : line.quantity);
  if (!a || !b) return null;
  const value = a.digits * b.digits;
  const scale = a.scale + b.scale;
  if (scale <= 2) return value * 10n ** BigInt(2 - scale);
  const divisor = 10n ** BigInt(scale - 2);
  return value < 0n ? -((-value + divisor / 2n) / divisor) : (value + divisor / 2n) / divisor;
}

function money(value) {
  if (value === null) return "—";
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${integer.format(absolute / 100n)}.${String(absolute % 100n).padStart(2, "0")}`;
}

function gap(line) {
  return !line.line_code || (line.pricing_basis === "unit_rate" && (!line.unit_code || !decimal(line.quantity)));
}

const TESTS = {
  "": () => true,
  unpriced: line => !decimal(line.draft_unit_price),
  matches: line => Boolean(line.catalogue_id),
  gaps: gap,
  conditional: line => line.total_rule !== "include",
};

function drawFilters(lines) {
  const box = $("filters");
  box.replaceChildren();
  for (const [key, label] of FILTERS) {
    const n = lines.filter(TESTS[key]).length;
    if (key && key !== "unpriced" && !n && state.filter !== key) continue;
    const tab = button("", () => { state.filter = key; state.page = 1; drawLines(); },
      `tab${key === "unpriced" && n ? " warn" : ""}`);
    tab.setAttribute("aria-pressed", String(state.filter === key));
    tab.append(document.createTextNode(label), element("span", integer.format(n), "n"));
    box.append(tab);
  }
}

function drawMetrics(lines) {
  const included = lines.filter(line => line.total_rule === "include");
  const amounts = included.map(lineAmount);
  const priced = amounts.filter(value => value !== null);
  const subtotal = priced.reduce((sum, value) => sum + value, 0n);
  const pricedCount = lines.filter(line => decimal(line.draft_unit_price)).length;
  $("metric-lines").textContent = integer.format(lines.length);
  $("metric-priced").textContent = integer.format(pricedCount);
  $("metric-meter").style.width = `${lines.length ? pricedCount / lines.length * 100 : 0}%`;
  $("metric-gaps").textContent = integer.format(lines.filter(gap).length);
  $("metric-matches").textContent = integer.format(lines.filter(line => line.catalogue_id).length);
  $("metric-total").textContent = priced.length ? `${money(subtotal)} ${state.bom.version.currency}` : "—";
  const unpriced = included.length - priced.length;
  $("metric-unpriced").textContent = unpriced ? `${integer.format(unpriced)} included positions still without an amount` : "";
}

function flagContent(box, data) {
  box.replaceChildren();
  if (data.catalogue_id) {
    const flag = element("span", "Catalogue match", "flag match");
    flag.title = [data.catalogue_name, data.catalogue_category].filter(Boolean).join(" · ");
    box.append(flag);
  }
  if (gap(data)) box.append(element("span", "Scope gap", "flag gap"));
  if (data.total_rule !== "include") box.append(element("span", LABELS[data.total_rule], "flag cond"));
  if (data.pricing_basis === "lump_sum") box.append(element("span", "Lump sum", "flag"));
}

function sectionTotals(lines) {
  const totals = new Map();
  for (const line of lines) {
    if (line.total_rule !== "include") continue;
    const amount = lineAmount(line);
    if (amount === null) continue;
    totals.set(line.section_id, (totals.get(line.section_id) || 0n) + amount);
  }
  return totals;
}

function drawLines() {
  if (!state.bom) return;
  const all = state.bom.lines.map(current);
  drawMetrics(all);
  drawFilters(all);
  updateActions();
  const query = $("search").value.trim().toLocaleLowerCase();
  const section = $("section").value;
  const test = TESTS[state.filter];
  const records = state.bom.lines.filter(line => {
    const data = current(line);
    return (!section || data.section_id === section) && test(data) && (!query ||
      [data.line_code, data.short_description, data.long_description].some(value => value?.toLocaleLowerCase().includes(query)));
  });
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  state.page = Math.min(pages, state.page);
  const start = (state.page - 1) * pageSize;
  const slice = records.slice(start, start + pageSize);
  const totals = sectionTotals(all);
  const sections = new Map(state.bom.sections.map(s => [s.id, s]));
  const currency = state.bom.version.currency;
  const fragment = document.createDocumentFragment();
  let lastSection;
  for (const line of slice) {
    const data = current(line);
    if (data.section_id !== lastSection && data.section_id) {
      lastSection = data.section_id;
      const s = sections.get(data.section_id);
      const head = element("tr", undefined, "section-row");
      const cell = element("td");
      cell.colSpan = 6;
      if (s?.display_code) cell.append(element("span", s.display_code, "sec-code"));
      cell.append(document.createTextNode(s?.title || data.section || "Section"));
      if (totals.has(data.section_id)) cell.append(element("span", `${money(totals.get(data.section_id))} ${currency}`, "sec-sum"));
      head.append(cell);
      fragment.append(head);
    }
    fragment.append(lineRow(line, data));
  }
  $("lines").replaceChildren(fragment);
  $("empty-lines").hidden = Boolean(slice.length);
  $("line-count").textContent = slice.length
    ? `${integer.format(start + 1)}–${integer.format(start + slice.length)} of ${integer.format(records.length)} positions`
    : "";
  $("previous").hidden = $("next").hidden = pages <= 1;
  $("previous").disabled = state.page <= 1;
  $("next").disabled = state.page >= pages;
}

function lineRow(line, data) {
  const tr = element("tr", undefined, "line-row");
  tr.classList.toggle("is-changed", state.changes.has(line.id));
  const desc = element("td", undefined, "desc");
  const title = button(data.short_description, () => editDetails(line), "line-title");
  title.title = "Open details";
  const flags = element("div", undefined, "flags");
  flagContent(flags, data);
  desc.append(title, flags);
  const amount = element("td", money(lineAmount(data)), "amount");
  amount.classList.toggle("none", lineAmount(data) === null);
  tr.append(element("td", data.line_code || "—", "pos"), desc);
  const locked = Boolean(state.bom.version.locked);
  for (const [field, label, kind] of [["quantity", "Quantity", "num"], ["unit_code", "Unit", "unit"], ["draft_unit_price", "Rate", "num"]]) {
    const fieldCell = element("td");
    const input = element("input", undefined, `cell ${kind}`);
    input.dataset.field = field;
    input.value = data[field] ?? "";
    input.placeholder = field === "draft_unit_price" ? "Add rate" : "—";
    input.maxLength = field === "unit_code" ? 40 : 35;
    input.autocomplete = "off";
    if (kind === "num") input.inputMode = "decimal";
    input.setAttribute("aria-label", `${label} ${data.line_code || data.sort_order}`);
    input.disabled = state.busy || locked;
    const mark = () => {
      const edited = current(line);
      input.classList.toggle("changed", Object.hasOwn(state.changes.get(line.id) || {}, field));
      input.classList.toggle("missing", field === "draft_unit_price" && !decimal(edited.draft_unit_price)
        && edited.total_rule !== "conditional");
    };
    mark();
    input.addEventListener("input", () => {
      change(line, field, input.value);
      mark();
      const edited = current(line);
      const value = lineAmount(edited);
      amount.textContent = money(value);
      amount.classList.toggle("none", value === null);
      flagContent(flags, edited);
      tr.classList.toggle("is-changed", state.changes.has(line.id));
      const all = state.bom.lines.map(current);
      drawMetrics(all);
    });
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const inputs = [...$("lines").querySelectorAll(`.cell[data-field="${field}"]`)];
      inputs[inputs.indexOf(input) + (event.shiftKey ? -1 : 1)]?.focus();
    });
    input.addEventListener("focus", () => input.select());
    fieldCell.append(input);
    tr.append(fieldCell);
  }
  tr.append(amount);
  return tr;
}

function editorField(name, value, choices) {
  let field;
  if (choices) {
    field = element("select");
    for (const [key, text] of Object.entries(choices)) field.append(option(key, text));
  } else {
    field = element(name.endsWith("description") ? "textarea" : "input");
  }
  field.name = name;
  field.value = value ?? "";
  return field;
}

function editDetails(line) {
  const data = current(line);
  const body = drawer(`Pos. ${data.line_code || "without code"}`, data.short_description);
  const currency = state.bom.version.currency;
  const facts = element("dl", undefined, "facts");
  for (const [label, value] of [
    ["Quantity", [data.quantity, data.unit_code].filter(Boolean).join(" ") || "—"],
    [`Rate (${currency})`, data.draft_unit_price || "—"],
    ["Amount", money(lineAmount(data))],
  ]) {
    const item = element("div");
    item.append(element("dt", label), element("dd", value));
    facts.append(item);
  }
  body.append(facts);

  const locked = Boolean(state.bom.version.locked);
  const form = element("form", undefined, "form");
  const fields = {};
  for (const [name, label, choices] of [
    ["short_description", "Description"], ["long_description", "Detailed scope"], ["line_code", "Position code"],
    ["pricing_basis", "Pricing basis", { unit_rate: "Unit rate", lump_sum: "Lump sum" }],
    ["total_rule", "Counts toward total", LABELS],
  ]) {
    const field = editorField(name, data[name], choices);
    field.disabled = locked;
    field.required = name === "short_description";
    fields[name] = labelled(label, field);
  }
  const pair = element("div", undefined, "pair");
  pair.append(fields.pricing_basis, fields.total_rule);
  form.append(fields.short_description, fields.long_description, fields.line_code, pair);
  if (!locked) {
    const actions = element("div", undefined, "actions");
    const apply = element("button", "Apply to draft", "primary");
    apply.type = "submit";
    actions.append(apply, button("Cancel", () => $("drawer").close()));
    form.append(actions);
  }
  form.addEventListener("submit", event => {
    event.preventDefault();
    for (const [name, value] of new FormData(form)) change(line, name, value);
    $("drawer").close();
    drawLines();
  });
  body.append(form);

  if (data.catalogue_id) {
    const card = element("div", undefined, "note-card match");
    card.append(element("h3", "Catalogue match"));
    const link = element("a", [data.catalogue_name, data.catalogue_category].filter(Boolean).join(" · "));
    link.href = `/admin/tables?table=product&where=${encodeURIComponent(JSON.stringify({ id: data.catalogue_id }))}`;
    link.target = "_blank";
    const p = element("p");
    p.append(link);
    card.append(p);
    body.append(card);
  }
  if (data.source_filename) {
    const card = element("div", undefined, "note-card");
    const loc = data.source_locator || {};
    const reference = loc.page ? `page ${loc.page}` : loc.record ? `record ${loc.record}`
      : loc.paragraph ? `paragraph ${loc.paragraph}` : loc.xml_path || "original document";
    card.append(element("h3", "From the tender"), element("p", `${data.source_filename}, ${reference}`),
      element("p", `Quantity ${data.source_quantity ?? "—"} · Rate ${data.source_unit_price ?? "—"}`));
    body.append(card);
  }
}

function saveDraft() {
  if (!state.changes.size || state.busy) return;
  run(async () => {
    const lines = Array.from(state.changes, ([id, fields]) => ({ id, ...fields }));
    const data = await request("save", {}, { id: state.bom.version.id, revision: state.bom.version.edit_revision, lines });
    state.bom = data;
    state.changes.clear();
    drawLines();
    notify("Changes saved.");
  });
}

function showExports() {
  if (state.changes.size) return;
  const body = drawer(state.bom.version.title, "Export bill", true);
  const message = element("p", "", "export-status");
  message.setAttribute("role", "status");
  body.append(message);
  for (const [group, formats] of FORMAT_GROUPS) {
    const section = element("section", undefined, "export-group");
    const grid = element("div", undefined, "export-grid");
    section.append(element("h3", group), grid);
    for (const [id, format, description] of formats) {
      const download = button("", async () => {
        download.disabled = true;
        message.classList.remove("error");
        message.textContent = `Preparing ${format}…`;
        try {
          const response = await request("export", { id: state.bom.version.id, format: id });
          const file = URL.createObjectURL(await response.blob());
          const a = element("a");
          a.href = file;
          a.download = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition"))?.[1] || "BOM";
          a.click();
          setTimeout(() => URL.revokeObjectURL(file), 1000);
          $("review-step").removeAttribute("aria-current");
          $("review-step").classList.add("done");
          $("export-step").setAttribute("aria-current", "step");
          message.textContent = `${format} downloaded.`;
        } catch (error) {
          message.classList.add("error");
          message.textContent = error.message;
        } finally {
          download.disabled = false;
        }
      }, "export-option");
      download.append(element("strong", format), element("small", description));
      grid.append(download);
    }
    body.append(section);
  }
}

const RISK_LAYERS = {
  1: "Deterministic checks",
  2: "Dependency checks",
  3: "AI review",
};

async function showRisk() {
  const { id, title } = state.bom.version;
  const body = drawer(title, "Risk assessment");
  const panel = element("section", undefined, "review-panel");
  const controls = element("div", undefined, "review-actions");
  const notice = element("p", "Loading saved assessment…", "muted");
  notice.setAttribute("role", "status");
  const report = element("div", undefined, "review-panel");
  panel.append(controls, notice, report);
  body.append(panel);

  let assessment;
  let layer = "";
  let page = 0;
  const perPage = 25;

  function render() {
    const { run: lastRun, findings, outdated } = assessment;
    report.replaceChildren();
    if (!lastRun) {
      report.append(element("p", "No assessment has been saved for this bill.", "muted"));
      return;
    }
    const { summary } = lastRun;
    const counts = ["error", "warning", "info"].map(severity =>
      `${summary.by_severity[severity] || 0} ${severity === "info" ? "info" : `${severity}s`}`);
    report.append(
      element("p", `${new Date(lastRun.created_at).toLocaleString()} · Layers attempted ${lastRun.layers_run.join(", ")}`, "muted small"),
      element("strong", counts.join(" · ")),
    );
    if (outdated) report.append(element("p", "The bill changed after this run. Run the assessment again before reviewing findings.", "note-card"));
    if (summary.errors?.length) {
      const messages = element("ul", undefined, "note-card review-messages");
      for (const message of summary.errors) messages.append(element("li", message));
      report.append(messages);
    }
    const filter = element("select");
    filter.append(option("", "All layers"));
    for (const [number, label] of Object.entries(RISK_LAYERS)) {
      filter.append(option(number, `${number} · ${label} (${summary.by_layer[number] || 0})`));
    }
    filter.value = layer;
    filter.onchange = () => { layer = filter.value; page = 0; render(); report.querySelector("select").focus(); };
    report.append(labelled("Show findings", filter));
    const visible = findings.filter(finding => layer === "" || String(finding.layer) === layer);
    for (const finding of visible.slice(page * perPage, (page + 1) * perPage)) {
      const card = element("article", undefined, "note-card");
      const meta = [`Layer ${finding.layer}`, finding.severity, finding.target.line_code, finding.model].filter(Boolean);
      card.append(element("p", meta.join(" · "), "eyebrow"), element("h3", finding.title), element("p", finding.message));
      if (Object.keys(finding.evidence || {}).length) {
        const details = element("details");
        details.append(element("summary", "Evidence"), element("pre", JSON.stringify(finding.evidence, null, 2)));
        card.append(details);
      }
      if (finding.suggested_fix) card.append(element("p", finding.suggested_fix.rationale));
      const actions = element("div", undefined, "review-actions");
      actions.append(element("span", `Review status · ${finding.status}`, "muted small"));
      if (!outdated) {
        const statuses = finding.status === "open" ? [["Accept", "accepted"], ["Reject", "rejected"]] : [["Reopen", "open"]];
        for (const [label, status] of statuses) {
          actions.append(button(label, () => perform("Saving review…", async () => {
            const decision = await request("finding", {}, { run_id: lastRun.id, finding_key: finding.id, status });
            Object.assign(finding, decision);
          }), "ghost small-btn"));
        }
      }
      card.append(actions);
      report.append(card);
    }
    if (!visible.length) report.append(element("p", "No findings in this view.", "muted"));
    if (visible.length > perPage) {
      const pager = element("div", undefined, "review-actions");
      const back = button("Previous", () => { page--; render(); }, "ghost small-btn");
      const next = button("Next", () => { page++; render(); }, "ghost small-btn");
      back.disabled = page === 0;
      next.disabled = (page + 1) * perPage >= visible.length;
      pager.append(back, element("span", `Page ${page + 1} of ${Math.ceil(visible.length / perPage)}`, "small"), next);
      report.append(pager);
    }
  }

  async function perform(message, action) {
    notice.textContent = message;
    report.inert = true;
    for (const control of controls.querySelectorAll("button")) control.disabled = true;
    try {
      await action();
      render();
      notice.textContent = "";
    } catch (error) {
      notice.textContent = error.message;
    } finally {
      report.inert = false;
      for (const control of controls.querySelectorAll("button")) control.disabled = false;
    }
  }

  await perform("Loading saved assessment…", async () => {
    const [rules, saved] = await Promise.all([request("rules"), request("analysis", { id })]);
    assessment = saved;
    function start(layers) {
      return perform("Running assessment…", async () => {
        assessment = await request("analyze", {}, { id, layers });
        page = 0;
      });
    }
    controls.append(button("Run layers 1–2", () => start([1, 2]), "primary"));
    if (rules.layer3_provider === "none") {
      controls.append(element("span", "Layer 3 requires a configured AI provider.", "muted small"));
    } else {
      controls.append(button("Run all three layers", () => start([1, 2, 3])));
    }
  });
}

async function showCatalogue() {
  const { id, title } = state.bom.version;
  const body = drawer(title, "Catalogue analytics");
  const panel = element("section", undefined, "review-panel");
  const notice = element("p", "Loading catalogue links…");
  notice.setAttribute("role", "status");
  panel.append(notice);
  body.append(panel);
  try {
    const data = await request("catalogue", { id });
    notice.textContent = `${integer.format(data.matched_positions)} of ${integer.format(data.positions)} positions linked to the catalogue`;
    if (!data.groups.length) panel.append(element("p", "This bill has no linked catalogue products.", "muted"));
    for (const group of data.groups) {
      const card = element("article", undefined, "note-card");
      const link = element("a", group.product);
      link.href = `/admin/tables?table=product&where=${encodeURIComponent(JSON.stringify({ id: group.product_id }))}`;
      const heading = element("h3");
      heading.append(link);
      card.append(heading, element("p", `${group.category} · ${group.scope === "supply" ? "Supply" : "Installed work"}`, "muted small"));
      card.append(element("p", group.included_quantity == null ? "No measurable included quantity" : `Included quantity · ${group.included_quantity} ${group.unit}`));
      if (group.excluded_positions || group.unquantified_included) card.append(element("p",
        `${group.excluded_positions} excluded or lump-sum · ${group.unquantified_included} included with unknown quantity or unit`, "small"));
      const positions = element("details");
      positions.append(element("summary", `${group.positions.length} source positions`),
        element("p", group.positions.map(position => position.code || "(unnumbered)").join(", ")));
      card.append(positions);
      panel.append(card);
    }
  } catch (error) {
    notice.textContent = error.message;
  }
}

/* ---------- Events ---------- */

$("project").addEventListener("change", () => {
  if (!mayLeave()) {
    $("project").value = state.workspace.project.id;
    return;
  }
  run(async () => {
    await loadWorkspace($("project").value);
    closeDraft();
    setUploadNote("");
  });
});
$("create-project").addEventListener("click", () => {
  if (!mayLeave()) return;
  const body = drawer("Workspace", "New project", true);
  const form = element("form", undefined, "form");
  const name = element("input");
  name.required = true;
  name.maxLength = 160;
  name.placeholder = "e.g. Kanalsanierung Nordstraße";
  const actions = element("div", undefined, "actions");
  const submit = element("button", "Create project", "primary");
  submit.type = "submit";
  actions.append(submit, button("Cancel", () => $("drawer").close()));
  form.append(labelled("Project name", name), actions);
  form.addEventListener("submit", event => {
    event.preventDefault();
    $("drawer").close();
    run(async () => {
      const project = await request("project", {}, { name: name.value });
      await loadWorkspace(project.id);
      closeDraft();
    });
  });
  body.append(form);
  name.focus();
});
$("home-link").addEventListener("click", event => {
  event.preventDefault();
  if (state.bom && mayLeave()) closeDraft();
});
$("back").addEventListener("click", () => { if (mayLeave()) closeDraft(); });
$("review-step").previousElementSibling.addEventListener("click", () => { if (mayLeave()) closeDraft(); });
$("pick-file").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", () => upload(() => $("file").files[0]));
$("dropzone").addEventListener("dragover", event => {
  event.preventDefault();
  $("dropzone").classList.add("dragging");
});
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging"));
$("dropzone").addEventListener("drop", event => {
  event.preventDefault();
  $("dropzone").classList.remove("dragging");
  const file = event.dataTransfer.files[0];
  upload(() => file);
});
$("sample").addEventListener("click", () => run(async () => {
  const project = sampleProject();
  if (project.id !== state.workspace.project.id) await loadWorkspace(project.id);
  const doc = state.workspace.documents.find(source => source.filename === SAMPLE_FILE);
  if (!doc) throw new Error("The sample tender is missing. Choose a file to upload instead.");
  await openSource(doc.id, doc.boq_indexes[0] || null);
}));
$("scope").addEventListener("click", () => drawer(state.bom.version.title, "Scope notes").append(
  element("p", state.bom.version.scope_notes, "doc-notes")
));
$("save").addEventListener("click", saveDraft);
$("discard").addEventListener("click", () => {
  if (!confirm("Discard all unsaved changes?")) return;
  state.changes.clear();
  drawLines();
});
$("export").addEventListener("click", showExports);
$("risk").addEventListener("click", showRisk);
$("catalogue").addEventListener("click", showCatalogue);
$("search").addEventListener("input", () => { state.page = 1; drawLines(); });
$("section").addEventListener("change", () => { state.page = 1; drawLines(); });
$("previous").addEventListener("click", () => { state.page -= 1; drawLines(); });
$("next").addEventListener("click", () => { state.page += 1; drawLines(); });
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && state.bom) {
    event.preventDefault();
    saveDraft();
  }
});
window.addEventListener("beforeunload", event => {
  if (state.changes.size) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("popstate", () => {
  const id = new URLSearchParams(location.search).get("bom");
  if (id && id !== state.bom?.version.id) run(() => openDraft(id));
  else if (!id && state.bom) {
    state.bom = null;
    state.changes.clear();
    updateActions();
    $("welcome").hidden = false;
    $("review").hidden = true;
    drawHome();
  }
});
run(async () => {
  await loadWorkspace();
  const params = new URLSearchParams(location.search);
  const currentDraft = params.get("bom");
  if (currentDraft) await openDraft(currentDraft);
  else if (params.has("source")) await showLibrarySource(params.get("source"));
});
