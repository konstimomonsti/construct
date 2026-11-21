"use strict";

const $ = id => document.getElementById(id);
const numbers = new Intl.NumberFormat("en");
const groups = {
  "Catalogue": ["product", "product_category", "supplier", "product_price", "catalogue_source_line", "reference_price"],
  "Projects and BOMs": ["project", "project_area", "bom_version", "bom_section", "bom_line", "bom_line_distribution",
    "bom_source", "material_item", "material_group", "activity_item", "activity_group"],
  "Document imports": ["source_document", "source_import", "source_extract", "source_file"],
  "Risk and pricing": ["risk_finding", "estimate", "estimate_line", "cost_component", "quote", "quote_line"],
};
const titles = {
  product: "Products", product_category: "Product categories", supplier: "Suppliers",
  product_price: "Product prices", catalogue_source_line: "Catalogue source lines", reference_price: "Reference prices",
  project: "Projects", project_area: "Project areas", bom_version: "BOM versions", bom_section: "BOM sections",
  bom_line: "BOM lines", bom_line_distribution: "BOM line distributions", bom_source: "BOM sources",
  material_item: "Materials", material_group: "Material groups", activity_item: "Activities",
  activity_group: "Activity groups", source_document: "Source documents", source_import: "Import runs",
  source_extract: "Extracted evidence", source_file: "Original files", risk_finding: "Risk findings",
  estimate: "Estimates", estimate_line: "Estimate lines", cost_component: "Cost components", quote: "Quotes",
  quote_line: "Quote lines",
};
const defaultColumns = {
  product: ["name", "category_id", "review_status", "supplier_id", "unit_code", "description"],
  product_price: ["product_id", "unit_price", "currency", "valid_from", "price_basis", "source_document_id"],
  catalogue_source_line: ["source_line_code", "product_id", "decision", "tender_unit", "rate_amount",
    "rate_currency", "source_document_id"],
  source_document: ["filename", "format", "exchange_phase", "import_status", "project_id"],
  source_extract: ["ordinal", "kind", "import_id", "locator", "payload"],
  source_file: ["source_document_id", "content", "sha256"],
};
const columnLabels = {
  name: "Name", category_id: "Category", supplier_id: "Supplier", product_id: "Product",
  review_status: "Review status", unit_code: "Unit", description: "Description", source_document_id: "Source document",
  unit_price: "Unit price", valid_from: "Date", price_basis: "Price basis", source_line_code: "Position",
  rate_amount: "Observed rate", rate_currency: "Rate currency", tender_unit: "Tender unit", filename: "Filename",
  content: "File size", sha256: "SHA-256",
};
const state = {
  tables: new Map(), table: null, filters: {}, visible: new Map(),
  page: 1, size: 25, sort: "", direction: "asc", result: null, rowRequest: null,
};
let searchDelay;
let inspectorVersion = 0;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function title(name) {
  return titles[name] || name.replaceAll("_", " ");
}

function groupName(name) {
  return Object.keys(groups).find(group => groups[group].includes(name)) || "Other tables";
}

function columnLabel(name) {
  return columnLabels[name] || name.replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
}

async function api(path, params = {}, signal) {
  const query = new URLSearchParams(params);
  const response = await fetch(`/api/${path}?${query}`, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The database request failed.");
  return data;
}

function connection(online) {
  $("connection-dot").className = `connection-dot ${online ? "online" : "offline"}`;
  $("connection-label").textContent = online ? "PostgreSQL · Read only" : "Database unavailable";
}

function drawSidebar() {
  const query = $("table-search").value.trim().toLowerCase();
  const sections = { ...groups, "Other tables": [...state.tables.keys()].filter(name => groupName(name) === "Other tables") };
  const list = $("table-list");
  list.replaceChildren();
  let visible = 0;
  for (const [label, names] of Object.entries(sections)) {
    const matches = names.filter(name => state.tables.has(name) &&
      `${name} ${title(name)}`.toLowerCase().includes(query));
    if (!matches.length) continue;
    visible += matches.length;
    const section = element("section");
    section.append(element("h3", "", label));
    for (const name of matches) {
      const item = element("button", "table-option");
      item.type = "button";
      item.title = `public.${name}`;
      if (name === state.table?.name) item.setAttribute("aria-current", "true");
      const icon = element("span", "table-icon");
      icon.setAttribute("aria-hidden", "true");
      const count = state.tables.get(name).row_count;
      item.append(icon, element("span", "table-label", title(name)), element("span", "badge-number", numbers.format(count)));
      item.addEventListener("click", () => selectTable(name));
      section.append(item);
    }
    list.append(section);
  }
  $("table-count").textContent = query ? `${visible} of ${state.tables.size}` : state.tables.size;
  if (!visible) list.append(element("p", "nav-empty", "No matching tables."));
}

function reverseRelations(table) {
  return [...state.tables.values()].flatMap(source => source.relations
    .filter(ref => ref.target === table.name)
    .map(ref => ({ ...ref, source: source.name })));
}

function drawHeading() {
  const table = state.table;
  $("table-group").textContent = groupName(table.name);
  $("table-title").textContent = title(table.name);
  $("table-name").textContent = `public.${table.name}`;
  const count = table.row_count;
  $("table-summary").textContent = `${numbers.format(count)} ${count === 1 ? "record" : "records"}`;
  $("relationship-count").textContent = table.relations.length + reverseRelations(table).length;
  $("product-status").hidden = table.name !== "product";
}

function drawColumnOptions() {
  const fields = $("column-options");
  const selected = state.visible.get(state.table.name);
  fields.replaceChildren(element("legend", "", "Visible columns"));
  for (const column of state.table.columns) {
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.includes(column.name);
    checkbox.disabled = checkbox.checked && selected.length === 1;
    const label = element("label");
    label.title = column.name;
    label.append(checkbox, document.createTextNode(columnLabel(column.name)));
    checkbox.addEventListener("change", () => {
      const index = selected.indexOf(column.name);
      if (checkbox.checked) selected.push(column.name);
      else selected.splice(index, 1);
      drawColumnOptions();
      if (state.result) drawRows();
      [...fields.querySelectorAll("input")][state.table.columns.indexOf(column)].focus();
    });
    fields.append(label);
  }
  $("visible-column-count").textContent = `${selected.length}/${state.table.columns.length}`;
}

function filterDescription() {
  const bar = $("relationship-filter");
  const parts = Object.entries(state.filters).map(([name, value]) => `${columnLabel(name)} = ${value ?? "NULL"}`);
  bar.hidden = !parts.length;
  bar.replaceChildren();
  if (!parts.length) return;
  const clear = element("button", "button", "Clear filter");
  clear.type = "button";
  clear.addEventListener("click", () => selectTable(state.table.name));
  bar.append(element("span", "", parts.join(" · ")), clear);
}

function selectTable(name, where = {}, updateUrl = true) {
  const table = state.tables.get(name);
  if (!table) return;
  clearTimeout(searchDelay);
  state.table = table;
  state.filters = where;
  state.page = 1;
  state.sort = "";
  state.direction = "asc";
  state.result = null;
  $("row-search").value = "";
  $("product-status").value = "";
  $("column-picker").open = false;
  $("table-view").hidden = false;
  if (!state.visible.has(name)) {
    state.visible.set(name, (defaultColumns[name] || table.columns.map(col => col.name)).filter(
      column => table.columns.some(col => col.name === column)
    ));
  }
  if (updateUrl) {
    const query = new URLSearchParams({ table: name });
    if (Object.keys(where).length) query.set("where", JSON.stringify(where));
    history.pushState(null, "", `?${query}`);
  }
  drawHeading();
  drawSidebar();
  drawColumnOptions();
  filterDescription();
  $("rows-region").scrollLeft = 0;
  loadRows();
}

function locationTable() {
  const url = new URLSearchParams(location.search);
  const name = url.get("table");
  const fallback = state.tables.has("product") ? "product" : state.tables.keys().next().value;
  let where = {};
  if (state.tables.has(name) && url.has("where")) {
    try {
      const value = JSON.parse(url.get("where"));
      if (value && typeof value === "object" && !Array.isArray(value)) where = value;
    } catch {
      // A malformed URL still opens its table.
    }
  }
  selectTable(state.tables.has(name) ? name : fallback, where, false);
}

async function loadTables() {
  $("connection-error").hidden = true;
  try {
    const { tables } = await api("tables");
    state.tables = new Map(tables.map(table => [table.name, table]));
    connection(true);
    if (!tables.length) {
      $("table-view").hidden = true;
      $("table-list").replaceChildren(element("p", "nav-empty", "No tables found."));
      $("table-count").textContent = "0";
    } else if (state.table && state.tables.has(state.table.name)) {
      state.table = state.tables.get(state.table.name);
      const available = state.table.columns.map(column => column.name);
      const visible = state.visible.get(state.table.name).filter(name => available.includes(name));
      state.visible.set(state.table.name, visible.length ? visible : available);
      if (!available.includes(state.sort)) state.sort = "";
      $("table-view").hidden = false;
      drawSidebar();
      drawHeading();
      drawColumnOptions();
      await loadRows();
    } else {
      locationTable();
    }
  } catch (error) {
    connection(false);
    $("table-view").hidden = true;
    $("connection-error").hidden = false;
    $("connection-error-text").textContent = error.message;
  }
}

function pagination(data) {
  const current = data?.page || 1;
  const pages = data?.pages || 1;
  const total = data?.total || 0;
  const start = ((current - 1) * state.size) + 1;
  const end = start + (data?.rows.length || 0) - 1;
  $("row-count").textContent = total
    ? `${start === end ? numbers.format(start) : `${numbers.format(start)}–${numbers.format(end)}`} of ${numbers.format(total)} ${total === 1 ? "record" : "records"}`
    : data ? "0 records" : "";
  $("page-indicator").textContent = total ? `Page ${numbers.format(current)} of ${numbers.format(pages)}` : "";
  $("previous").disabled = !data || current <= 1;
  $("next").disabled = !data || current >= pages;
}

function rowsMessage(heading, detail = "") {
  $("records-table").hidden = true;
  const message = $("rows-message");
  message.hidden = false;
  message.replaceChildren(element("h3", "", heading));
  if (detail) message.append(element("p", "", detail));
}

async function loadRows() {
  state.rowRequest?.abort();
  const request = new AbortController();
  state.rowRequest = request;
  const where = { ...state.filters };
  const status = $("product-status").value;
  if (state.table.name === "product" && status) where.review_status = status;
  const q = $("row-search").value.trim();
  const params = {
    table: state.table.name, page: state.page, size: state.size, q,
    sort: state.sort, direction: state.direction, where: JSON.stringify(where),
  };
  state.result = null;
  $("rows-region").setAttribute("aria-busy", "true");
  pagination(null);
  rowsMessage("Loading records…");
  try {
    const data = await api("rows", params, request.signal);
    if (request.signal.aborted) return;
    state.result = data;
    state.page = data.page;
    state.sort = data.sort;
    state.direction = data.direction;
    if (data.rows.length) drawRows();
    else if (q || Object.keys(where).length) rowsMessage("No matching records", "Try another search or clear the filter.");
    else rowsMessage("This table is empty");
    pagination(data);
  } catch (error) {
    if (request.signal.aborted) return;
    state.result = null;
    rowsMessage("Couldn’t load records", error.message);
  } finally {
    if (!request.signal.aborted) $("rows-region").setAttribute("aria-busy", "false");
  }
}

function displayValue(name, type, value) {
  if (value === null) return "—";
  if (type === "bytea") return `${numbers.format(Number(value))} bytes`;
  if (name.endsWith("status") || name === "status" || name === "price_basis") {
    return value.replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
  }
  return value;
}

function follow(table, columns, values) {
  const filter = Object.fromEntries(columns.map((col, index) => [col, values[index]]));
  if ($("inspector").open) $("inspector").close();
  selectTable(table, filter);
}

function valueNode(table, column, values, labels, compact) {
  const value = values[column.name];
  if (value === null) {
    const blank = element("span", "empty-value", compact ? "—" : "NULL");
    blank.title = "NULL";
    return blank;
  }
  const candidates = table.relations.filter(ref => ref.columns.includes(column.name) &&
    ref.columns.every(name => values[name] !== null));
  const relation = candidates.find(ref => ref.columns.length === 1) || candidates[0];
  if (relation) {
    const label = labels[column.name]?.[value];
    const visible = label || (compact && column.type === "uuid" ? `${value.slice(0, 8)}…` : value);
    const link = element("button", "foreign-value", visible);
    link.type = "button";
    link.title = `View ${relation.target} · ${value}`;
    link.addEventListener("click", () => follow(relation.target, relation.target_columns,
      relation.columns.map(name => values[name])));
    return link;
  }
  if (!compact && (column.type === "jsonb" || column.type === "json")) return element("pre", "", value);
  const text = displayValue(column.name, column.type, value);
  if (compact && (column.name.endsWith("_status") || column.name === "status")) {
    const badge = element("span", "status", text);
    if (/^[a-z_]+$/.test(value)) badge.classList.add(`is-${value}`);
    return badge;
  }
  const node = element("span", compact ? "value-text" : "", text);
  if (compact) node.title = text;
  return node;
}

function drawRows() {
  const table = state.table;
  const data = state.result;
  if (!data?.rows.length) return;
  const columns = state.visible.get(table.name).map(name => table.columns.find(column => column.name === name));
  const head = element("tr");
  const rowHeader = element("th", "row-action", "Row");
  rowHeader.scope = "col";
  head.append(rowHeader);
  for (const column of columns) {
    const cell = element("th");
    cell.scope = "col";
    const active = column.name === state.sort;
    if (active) cell.setAttribute("aria-sort", state.direction === "asc" ? "ascending" : "descending");
    const button = element("button", "column-head", columnLabel(column.name));
    button.type = "button";
    button.title = `Sort by ${column.name}`;
    if (active) {
      const marker = element("span", "sort-glyph", state.direction === "asc" ? "▴" : "▾");
      marker.setAttribute("aria-hidden", "true");
      button.append(marker);
    }
    button.addEventListener("click", () => {
      state.direction = active && state.direction === "asc" ? "desc" : "asc";
      state.sort = column.name;
      state.page = 1;
      loadRows();
    });
    cell.append(button);
    head.append(cell);
  }
  $("table-header").replaceChildren(head);
  const body = document.createDocumentFragment();
  for (const row of data.rows) {
    const tr = element("tr");
    const action = element("td", "row-action");
    const open = element("button", "row-open", "Open");
    open.type = "button";
    open.setAttribute("aria-label", `Open ${recordTitle(table, row.values)}`);
    open.addEventListener("click", () => openRecord(table, row, data.labels));
    action.append(open);
    tr.append(action);
    for (const column of columns) {
      const cell = element("td", "data-cell");
      if (["name", "filename", "title", "short_description"].includes(column.name)) cell.classList.add("is-name");
      if (["description", "long_description", "metadata", "payload"].includes(column.name)) cell.classList.add("is-details");
      cell.append(valueNode(table, column, row.values, data.labels, true));
      tr.append(cell);
    }
    body.append(tr);
  }
  $("table-body").replaceChildren(body);
  $("rows-message").hidden = true;
  $("records-table").hidden = false;
}

function openInspector(context, heading) {
  $("inspector-context").textContent = context;
  $("inspector-title").textContent = heading;
  const body = $("inspector-body");
  body.replaceChildren();
  if (!$("inspector").open) $("inspector").showModal();
  $("inspector").scrollTop = 0;
  return body;
}

function recordTitle(table, values) {
  return values.name || values.filename || values.title || values.source_line_code || values.line_code ||
    values.quote_number || values.ordinal || `${title(table.name)} record`;
}

function relationButton(name, description, action) {
  const button = element("button", "relation");
  button.type = "button";
  button.append(element("strong", "", name), element("small", "", description));
  button.addEventListener("click", action);
  return button;
}

function relationshipList(table, body, values = null) {
  for (const direction of [
    { label: "References", items: table.relations, incoming: false },
    { label: "Referenced by", items: reverseRelations(table), incoming: true },
  ]) {
    const eligible = direction.items.filter(ref => !values || (direction.incoming ? ref.target_columns : ref.columns)
      .every(column => values[column] !== null && values[column] !== undefined));
    if (!eligible.length) continue;
    body.append(element("h3", "", direction.label));
    for (const ref of eligible) {
      const target = direction.incoming ? ref.source : ref.target;
      const from = direction.incoming ? ref.target_columns : ref.columns;
      const to = direction.incoming ? ref.columns : ref.target_columns;
      const description = `${from.join(", ")} · ${target}.${to.join(", ")}`;
      body.append(relationButton(title(target), description, () => {
        if (values) follow(target, to, from.map(column => values[column]));
        else {
          $("inspector").close();
          selectTable(target);
        }
      }));
    }
  }
}

function renderRecord(body, table, row, labels) {
  const fields = element("dl", "fields");
  for (const column of table.columns) {
    const field = element("div", "field");
    const term = element("dt", "", column.name);
    const key = table.primary_key.includes(column.name) ? " · primary key" : "";
    term.append(element("span", "", `${column.type}${key}`));
    const value = element("dd");
    value.append(valueNode(table, column, row.values, labels, false));
    if (row.clipped.includes(column.name)) value.append(element("span", "clip-note", "Showing the start of a large value."));
    field.append(term, value);
    fields.append(field);
  }
  const links = element("div", "record-links");
  relationshipList(table, links, row.values);
  body.replaceChildren(fields, links);
}

async function openRecord(table, row, labels) {
  const body = openInspector(`public.${table.name}`, recordTitle(table, row.values));
  const version = ++inspectorVersion;
  renderRecord(body, table, row, labels);
  if (!table.primary_key.length) return;
  const filter = Object.fromEntries(table.primary_key.map(name => [name, row.values[name]]));
  try {
    const result = await api("record", { table: table.name, where: JSON.stringify(filter) });
    if (version !== inspectorVersion || !$("inspector").open) return;
    if (result.rows.length) renderRecord(body, table, result.rows[0], result.labels);
    else body.prepend(element("p", "clip-note", "This record is no longer in the table."));
  } catch (error) {
    if (version === inspectorVersion && $("inspector").open) body.prepend(element("p", "clip-note", error.message));
  }
}

$("inspector").addEventListener("close", () => { inspectorVersion += 1; });
$("table-search").addEventListener("input", drawSidebar);
$("row-search").addEventListener("input", () => {
  clearTimeout(searchDelay);
  searchDelay = setTimeout(() => {
    state.page = 1;
    loadRows();
  }, 220);
});
$("product-status").addEventListener("change", () => {
  state.page = 1;
  loadRows();
});
$("page-size").addEventListener("change", event => {
  state.size = Number(event.target.value);
  state.page = 1;
  loadRows();
});
$("previous").addEventListener("click", () => {
  state.page -= 1;
  loadRows();
});
$("next").addEventListener("click", () => {
  state.page += 1;
  loadRows();
});
$("relationships").addEventListener("click", () => {
  const body = openInspector(`public.${state.table.name}`, "Relationships");
  relationshipList(state.table, body);
  if (!body.childElementCount) body.append(element("p", "subtle", "This table has no foreign-key relationships."));
});
$("refresh").addEventListener("click", loadTables);
$("retry").addEventListener("click", loadTables);
window.addEventListener("popstate", locationTable);
loadTables();
