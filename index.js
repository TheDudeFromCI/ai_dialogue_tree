import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";

const NODE_HEIGHT = 200;
const NODE_WIDTH = 300;
const NODE_H_MARGIN = 20;
const NODE_V_MARGIN = 75;
const NODE_PADDING = 18; // padding top/bottom + border top/bottom
const SVG_PADDING = 2;
const TICKER_SPEED = 200;

const TICKER_VALUES = [
  ".....",
  "o....",
  "Oo...",
  "oOo..",
  ".oOo.",
  "..oOo",
  "...oO",
  "....o",
];

const socket = io();
let tree = {};
let characters = {};
let containers = {};
let timers = {};

socket.on("load", (data) => {
  characters = data.characters;
  tree = data.tree;

  recalculateVirtualSizes();
  recalculatePositions();
  rebuildAllNodes();
});

socket.on("regen_complete", (data) => {
  const nid = data.nid;
  const newText = data.text;
  finishRegenNode(nid, newText);
});

function getRoot() {
  return Object.values(tree).find((n) => n.parent == null);
}

function recalculateVirtualSizes(node) {
  if (node === undefined) node = getRoot();

  let childSize = (node.children.length - 1) * NODE_H_MARGIN;
  for (const cid of node.children) {
    let child = tree[cid];
    childSize += recalculateVirtualSizes(child);
  }

  node.size = Math.max(childSize, NODE_WIDTH);
  return node.size;
}

function recalculatePositions(node) {
  if (node === undefined) node = getRoot();

  if (node.parent == null) {
    node.x = document.documentElement.clientWidth / 2 - NODE_WIDTH / 2;
    node.y = 20;

    if (node.x - node.size / 2 < 0) node.x = node.size / 2 - NODE_WIDTH / 2;
  }

  let posX = node.x - node.size / 2;
  let posY = node.y + NODE_HEIGHT + NODE_V_MARGIN;

  for (const cid of node.children) {
    let child = tree[cid];
    child.x = posX + child.size / 2;
    child.y = posY;
    recalculatePositions(child);

    posX += child.size + NODE_H_MARGIN;
  }

  if (node.parent == null) {
    node.x -= NODE_WIDTH / 2;
  }

  if (containers[node.nid]?.line) {
    containers[node.nid]["line"].remove();
    delete containers[node.nid]["line"];
    buildNodeLine(node, tree[node.parent]);
  }

  if (containers[node.nid]?.div) {
    containers[node.nid]["div"].style.left = node.x + "px";
    containers[node.nid]["div"].style.top = node.y + "px";
  }
}

function rebuildAllNodes() {
  document.querySelectorAll(".node").forEach((n) => n.remove());
  document.querySelectorAll("svg").forEach((n) => n.remove());
  Object.values(timers).forEach((t) => clearInterval(t));
  containers = {};
  timers = {};

  for (const nid in tree) buildNode(tree[nid]);
}

function getColor(node) {
  return characters[node.sender]?.color ?? "#000000";
}

function buildNode(node) {
  containers[node.nid] = {};

  if (node.parent != null) buildNodeLine(node, tree[node.parent]);

  let div = buildNodeDiv(node);
  let sender = buildNodeSender(node);
  let textarea = buildNodeTextarea(node);
  let textDisplay = buildNodeTextDisplay(node);
  div.append(sender, textarea, textDisplay);

  const buttons = document.createElement("div");
  buttons.className = "buttons";
  div.append(buttons);

  if (node.parent == null) {
    const child = btn("Child", () => createNode(node.nid));
    const regen = btn("Regen", () => regenNode(node.nid, false));
    containers[node.nid]["childButton"] = child;
    containers[node.nid]["regenButton"] = regen;
    buttons.append(child, regen);
  } else {
    const child = btn("Child", () => createNode(node.nid));
    const del = btn("Delete", () => deleteNode(node.nid));
    const clone = btn("Clone", () => cloneNode(node.nid));
    const regen = btn("Regen", () => regenNode(node.nid, false));
    const regenCont = btn("Continue", () => regenNode(node.nid, true));
    containers[node.nid]["childButton"] = child;
    containers[node.nid]["deleteButton"] = del;
    containers[node.nid]["cloneButton"] = clone;
    containers[node.nid]["regenButton"] = regen;
    containers[node.nid]["regenContButton"] = regenCont;
    buttons.append(clone, del, child, regen, regenCont);
  }
}

function buildNodeLine(child, parent) {
  if (!child || !parent) {
    console.warn("Cannot build line, missing child or parent");
    return;
  }

  let nodeWidth = parent.parent == null ? NODE_WIDTH * 2 : NODE_WIDTH;
  let nSiblings = parent.children.length;
  let childIndex = parent.children.findIndex((id) => id == child.nid);
  let offset = (nodeWidth / (nSiblings + 1)) * (childIndex + 1);

  let x1 = parent.x + offset;
  let y1 = parent.y + NODE_HEIGHT + NODE_PADDING;
  let x2 = child.x + NODE_WIDTH / 2;
  let y2 = child.y;

  let width = Math.max(x1, x2) - Math.min(x1, x2) + SVG_PADDING * 2;
  let height = y2 - y1 + SVG_PADDING * 2;
  let left = Math.min(x1, x2) - SVG_PADDING;
  let top = y1 - SVG_PADDING;

  x1 -= left;
  x2 -= left;
  y1 -= top;
  y2 -= top;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("style", `left: ${left}px; top: ${top}px`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttributeNS(
    "http://www.w3.org/2000/xmlns/",
    "xmlns:xlink",
    "http://www.w3.org/1999/xlink"
  );

  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttributeNS(
    null,
    "d",
    `M ${x1} ${y1} C ${x1} ${y2}, ${x2} ${y1}, ${x2} ${y2}`
  );
  line.setAttribute("stroke", "#bbbbbb");
  line.setAttribute("stroke-width", 3);
  line.setAttribute("fill", "transparent");
  svg.appendChild(line);

  document.body.appendChild(svg);
  containers[child.nid]["line"] = svg;
}

function buildNodeDiv(node) {
  const div = document.createElement("div");
  containers[node.nid]["div"] = div;

  if (node.parent == null) div.className = "node root";
  else div.className = "node";

  div.style.left = node.x + "px";
  div.style.top = node.y + "px";
  div.style["border-color"] = getColor(node);
  document.body.appendChild(div);
  return div;
}

function buildNodeSender(node) {
  const sender = document.createElement("select");
  containers[node.nid]["sender"] = sender;

  sender.innerHTML = Object.keys(characters)
    .map((name) => `<option value="${name}">${name}</option>`)
    .join();
  sender.value = node["sender"];

  sender.onchange = () => {
    node.sender = sender.value;
    sendEditNode(node.nid);

    containers[node.nid]["div"].style["border-color"] = getColor(node);

    if (containers[node.nid]["textDisplay"]) {
      let textDisplayClass = "textdisplay show";
      if (containers[node.nid]["sender"].value == "System")
        textDisplayClass += " system";
      containers[node.nid]["textDisplay"].className = textDisplayClass;
    }
  };

  return sender;
}

function buildNodeTextarea(node) {
  const text = document.createElement("textarea");
  text.value = node.text;
  containers[node.nid]["text"] = text;

  if (node.parent == null) text.className = "show";
  else text.className = "hide";

  text.onchange = () => {
    node.text = text.value;
    containers[node.nid]["textDisplay"].innerHTML = marked.parse(text.value);
    sendEditNode(node.nid);
  };

  text.addEventListener("blur", () => {
    if (node.parent == null) return;

    text.className = "hide";

    let textDisplayClass = "textdisplay show";
    if (containers[node.nid]["sender"].value == "System")
      textDisplayClass += " system";
    containers[node.nid]["textDisplay"].className = textDisplayClass;
  });

  return text;
}

function buildNodeTextDisplay(node) {
  const textDisplay = document.createElement("div");
  containers[node.nid]["textDisplay"] = textDisplay;

  textDisplay.className = "textdisplay";
  textDisplay.contenteditable = true;
  textDisplay.innerHTML = marked.parse(node.text);

  let textDisplayClass = "textdisplay show";
  if (containers[node.nid]["sender"].value == "System")
    textDisplayClass += " system";

  if (node.parent == null) textDisplay.className = "hide";
  else textDisplay.className = textDisplayClass;

  textDisplay.addEventListener("click", () => {
    if (node.parent == null) return;
    if (timers[node.nid]) return;

    textDisplay.className = "hide";
    containers[node.nid]["text"].className = "show";
    containers[node.nid]["text"].focus();
  });

  return textDisplay;
}

function btn(label, fn) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = fn;
  return b;
}

function sendEditNode(nid) {
  socket.emit("edit_node", tree[nid]);
}

function sendDeleteNode(nid) {
  socket.emit("delete_node", { nid: nid });
}

function sendRegenNode(nid, extend) {
  socket.emit("regen_node", {
    nid: nid,
    extend: extend,
  });
}

function createNode(parentNid) {
  let grandparentNode = tree[parentNid].parent;
  let grandparentSender = grandparentNode
    ? tree[grandparentNode].sender
    : "System";

  const nid = crypto.randomUUID();
  tree[nid] = {
    nid: nid,
    parent: parentNid,
    sender: grandparentSender,
    text: "",
    children: [],
  };
  containers[nid] = {};
  tree[parentNid].children.push(nid);

  buildNode(tree[nid]);
  sendEditNode(nid);
  sendEditNode(parentNid);

  recalculateVirtualSizes();
  recalculatePositions();
}

function deleteNode(nid) {
  let parent = tree[tree[nid].parent];
  if (parent) {
    let childIndex = parent.children.findIndex((id) => id == nid);
    parent.children.splice(childIndex, 1);
    sendEditNode(parent.nid);
  }

  function deleteRecursive(nid) {
    for (const cid of tree[nid]?.children ?? []) {
      deleteRecursive(cid);
    }

    delete tree[nid];
    sendDeleteNode(nid);

    containers[nid]?.["div"]?.remove();
    containers[nid]?.["line"]?.remove();
    delete containers[nid];
  }

  deleteRecursive(nid);
  recalculateVirtualSizes();
  recalculatePositions();
}

function cloneNode(oldNid) {
  let oldNode = tree[oldNid];

  const nid = crypto.randomUUID();
  tree[nid] = {
    nid: nid,
    parent: oldNode.parent,
    sender: oldNode.sender,
    text: oldNode.text,
    children: [],
  };
  containers[nid] = {};
  tree[oldNode.parent].children.push(nid);

  buildNode(tree[nid]);
  sendEditNode(nid);
  sendEditNode(oldNode.parent);

  recalculateVirtualSizes();
  recalculatePositions();
}

function regenNode(nid, extend) {
  if (timers[nid]) return;

  for (const elemName in containers[nid]) {
    containers[nid][elemName].disabled = true;
  }

  let ticker = 0;
  timers[nid] = setInterval(() => {
    const textAnim = TICKER_VALUES[ticker];
    const html = `<p class="ticker">${textAnim}</p>`;
    containers[nid]["textDisplay"].innerHTML = html;
    ticker = (ticker + 1) % TICKER_VALUES.length;
  }, TICKER_SPEED);

  sendRegenNode(nid, extend);
}

function finishRegenNode(nid, newText) {
  clearInterval(timers[nid]);
  delete timers[nid];

  tree[nid].text = newText;
  containers[nid]["text"].value = newText;
  containers[nid]["textDisplay"].innerHTML = marked.parse(newText);

  for (const elemName in containers[nid]) {
    containers[nid][elemName].disabled = false;
  }
}
